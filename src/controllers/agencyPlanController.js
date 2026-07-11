/**
 * Agency plan builder (Phase 16 — SaaS/agency mode).
 *
 *   GET    /api/org/organizations/:orgId/agency-plans           list the agency's plans
 *   POST   /api/org/organizations/:orgId/agency-plans           create a plan
 *   PUT    /api/org/organizations/:orgId/agency-plans/:planId   update a plan
 *   DELETE /api/org/organizations/:orgId/agency-plans/:planId   soft-delete a plan
 *
 * A plan's Stripe Product + Price are created ON THE AGENCY'S CONNECTED ACCOUNT
 * (Connect Standard) via `connectedAccountOptions(org.stripeConnectAccountId)` —
 * never on the platform account. Clients pay the agency directly.
 *
 * PRICE IMMUTABILITY: a Stripe Price's amount/interval/currency cannot be edited.
 * When those change on updatePlan we create a NEW Price, archive the old one, and
 * repoint `stripePriceId`. Existing ClientSubscriptions keep billing on their old
 * price until they re-subscribe — we intentionally do NOT mutate live subs here.
 *
 * Owner/full-admin + `saasMode` entitlement gated; routes additionally sit behind
 * the `saasMode` launch flag (requireFeature), so this ships DARK until launch.
 */

const stripeService = require('../services/stripeService');
const brandService = require('../services/brandService');
const auditService = require('../services/auditService');
const orgMemberController = require('./orgMemberController');
const AgencyPlan = require('../models/AgencyPlan');
const ClientSubscription = require('../models/ClientSubscription');

const LIMIT_KEYS = [
  'maxArticlesPerMonth',
  'maxAiTrackerPromptsPerMonth',
  'maxKeywordLookupsPerMonth',
  'maxAuditsPerMonth',
  'creditsPerMonth',
  'maxSeats',
];
const INTERVALS = ['month', 'year'];
// Stripe-supported currencies vary; we accept a 3-letter ISO code and let
// Stripe reject truly-unsupported ones. This blocks obvious garbage locally
// (parity with the interval/amount validation) rather than round-tripping it.
const CURRENCY_RE = /^[a-z]{3}$/;

/** Shared gate: owner or org-wide admin, SaaS-mode-entitled org. */
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
  return org;
}

/** Writes require a live connected account (charges enabled). Returns true if it responded. */
function _refuseIfNotConnectReady(org, res) {
  if (!org.connectChargesEnabled) {
    res.status(409).json({ error: 'Complete Stripe Connect onboarding first' });
    return true;
  }
  return false;
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

/** Whitelist + coerce the limits object. null/absent = unlimited for that dimension. */
function _sanitizeLimits(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of LIMIT_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (v === null || v === '') {
      out[key] = null;
    } else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n);
    }
  }
  return out;
}

// ─── GET: list this agency's plans ────────────────────────────────

const listPlans = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;
    const plans = await AgencyPlan.find({ organizationId: org._id }).sort({ createdAt: -1 });
    return res.json({ plans });
  } catch (error) {
    console.error('List agency plans error:', error);
    return res.status(500).json({ error: 'Failed to load agency plans' });
  }
};

// ─── POST: create a plan (Product + recurring Price on the connected account) ──

const createPlan = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;
    if (_refuseIfNotConnectReady(org, res)) return;

    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'A plan name is required' });

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive integer (in cents)' });
    }

    const currency = (typeof body.currency === 'string' && body.currency.trim()
      ? body.currency
      : 'usd'
    ).toLowerCase();
    if (!CURRENCY_RE.test(currency)) {
      return res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
    }

    const interval = body.interval || 'month';
    if (!INTERVALS.includes(interval)) {
      return res.status(400).json({ error: "interval must be 'month' or 'year'" });
    }

    const trialDays = body.trialDays == null ? 0 : Number(body.trialDays);
    if (!Number.isInteger(trialDays) || trialDays < 0) {
      return res.status(400).json({ error: 'trialDays must be a non-negative integer' });
    }

    const description = typeof body.description === 'string' ? body.description : '';
    const limits = _sanitizeLimits(body.limits);
    const opts = stripeService.connectedAccountOptions(org.stripeConnectAccountId);

    let product;
    let price;
    try {
      product = await stripeService.stripe.products.create(
        { name, ...(description ? { description } : {}) },
        opts
      );
      price = await stripeService.stripe.prices.create(
        {
          product: product.id,
          unit_amount: amount,
          currency,
          recurring: { interval },
        },
        opts
      );
    } catch (err) {
      console.error('[agencyPlan] Stripe product/price create failed:', err.message);
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }

    const plan = await AgencyPlan.create({
      organizationId: org._id,
      name,
      description,
      amount,
      currency,
      interval,
      trialDays,
      limits,
      stripeProductId: product.id,
      stripePriceId: price.id,
      createdBy: req.user.userId,
    });

    _audit(req, org, 'billing.agency_plan_created', {
      planId: plan._id,
      name,
      amount,
      currency,
      interval,
    });
    return res.status(201).json({ plan });
  } catch (error) {
    console.error('Create agency plan error:', error);
    return res.status(500).json({ error: 'Failed to create agency plan' });
  }
};

