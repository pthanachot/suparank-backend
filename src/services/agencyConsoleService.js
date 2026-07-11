/**
 * Agency console service (Phase 19) — read-only aggregation powering an agency's
 * client roster and overview. One row per CLIENT workspace: plan, MRR, current
 * status, per-period usage, and credit cap.
 *
 * Spine is ClientSubscription (organizationId), NOT a workspace scan — the
 * authoritative "this is a client" signal is having a subscription. A workspace
 * can accumulate several sub records over its life (re-subscribes mint new ones,
 * old ones go 'canceled'); we collapse to ONE primary sub per workspace (a live/
 * billed one if present, else the most recent) so MRR is never double-counted.
 *
 * MRR: there is no price on the sub — it's a 2-hop join to AgencyPlan.amount
 * (CENTS) + interval. Year plans are normalised to a monthly figure. MRR counts
 * only PAYING clients (active/past_due — trials pay nothing, plan-less clients
 * can't be priced) and is NEVER summed across currencies; the summary groups it
 * by currency and separates trialing/unpriced so counts and MRR never disagree.
 *
 * "Read-only" with one caveat: getAgencyOverview calls creditService.getBalance,
 * which lazily EXPIRES stale subscription credits (a write) — identical to the
 * existing GET /credits behaviour and idempotent.
 *
 * All figures are proxies of the same models the rest of SaaS mode writes, so
 * with saasMode dark there are no client subs and every result is empty. The
 * routes are gated behind requireFeature('saasMode'). Not paginated — an agency's
 * client workspaces are tier-capped, though historical canceled subs accrete.
 */

const ClientSubscription = require('../models/ClientSubscription');
const AgencyPlan = require('../models/AgencyPlan');
const Workspace = require('../models/Workspace');
const WorkspaceUsageTracker = require('../models/WorkspaceUsageTracker');
const Organization = require('../models/Organization');
const creditService = require('./creditService');
const tierService = require('./tierService');
const { BILLED_STATUSES } = require('./workspaceQuotaService');

// A client HAS ACCESS in any BILLED_STATUS (active/trialing/past_due). But MRR is
// COMMITTED RECURRING REVENUE — a trial has paid nothing yet, so it must NOT be
// booked at plan price. past_due is a renewal Stripe is retrying → still counted
// (at-risk revenue), matching how the rest of SaaS mode treats it.
const MRR_STATUSES = ['active', 'past_due'];

/** Normalise a plan's price to whole monthly CENTS (0 if no plan). */
function _monthlyCents(plan) {
  if (!plan || typeof plan.amount !== 'number') return 0;
  return plan.interval === 'year' ? Math.round(plan.amount / 12) : plan.amount;
}

