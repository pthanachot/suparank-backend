/**
 * Workspace-level quota resolution (Phase 17 — ships DARK behind saasMode).
 *
 * A client-billed workspace (one with an active/trialing/past_due
 * ClientSubscription to an AgencyPlan) is subject to a SECOND ceiling on top of
 * its org's wholesale tier: the per-workspace limits the agency sold to that
 * client. This resolves "for this workspace, what AgencyPlan.limits apply right
 * now" — or null when there is no client billing in play.
 *
 * GATED: returns null unless the saasMode launch flag is live. With the flag
 * dark (prod today) this ALWAYS returns null, so requireQuota's second-ceiling
 * branch never engages and the org-scoped path is byte-identical to pre-P17.
 * The presence of an active ClientSubscription is the per-workspace signal that
 * a workspace is client-billed; the flag is the global launch switch.
 */

const flagService = require('./flagService');
const ClientSubscription = require('../models/ClientSubscription');
const AgencyPlan = require('../models/AgencyPlan');

// A client subscription caps its workspace while it grants access — mirrors
// connectWebhookController.ACCESS_STATUSES (active + grace). past_due is still
// billing (Stripe mid-retry), so the plan's ceiling still applies.
const BILLED_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * Resolve the AgencyPlan limits that cap a client-billed workspace, or null.
 * @param {ObjectId|string} workspaceId
 * @returns {Promise<object|null>} the AgencyPlan.limits sub-doc, or null when
 *   the workspace isn't client-billed or saasMode is dark.
 */
async function resolveWorkspacePlanLimits(workspaceId) {
  if (!workspaceId) return null;
  // Launch gate — dark ⇒ no workspace ceiling anywhere.
  if (!(await flagService.isFlagLive('saasMode'))) return null;

  // "One active sub per workspace" is an app invariant, not a DB constraint —
  // defensively take the most-recent if more than one somehow exists.
  const sub = await ClientSubscription.findOne({
    workspaceId,
    status: { $in: BILLED_STATUSES },
  })
    .sort({ currentPeriodEnd: -1, updatedAt: -1 })
    .select('agencyPlanId')
    .lean();
  if (!sub) return null; // genuinely not client-billed

  // The workspace IS client-billed but the plan is unresolvable (missing
  // agencyPlanId, or the AgencyPlan doc is gone). FAIL SAFE: return an
  // empty-but-non-null limits object. Every consumer then still treats the
  // workspace as client-billed — excludes the member's personal user_free
  // credits (preDeduct B1), keeps the per-workspace counter honest — just
  // WITHOUT enforceable caps, rather than reverting to normal billing and
  // letting the client drain a team member's personal credits or bypass the
  // per-workspace usage tracking entirely.
  if (!sub.agencyPlanId) return {};

  const plan = await AgencyPlan.findById(sub.agencyPlanId).select('limits').lean();
  return plan?.limits || {};
}

module.exports = { resolveWorkspacePlanLimits, BILLED_STATUSES };