// ─── PUT: update a plan (rotate the Stripe Price if pricing changes) ──

const updatePlan = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;
    if (_refuseIfNotConnectReady(org, res)) return;

    const plan = await AgencyPlan.findOne({
      _id: req.params.planId,
      organizationId: org._id,
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const body = req.body || {};

    // ── Freely-editable metadata ──
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return res.status(400).json({ error: 'A plan name is required' });
      plan.name = name;
    }
    if (typeof body.description === 'string') plan.description = body.description;
    if (body.limits !== undefined) {
      plan.limits = { ...(plan.limits?.toObject?.() || plan.limits), ..._sanitizeLimits(body.limits) };
    }
    if (typeof body.active === 'boolean') plan.active = body.active;

    // ── Pricing (immutable in Stripe → rotate the Price) ──
    const nextAmount = body.amount == null ? plan.amount : Number(body.amount);
    const nextInterval = body.interval == null ? plan.interval : body.interval;
    const nextCurrency = body.currency == null ? plan.currency : String(body.currency).toLowerCase();

    const pricingChanged =
      nextAmount !== plan.amount ||
      nextInterval !== plan.interval ||
      nextCurrency !== plan.currency;

    if (pricingChanged) {
      if (!Number.isInteger(nextAmount) || nextAmount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive integer (in cents)' });
      }
      if (!INTERVALS.includes(nextInterval)) {
        return res.status(400).json({ error: "interval must be 'month' or 'year'" });
      }
      if (!CURRENCY_RE.test(nextCurrency)) {
        return res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
      }

      const opts = stripeService.connectedAccountOptions(org.stripeConnectAccountId);
      let oldPriceId = plan.stripePriceId;
      try {
        const newPrice = await stripeService.stripe.prices.create(
          {
            product: plan.stripeProductId,
            unit_amount: nextAmount,
            currency: nextCurrency,
            recurring: { interval: nextInterval },
          },
          opts
        );
        plan.stripePriceId = newPrice.id;
        plan.amount = nextAmount;
        plan.interval = nextInterval;
        plan.currency = nextCurrency;
        // Persist the repoint BEFORE archiving the old price. If save fails, the
        // old price is still active and the (unsaved) plan still points to it —
        // consistent, just an orphaned unused new price. Archiving after the
        // save can never strand the plan on an archived price.
        await plan.save();
        if (oldPriceId) {
          await stripeService.stripe.prices
            .update(oldPriceId, { active: false }, opts)
            .catch((err) => console.error('[agencyPlan] old price archive failed (harmless):', err.message));
        }
      } catch (err) {
        console.error('[agencyPlan] Stripe price rotation failed:', err.message);
        return res.status(502).json({ error: `Stripe error: ${err.message}` });
      }
    } else {
      await plan.save();
    }
    _audit(req, org, 'billing.agency_plan_updated', {
      planId: plan._id,
      pricingChanged,
    });
    return res.json({ plan });
  } catch (error) {
    console.error('Update agency plan error:', error);
    return res.status(500).json({ error: 'Failed to update agency plan' });
  }
};

// ─── DELETE: soft-delete + archive the Stripe Price ───────────────

const deletePlan = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;
    if (_refuseIfNotConnectReady(org, res)) return;

    const plan = await AgencyPlan.findOne({
      _id: req.params.planId,
      organizationId: org._id,
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // Refuse while any client is live on this plan — including past_due, which
    // is still billing (Stripe mid-retry): deleting would archive the price out
    // from under a recoverable subscription.
    const liveSub = await ClientSubscription.findOne({
      organizationId: org._id,
      agencyPlanId: plan._id,
      status: { $in: ['active', 'trialing', 'past_due'] },
    });
    if (liveSub) {
      return res.status(409).json({
        error: 'Cannot delete a plan with active, trialing, or past-due client subscriptions',
      });
    }

    if (plan.stripePriceId) {
      const opts = stripeService.connectedAccountOptions(org.stripeConnectAccountId);
      try {
        await stripeService.stripe.prices.update(plan.stripePriceId, { active: false }, opts);
      } catch (err) {
        console.error('[agencyPlan] Stripe price archive failed:', err.message);
        return res.status(502).json({ error: `Stripe error: ${err.message}` });
      }
    }

    plan.active = false;
    await plan.save();

    _audit(req, org, 'billing.agency_plan_deleted', { planId: plan._id });
    return res.json({ success: true });
  } catch (error) {
    console.error('Delete agency plan error:', error);
    return res.status(500).json({ error: 'Failed to delete agency plan' });
  }
};

module.exports = { listPlans, createPlan, updatePlan, deletePlan };
