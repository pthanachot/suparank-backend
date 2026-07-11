/**
 * Platform-admin fleet views (Phase 19B) — read-only aggregations for the
 * platform operator (NOT an agency): the tenant list and the white-label health
 * board. Admin-gated (adminMiddleware); not saasMode-gated (a platform tool),
 * though most signals are empty until SaaS mode is live.
 */

const Organization = require('../models/Organization');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Domain = require('../models/Domain');
const BrandConfig = require('../models/BrandConfig');
const ClientSubscription = require('../models/ClientSubscription');
const { BILLED_STATUSES } = require('./workspaceQuotaService');
const { _primarySub, _monthlyCents, MRR_STATUSES } = require('./agencyConsoleService');

// Escape regex metachars so `search` is matched as a literal substring — never a
// caller-controlled pattern (avoids ReDoS / a malformed pattern 500ing the list).
function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Tenant list ────────────────────────────────────────────────

/**
 * Per-org client rollup — REUSES Part A's primary-sub collapse + MRR rules so
 * the fleet view and the per-agency console can never disagree. clientCount =
 * distinct workspaces whose primary sub has access; mrrByCurrency sums only
 * priced, MRR-eligible (paying, non-trial) primaries.
 */
function _summariseOrgClientSubs(subs, planById) {
  if (!subs.length) return { clientCount: 0, mrrByCurrency: {} };
  const byWs = new Map();
  for (const s of subs) {
    const k = String(s.workspaceId);
    if (!byWs.has(k)) byWs.set(k, []);
    byWs.get(k).push(s);
  }
  let clientCount = 0;
  const mrrByCurrency = {};
  for (const wsSubs of byWs.values()) {
    const primary = _primarySub(wsSubs);
    if (BILLED_STATUSES.includes(primary.status)) clientCount++;
    if (MRR_STATUSES.includes(primary.status)) {
      const plan = primary.agencyPlanId ? planById.get(String(primary.agencyPlanId)) : null;
      const cents = plan ? _monthlyCents(plan) : 0;
      if (cents > 0) {
        // Only positive MRR adds a currency key — identical to the console, so a
        // zero-priced plan never makes the two views disagree on key presence.
        const cur = (plan.currency || 'usd').toLowerCase();
        mrrByCurrency[cur] = (mrrByCurrency[cur] || 0) + cents;
      }
    }
  }
  return { clientCount, mrrByCurrency };
}

async function getTenantList({ page = 1, limit = 50, search = '' } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const filter = {};
  if (search) {
    const safe = _escapeRegex(search);
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { slug: { $regex: safe, $options: 'i' } },
    ];
  }

  const [orgs, total] = await Promise.all([
    Organization.find(filter)
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .select('name slug ownerId isPersonal lifecycleStatus stripeConnectAccountId connectChargesEnabled connectPayoutsEnabled createdAt')
      .lean(),
    Organization.countDocuments(filter),
  ]);

  const pagination = { page: pg, limit: lim, total, pages: Math.ceil(total / lim) };
  if (!orgs.length) return { tenants: [], pagination };

  const orgIds = orgs.map((o) => o._id);
  const ownerIds = orgs.map((o) => o.ownerId).filter(Boolean);

  const [owners, platformSubs, domains, clientSubs] = await Promise.all([
    User.find({ _id: { $in: ownerIds } }).select('email').lean(),
    Subscription.find({ organizationId: { $in: orgIds }, status: { $in: ['active', 'trialing', 'past_due'] } })
      .select('organizationId planId status').lean(),
    Domain.find({ organizationId: { $in: orgIds } }).select('organizationId status').lean(),
    // Only billed subs: clientCount/MRR count billed statuses only, so fetching
    // just those bounds memory AND yields the SAME primary-per-workspace as the
    // console (billed always wins in _primarySub). createdAt is REQUIRED — it is
    // _primarySub's tiebreak; omitting it silently disables the sort (NaN compare)
    // and could pick a different primary than the console does.
    ClientSubscription.find({ organizationId: { $in: orgIds }, status: { $in: BILLED_STATUSES } })
      .select('organizationId workspaceId agencyPlanId status createdAt').lean(),
  ]);

  const planIds = [...new Set(clientSubs.map((s) => s.agencyPlanId).filter(Boolean).map(String))];
  const plans = planIds.length
    ? await require('../models/AgencyPlan').find({ _id: { $in: planIds } }).select('amount currency interval').lean()
    : [];
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  const ownerById = new Map(owners.map((u) => [String(u._id), u]));

  // One platform sub per org, chosen DETERMINISTICALLY by status rank (so `tier`
  // never flaps between requests if an org somehow has two live subs).
  const SUB_RANK = { active: 0, trialing: 1, past_due: 2 };
  const subByOrg = new Map();
  for (const s of platformSubs) {
    const k = String(s.organizationId);
    const cur = subByOrg.get(k);
    if (!cur || (SUB_RANK[s.status] ?? 9) < (SUB_RANK[cur.status] ?? 9)) subByOrg.set(k, s);
  }

  // Domains grouped by org + coarse status bucket.
  const domByOrg = new Map();
  for (const d of domains) {
    const k = String(d.organizationId);
    const e = domByOrg.get(k) || { total: 0, active: 0, failed: 0, pending: 0 };
    e.total++;
    if (d.status === 'active') e.active++;
    else if (d.status === 'failed') e.failed++;
    else e.pending++; // pending_dns / pending_ssl / suspended
    domByOrg.set(k, e);
  }

  // Client subs grouped by org.
  const csByOrg = new Map();
  for (const s of clientSubs) {
    const k = String(s.organizationId);
    if (!csByOrg.has(k)) csByOrg.set(k, []);
    csByOrg.get(k).push(s);
  }

  const tenants = orgs.map((org) => {
    const k = String(org._id);
    const { clientCount, mrrByCurrency } = _summariseOrgClientSubs(csByOrg.get(k) || [], planById);
    const psub = subByOrg.get(k);
    return {
      id: org._id,
      name: org.name,
      slug: org.slug,
      owner: ownerById.get(String(org.ownerId))?.email || 'Unknown',
      isPersonal: !!org.isPersonal,
      lifecycleStatus: org.lifecycleStatus || 'active',
      tier: psub?.planId?.split('-')[0] || 'free',
      platformSubStatus: psub?.status || 'none',
      connect: {
        connected: !!org.stripeConnectAccountId,
        chargesEnabled: !!org.connectChargesEnabled,
        payoutsEnabled: !!org.connectPayoutsEnabled,
      },
      domains: domByOrg.get(k) || { total: 0, active: 0, failed: 0, pending: 0 },
      clientCount,
      mrrByCurrency,
      createdAt: org.createdAt,
    };
  });

  return { tenants, pagination };
}

