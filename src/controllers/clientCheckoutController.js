/**
 * Client-facing (tenant-domain) checkout — Phase 16 MONEY CORE.
 *
 * These endpoints are PUBLIC (no platform auth): they run on an agency's
 * custom tenant domain and let that agency's *clients* subscribe to an
 * AgencyPlan. Money flows to the AGENCY'S connected Stripe account (Connect
 * Standard) with NO application fee — the agency keeps 100%. The platform
 * never takes a cut and this path never touches the platform credit system.
 *
 * Everything ships DARK behind the `saasMode` launch flag AND the org's
 * `custom.saasMode` entitlement. When either is off we return 404 (never
 * leak that a tenant/plan exists).
 *
 * INVARIANT I1: every tenant-facing URL is built from
 * domainService.resolveBaseUrl(orgId) so clients stay on the agency's domain.
 */

const { stripe, isConfigured, connectedAccountOptions } = require('../services/stripeService');
const flagService = require('../services/flagService');
const brandService = require('../services/brandService');
const domainService = require('../services/domainService');
const AgencyPlan = require('../models/AgencyPlan');
const ClientSubscription = require('../models/ClientSubscription');
const Organization = require('../models/Organization');

// Statuses that count as "occupying" a workspace — a workspace with a sub in
// any of these may not start a second checkout (one-active-sub-per-workspace).
const OCCUPYING_STATUSES = ['trialing', 'active', 'past_due'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve the agency org from the X-Tenant-Host header and enforce the dark
 * gate. Returns the orgId (ObjectId) when the flag is live AND the org is
 * SaaS-mode entitled, otherwise null — callers 404 on null (no leak).
 */
async function resolveGatedOrg(req) {
  const host = req.headers['x-tenant-host'];
  const orgId = await domainService.resolveOrgByHost(host);
  if (!orgId) return null;

  const [flagLive, entitled] = await Promise.all([
    flagService.isFlagLive('saasMode'),
    brandService.isSaasModeEntitled(orgId),
  ]);
  if (!flagLive || !entitled) return null;
  return orgId;
}

/**
 * GET /api/tenant/checkout-context — PUBLIC.
 * Powers the tenant checkout page: the agency's ACTIVE plans (public display
 * fields only) plus the brand-safe org/product name. 404 when not entitled.
 */
async function getCheckoutContext(req, res) {
  try {
    const orgId = await resolveGatedOrg(req);
    if (!orgId) return res.status(404).json({ error: 'Not found' });

    const [plans, { brand }] = await Promise.all([
      AgencyPlan.find({ organizationId: orgId, active: true })
        .select('name description amount currency interval trialDays')
        .lean(),
      brandService.getBrandForOrg(orgId),
    ]);

    const publicPlans = (plans || []).map((p) => ({
      id: String(p._id),
      name: p.name,
      description: p.description || '',
      amount: p.amount,
      currency: p.currency,
      interval: p.interval,
      trialDays: p.trialDays || 0,
    }));

    return res.json({ orgName: brand.productName, plans: publicPlans });
  } catch (err) {
    // 404 (not 500) so an internal error on an entitled host is indistinguishable
    // from a non-entitled/unresolved host — no existence oracle for tenants.
    console.error('[client-checkout] getCheckoutContext error:', err.message);
    return res.status(404).json({ error: 'Not found' });
  }
}

/**
 * POST /api/tenant/checkout — PUBLIC.
 * Body: { planId, workspaceId?, email }.
 * Creates a Stripe Checkout Session ON THE AGENCY'S CONNECTED ACCOUNT with NO
 * application fee / NO transfer_data (agency keeps 100%). Returns { url }.
 */
async function createClientCheckout(req, res) {
  try {
    const orgId = await resolveGatedOrg(req);
    if (!orgId) return res.status(404).json({ error: 'Not found' });

    const { planId, workspaceId, email } = req.body || {};
    // workspaceId is REQUIRED in Phase 16: a client subscription always binds
    // to an existing client workspace (self-serve auto-provisioning of a new
    // workspace from checkout is Phase 17). ClientSubscription.workspaceId is a
    // required field, so the connect webhook cannot create a sub without it.
    if (!planId || !workspaceId || !email || !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'A valid planId, workspaceId, and email are required' });
    }

    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not available right now' });
    }

    // The agency must have finished Connect onboarding (charges enabled) or
    // Stripe would reject the session — surface a clean 503 instead.
    const org = await Organization.findById(orgId).lean();
    if (!org || !org.stripeConnectAccountId || !org.connectChargesEnabled) {
      return res.status(503).json({ error: 'This agency is not ready to accept payments yet' });
    }

    const plan = await AgencyPlan.findOne({ _id: planId, organizationId: orgId, active: true }).lean();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!plan.stripePriceId) {
      return res.status(503).json({ error: 'This plan is not purchasable yet' });
    }

    // CROSS-TENANT GUARD: the workspaceId comes from an UNAUTHENTICATED request,
    // so it MUST be proven to belong to this agency org before we bind a
    // subscription to it (or the webhook would later flip its clientLocked and
    // attach billing to a workspace the agency doesn't own). This also scopes
    // the one-active-sub check below, closing the cross-tenant enumeration
    // oracle. 404 (not 403) — never reveal a foreign workspace's existence.
    const Workspace = require('../models/Workspace');
    const ownedWorkspace = await Workspace.findOne({ _id: workspaceId, organizationId: orgId })
      .select('_id')
      .lean();
    if (!ownedWorkspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // One-active-sub-per-workspace (enforced in app logic; no DB constraint —
    // a concurrent double-submit for the same fresh workspace can still create
    // two subs, a known low-risk race; the UI disables double-submit).
    const existing = await ClientSubscription.findOne({
      workspaceId,
      organizationId: orgId,
      status: { $in: OCCUPYING_STATUSES },
    }).lean();
    if (existing) {
      return res.status(409).json({ error: 'This workspace already has an active subscription' });
    }

    // Invariant I1 — tenant URLs on the agency's own domain.
    const baseUrl = await domainService.resolveBaseUrl(orgId);

    // Metadata carried on BOTH the session and the subscription so the Connect
    // webhook can wire the resulting ClientSubscription to org/plan/workspace
    // regardless of which event lands first.
    const metadata = {
      organizationId: String(orgId),
      agencyPlanId: String(plan._id),
      workspaceId: workspaceId ? String(workspaceId) : '',
    };

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        customer_email: email,
        subscription_data: {
          trial_period_days: plan.trialDays || undefined,
          metadata,
        },
        metadata,
        success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/checkout`,
        // NO application_fee_percent / NO transfer_data — agency keeps 100%.
      },
      connectedAccountOptions(org.stripeConnectAccountId)
    );

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[client-checkout] createClientCheckout error:', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

module.exports = { getCheckoutContext, createClientCheckout, resolveGatedOrg };
