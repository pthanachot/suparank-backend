/**
 * Per-workspace usage aggregation (agency cost-visibility, read-only).
 *
 * Agencies need a "cost-per-client" view: which workspaces are burning the
 * most AI usage this month. The ONLY place workspaceId is currently tracked
 * against usage is AgentUsageLog (one row per completed chat/agent run,
 * carrying inputTokens + outputTokens). CreditTransaction / UsageTracker do
 * NOT carry workspaceId yet, so exact credit/dollar attribution per workspace
 * is not possible here — that's a later phase.
 *
 * Therefore this is deliberately a TOKEN-BASED PROXY, not a credit report:
 * the response is labelled `basis: 'tokens'` and carries a `note` saying so.
 * It is strictly READ-ONLY — it never touches credits, quotas, or any
 * deduction path.
 *
 * Retention caveat: AgentUsageLog rows are TTL-pruned after 90 days, so any
 * period older than ~3 months aggregates to empty. The `note` flags this.
 */

const Workspace = require('../models/Workspace');
const AgentUsageLog = require('../models/AgentUsageLog');
const reportService = require('./reportService');

const USAGE_NOTE =
  'Token-based proxy from AI chat/agent runs (90-day retention); not exact credit/dollar cost.';

function _emptyEntry(workspace) {
  return {
    workspaceId: workspace._id,
    workspaceName: workspace.name || 'Workspace',
    workspaceNumber: workspace.workspaceNumber ?? null,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

/**
 * Aggregate token usage for every workspace in an org over a 'YYYY-MM' period
 * (UTC month bounds). Defaults to the current month. Workspaces with no runs
 * in the period are still returned (zeroed) so the agency sees every client.
 *
 * @param {string|ObjectId} orgId
 * @param {string} [period] 'YYYY-MM' — defaults to the current UTC month
 * @returns {Promise<{period, basis:'tokens', note, workspaces:[], totals:{}}>}
 * @throws {Error & {status:400}} on a malformed period
 */
async function aggregateWorkspaceUsage(orgId, period) {
  const resolvedPeriod = period || reportService.currentPeriod();
  if (!reportService.isValidPeriod(resolvedPeriod)) {
    const err = new Error('Invalid period — expected YYYY-MM');
    err.status = 400;
    throw err;
  }

  const { start, end } = reportService.periodBounds(resolvedPeriod);

  const workspaces = await Workspace.find({ organizationId: orgId })
    .select('name workspaceNumber')
    .lean();

  // Empty org (or one whose only usage sits outside the retention window)
  // is a valid, non-error result — return the zeroed shell.
  if (!workspaces || workspaces.length === 0) {
    return {
      period: resolvedPeriod,
      basis: 'tokens',
      note: USAGE_NOTE,
      workspaces: [],
      totals: { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  const workspaceIds = workspaces.map((w) => w._id);

  // Single pipeline keyed by workspaceId, bounded to the UTC month. Names are
  // joined in JS from the Workspace list above (cheaper than a $lookup and
  // keeps zero-usage workspaces in the output).
  let usageByWorkspace = new Map();
  try {
    const rows = await AgentUsageLog.aggregate([
      {
        $match: {
          workspaceId: { $in: workspaceIds },
          createdAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: '$workspaceId',
          runs: { $sum: 1 },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
        },
      },
    ]);
    usageByWorkspace = new Map((rows || []).map((r) => [String(r._id), r]));
  } catch (err) {
    // A failed aggregation must not take down the whole report — degrade to
    // zeroed usage rather than throwing (read-only, best-effort surface).
    console.error('[usage] aggregate failed:', err.message);
    usageByWorkspace = new Map();
  }

  const totals = { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const entries = workspaces.map((workspace) => {
    // Never let one malformed workspace/usage row abort the whole response.
    try {
      const entry = _emptyEntry(workspace);
      const usage = usageByWorkspace.get(String(workspace._id));
      if (usage) {
        entry.runs = usage.runs || 0;
        entry.inputTokens = usage.inputTokens || 0;
        entry.outputTokens = usage.outputTokens || 0;
        entry.totalTokens = entry.inputTokens + entry.outputTokens;
      }
      totals.runs += entry.runs;
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.totalTokens += entry.totalTokens;
      return entry;
    } catch (err) {
      console.error('[usage] failed to aggregate workspace:', err.message);
      return _emptyEntry(workspace);
    }
  });

  // Heaviest consumers first — that's the cost-per-client question.
  entries.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    period: resolvedPeriod,
    basis: 'tokens',
    note: USAGE_NOTE,
    workspaces: entries,
    totals,
  };
}

module.exports = { aggregateWorkspaceUsage, USAGE_NOTE };