/** Pick the one sub that represents a workspace's current client relationship. */
function _primarySub(subs) {
  const billed = subs.filter((s) => BILLED_STATUSES.includes(s.status));
  const pool = billed.length ? billed : subs;
  // Most recent by createdAt (a workspace has at most one live sub, but be safe).
  return pool.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

/** Single human-facing status for THIS client (lock > urgent billing > cancel >
 *  raw). Deliberately NOT overridden by the AGENCY's lifecycle — a healthy client
 *  of a winding-down agency is not itself "winding down"; the agency's lifecycle
 *  is surfaced once, at the overview level. past_due outranks 'canceling' because
 *  a failing payment is the more urgent signal (cancelAtPeriodEnd is still exposed
 *  as its own field for the UI). */
function _deriveStatus(sub, workspace) {
  if (workspace?.clientLocked) return 'locked';
  if (sub.status === 'past_due') return 'past_due';
  if ((sub.status === 'active' || sub.status === 'trialing') && sub.cancelAtPeriodEnd) return 'canceling';
  return sub.status; // active/trialing/canceled/incomplete/paused
}

/**
 * Build the client roster for one agency org. `period` is 'YYYY-MM' (defaults to
 * the current month). Returns { period, summary, clients }.
 */
async function getClientRoster(orgId, period) {
  const p = period || tierService.getPeriod('monthly');

  const subs = await ClientSubscription.find({ organizationId: orgId }).lean();

  if (!subs.length) {
    return { period: p, summary: _emptySummary(), clients: [] };
  }

  // Collapse to one primary sub per workspace.
  const byWorkspace = new Map();
  for (const s of subs) {
    const key = String(s.workspaceId);
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(s);
  }
  const primaries = [...byWorkspace.values()].map(_primarySub);

  // Batch the joins.
  const workspaceIds = primaries.map((s) => s.workspaceId).filter(Boolean);
  const planIds = [...new Set(primaries.map((s) => s.agencyPlanId).filter(Boolean).map(String))];

  const [workspaces, plans, usageRows] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } })
      .select('workspaceNumber name clientLocked clientLockedAt').lean(),
    planIds.length ? AgencyPlan.find({ _id: { $in: planIds } })
      .select('name amount currency interval limits').lean() : [],
    WorkspaceUsageTracker.find({ workspaceId: { $in: workspaceIds }, period: p }).lean(),
  ]);
  const wsById = new Map(workspaces.map((w) => [String(w._id), w]));
  const planById = new Map(plans.map((pl) => [String(pl._id), pl]));
  const usageByWs = new Map(usageRows.map((u) => [String(u.workspaceId), u]));

  const clients = primaries.map((sub) => {
    const ws = wsById.get(String(sub.workspaceId));
    const plan = sub.agencyPlanId ? planById.get(String(sub.agencyPlanId)) : null;
    const status = _deriveStatus(sub, ws);
    const hasAccess = BILLED_STATUSES.includes(sub.status);   // active/trialing/past_due
    const mrrEligible = MRR_STATUSES.includes(sub.status);    // active/past_due (excludes trial)
    // A paying (MRR-eligible) client whose plan was deleted can't be priced — flag
    // it so the summary's activeClients vs MRR never silently disagree.
    const unpriced = mrrEligible && !plan;
    const currency = (plan?.currency || 'usd').toLowerCase();
    const mrrCents = mrrEligible && plan ? _monthlyCents(plan) : 0;
    const u = usageByWs.get(String(sub.workspaceId));
    return {
      workspaceId: String(sub.workspaceId),
      workspaceNumber: ws?.workspaceNumber ?? null,
      workspaceName: ws?.name ?? null,
      clientEmail: sub.clientEmail || null,
      plan: plan ? { id: String(plan._id), name: plan.name, amount: plan.amount, currency, interval: plan.interval } : null,
      status,
      subStatus: sub.status,
      hasAccess,          // client can use the workspace (billed status)
      unpriced,           // MRR-eligible but plan missing → needs attention
      mrrCents,           // 0 for trials and unpriced clients
      currency,
      cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
      currentPeriodEnd: sub.currentPeriodEnd || null,
      locked: !!ws?.clientLocked,
      creditsLimit: plan?.limits?.creditsPerMonth ?? null,
      usage: u
        ? {
            creditsUsed: u.creditsUsed || 0,
            articlesCreated: u.articlesCreated || 0,
            keywordSearches: u.keywordSearches || 0,
            auditsRun: u.auditsRun || 0,
            aiTrackerPromptsCreated: u.aiTrackerPromptsCreated || 0,
          }
        : null,
      createdAt: sub.createdAt || null,
    };
  });

  // Stable, useful order: clients with access first, then by MRR desc, then name.
  clients.sort((a, b) =>
    (Number(b.hasAccess) - Number(a.hasAccess)) || (b.mrrCents - a.mrrCents) ||
    String(a.workspaceName || '').localeCompare(String(b.workspaceName || '')));

  return { period: p, summary: _summarise(clients), clients };
}

function _emptySummary() {
  return {
    totalClients: 0, activeClients: 0, trialingClients: 0, canceledClients: 0,
    unpricedClients: 0, mrrByCurrency: {}, usageCreditsUsed: 0,
  };
}

/**
 * Roll up the rows. Invariant kept EXPLICIT so activeClients and mrrByCurrency
 * can never silently disagree: activeClients = every client with access (incl.
 * trials); mrrByCurrency sums only priced, MRR-eligible clients; trialingClients
 * and unpricedClients account for the access-but-no-MRR remainder.
 */
function _summarise(clients) {
  const mrrByCurrency = {};
  let activeClients = 0;
  let trialingClients = 0;
  let canceledClients = 0;
  let unpricedClients = 0;
  let usageCreditsUsed = 0;
  for (const c of clients) {
    if (c.hasAccess) activeClients++;
    if (c.subStatus === 'trialing') trialingClients++;
    if (c.subStatus === 'canceled') canceledClients++;
    if (c.unpriced) unpricedClients++;
    if (c.mrrCents > 0) mrrByCurrency[c.currency] = (mrrByCurrency[c.currency] || 0) + c.mrrCents;
    usageCreditsUsed += c.usage?.creditsUsed || 0;
  }
  return { totalClients: clients.length, activeClients, trialingClients, canceledClients, unpricedClients, mrrByCurrency, usageCreditsUsed };
}

/**
 * Console header overview: the roster summary + the agency's (org-wide) credit
 * balance + lifecycle status. Credits are org-scoped — there is one shared pool,
 * not a per-client balance.
 */
async function getAgencyOverview(orgId, period) {
  const [roster, balance, orgDoc] = await Promise.all([
    getClientRoster(orgId, period),
    creditService.getBalance(orgId).catch(() => null),
    Organization.findById(orgId).select('lifecycleStatus name').lean(),
  ]);
  return {
    period: roster.period,
    organization: orgDoc ? { id: String(orgDoc._id), name: orgDoc.name, lifecycleStatus: orgDoc.lifecycleStatus } : null,
    clients: {
      total: roster.summary.totalClients,
      active: roster.summary.activeClients,
      trialing: roster.summary.trialingClients,
      canceled: roster.summary.canceledClients,
      unpriced: roster.summary.unpricedClients,
    },
    mrrByCurrency: roster.summary.mrrByCurrency,
    credits: balance ? { subscription: balance.subscription, general: balance.general, total: balance.total, expiresAt: balance.expiresAt } : null,
  };
}

module.exports = { getClientRoster, getAgencyOverview, _monthlyCents, _primarySub, _deriveStatus, MRR_STATUSES };