// ─── Health board ───────────────────────────────────────────────

const HEALTH_ITEM_CAP = 100; // items returned per signal; `count` is the true total

const OFFBOARDING_STATES = ['winding_down', 'suspending', 'suspended', 'restoring', 'purging'];

/**
 * White-label health board: the platform-wide problem signals an operator needs
 * to watch. Each signal returns an EXACT `count` (countDocuments, unbounded) and
 * a capped `items` sample — so a truncated list never reads as "all clear".
 */
async function getHealthBoard() {
  const failedDomainQ = { status: 'failed' };
  const unverifiedEmailQ = {
    organizationId: { $ne: null },
    'emailDomain.domain': { $nin: [null, ''] },
    'emailDomain.status': { $ne: 'verified' },
  };
  // Only genuine dunning (past_due) — 'incomplete' is the DEFAULT status of every
  // abandoned checkout, so including it would accrete permanent noise that dwarfs
  // real failing payments.
  const clientPayQ = { status: 'past_due' };
  const agencyPayQ = { status: 'past_due' };
  const offboardingQ = { lifecycleStatus: { $in: OFFBOARDING_STATES } };

  const [
    failedDomains, nFailedDomains,
    unverifiedEmail, nUnverifiedEmail,
    clientPay, nClientPay,
    agencyPay, nAgencyPay,
    offboarding, nOffboarding,
  ] = await Promise.all([
    Domain.find(failedDomainQ).select('hostname organizationId statusDetail lastCheckedAt').limit(HEALTH_ITEM_CAP).lean(),
    Domain.countDocuments(failedDomainQ),
    BrandConfig.find(unverifiedEmailQ).select('organizationId emailDomain').limit(HEALTH_ITEM_CAP).lean(),
    BrandConfig.countDocuments(unverifiedEmailQ),
    ClientSubscription.find(clientPayQ).select('organizationId workspaceId clientEmail status currentPeriodEnd').limit(HEALTH_ITEM_CAP).lean(),
    ClientSubscription.countDocuments(clientPayQ),
    Subscription.find(agencyPayQ).select('organizationId planId status').limit(HEALTH_ITEM_CAP).lean(),
    Subscription.countDocuments(agencyPayQ),
    Organization.find(offboardingQ).select('name lifecycleStatus lifecycleReason windDownStartedAt suspendAt purgeAt').limit(HEALTH_ITEM_CAP).lean(),
    Organization.countDocuments(offboardingQ),
  ]);

  return {
    generatedAt: new Date(),
    itemCap: HEALTH_ITEM_CAP,
    failedDomains: { count: nFailedDomains, items: failedDomains },
    unverifiedEmailDomains: {
      count: nUnverifiedEmail,
      items: unverifiedEmail.map((b) => ({
        organizationId: b.organizationId,
        domain: b.emailDomain?.domain || null,
        status: b.emailDomain?.status || null,
      })),
    },
    failingClientPayments: { count: nClientPay, items: clientPay },
    failingAgencyPayments: { count: nAgencyPay, items: agencyPay },
    agenciesOffboarding: { count: nOffboarding, items: offboarding },
  };
}

module.exports = { getTenantList, getHealthBoard, _summariseOrgClientSubs, HEALTH_ITEM_CAP };
