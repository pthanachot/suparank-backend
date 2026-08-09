/**
 * Stripe Connect onboarding (Phase 16 — SaaS/agency mode).
 *
 *   POST   /api/org/organizations/:orgId/connect/onboard    start/continue onboarding
 *   GET    /api/org/organizations/:orgId/connect/status     Connect account status (synced)
 *   POST   /api/org/organizations/:orgId/connect/disconnect unlink the connected account
 *
 * Connect **Standard**: the agency owns its own Stripe account (disputes, tax,
 * payouts). We never delete their account on disconnect — we only unlink locally.
 *
 * All handlers are owner/full-admin + `saasMode` entitlement gated, and additionally
 * sit behind the `saasMode` launch flag (requireFeature) at the route layer, so this
 * ships DARK until the flag flips live.
 */

const stripeService = require('../services/stripeService');
const brandService = require('../services/brandService');
const auditService = require('../services/auditService');
const orgMemberController = require('./orgMemberController');
const Organization = require('../models/Organization');
const ClientSubscription = require('../models/ClientSubscription');
const AgencyPlan = require('../models/AgencyPlan');
const User = require('../models/User');

const { appUrl } = require('../config/appUrl');

// The canonical app origin (APP_URL, else FRONTEND_URL) for Connect
// onboarding refresh/return URLs.
const APP_URL = appUrl();

/**
 * Shared gate: owner or org-wide admin, SaaS-mode-entitled org, Stripe configured.
 * Writes the error response itself and returns the org (lean) or null.
 */
async function _gate(req, res) {
  const result = await orgMemberController.resolveOrgWithAccess(req, res, true);
  if (!result) return null;
  const { org, callerRole, accessScope } = result;
  if (accessScope === 'assigned' && callerRole !== 'owner') {
    res.status(403).json({ error: 'You do not have access to billing settings' });
    return null;
  }
  if (!(await brandService.isSaasModeEntitled(org._id))) {
    res.status(403).json({
      error: 'Client billing requires the Agency plan',
      code: 'UPGRADE_REQUIRED',
    });
    return null;
  }
  if (!stripeService.isConfigured()) {
    res.status(503).json({ error: 'Stripe is not configured on this platform yet' });
    return null;
  }
  return org;
}

function _audit(req, org, action, meta) {
  auditService.record({
    organizationId: org._id,
    userId: req.user.userId,
    actorEmail: req.user.email,
    impersonatedBy: req.user?.impersonatedBy || null,
    action,
    resourceId: org._id,
    meta,
    ip: req.ip,
  });
}

// ─── POST onboard: create/continue a Standard onboarding link ─────

const startConnectOnboarding = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    try {
      let accountId = org.stripeConnectAccountId;
      if (!accountId) {
        // Bill/notify the agency OWNER, not necessarily the acting admin.
        const owner = await User.findById(org.ownerId).select('email').lean();
        const account = await stripeService.stripe.accounts.create({
          type: 'standard',
          email: owner?.email || req.user.email,
          metadata: { organizationId: String(org._id) },
        });
        // Atomic claim: adopt this account only if the org still has none, so a
        // concurrent onboarding (double-click / two tabs) can't create two
        // accounts and clobber the first. If we lost the race, keep the winner's
        // account (ours is an orphan in Stripe — logged for manual cleanup).
        const claimed = await Organization.findOneAndUpdate(
          { _id: org._id, $or: [{ stripeConnectAccountId: null }, { stripeConnectAccountId: { $exists: false } }] },
          { stripeConnectAccountId: account.id },
          { new: true }
        );
        if (claimed && claimed.stripeConnectAccountId === account.id) {
          accountId = account.id;
        } else {
          const fresh = await Organization.findById(org._id).select('stripeConnectAccountId').lean();
          accountId = (fresh && fresh.stripeConnectAccountId) || account.id;
          console.error(`[connect] onboarding race — created orphan account ${account.id}, using existing ${accountId}`);
        }
      }

      const link = await stripeService.stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${APP_URL}/settings/billing/connect?refresh=1`,
        return_url: `${APP_URL}/settings/billing/connect?done=1`,
        type: 'account_onboarding',
      });

      _audit(req, org, 'billing.connect_onboarding_started', { accountId });
      return res.json({ url: link.url });
    } catch (err) {
      console.error('[connect] onboarding link failed:', err.message);
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
  } catch (error) {
    console.error('Start connect onboarding error:', error);
    return res.status(500).json({ error: 'Failed to start Stripe Connect onboarding' });
  }
};

// ─── GET status: retrieve + sync the connected account ────────────

const getConnectStatus = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    if (!org.stripeConnectAccountId) {
      return res.json({ connected: false });
    }

    let account;
    try {
      account = await stripeService.stripe.accounts.retrieve(org.stripeConnectAccountId);
    } catch (err) {
      console.error('[connect] account retrieve failed:', err.message);
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }

    const chargesEnabled = Boolean(account.charges_enabled);
    const payoutsEnabled = Boolean(account.payouts_enabled);
    const detailsSubmitted = Boolean(account.details_submitted);

    const update = {
      connectChargesEnabled: chargesEnabled,
      connectPayoutsEnabled: payoutsEnabled,
      connectDetailsSubmitted: detailsSubmitted,
    };
    // Stamp the first time charges go live and keep it stable thereafter.
    if (chargesEnabled && !org.connectOnboardedAt) {
      update.connectOnboardedAt = new Date();
    }
    await Organization.findByIdAndUpdate(org._id, update);

    return res.json({
      connected: true,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      onboardedAt: update.connectOnboardedAt || org.connectOnboardedAt || null,
      requirements: account.requirements?.currently_due || [],
    });
  } catch (error) {
    console.error('Get connect status error:', error);
    return res.status(500).json({ error: 'Failed to load Stripe Connect status' });
  }
};

// ─── POST disconnect: unlink locally (never delete the account) ───

const disconnect = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    // Refuse if any client is mid-billing — unlinking would orphan live subs
    // (the connected account keeps charging while we've lost the routing).
    // past_due counts: Stripe is still retrying and the sub can recover.
    const liveSub = await ClientSubscription.findOne({
      organizationId: org._id,
      status: { $in: ['active', 'trialing', 'past_due'] },
    });
    if (liveSub) {
      return res.status(409).json({
        error:
          'Cannot disconnect Stripe while clients have active or trialing subscriptions. Cancel them first.',
      });
    }

    // Standard accounts belong to the agency — only unlink locally, never delete.
    await Organization.findByIdAndUpdate(org._id, {
      stripeConnectAccountId: null,
      connectChargesEnabled: false,
      connectPayoutsEnabled: false,
      connectDetailsSubmitted: false,
      connectOnboardedAt: null,
    });
    // Deactivate the agency's plans — they can't sell without a connected account.
    await AgencyPlan.updateMany({ organizationId: org._id }, { active: false });

    _audit(req, org, 'billing.connect_disconnected', {});
    return res.json({ success: true });
  } catch (error) {
    console.error('Disconnect connect error:', error);
    return res.status(500).json({ error: 'Failed to disconnect Stripe Connect' });
  }
};

module.exports = { startConnectOnboarding, getConnectStatus, disconnect };
