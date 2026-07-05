/**
 * Per-workspace usage (agency cost-visibility) — READ-ONLY.
 *
 *   GET /api/org/organizations/:orgId/usage/by-workspace?period=YYYY-MM
 *
 * Owner or org-wide admin only (same gate the email-domain routes use).
 * Returns a TOKEN-BASED proxy of per-workspace AI consumption — see
 * usageService for why this isn't exact credit/dollar cost. Never mutates
 * credits, quotas, or any deduction path.
 */

const usageService = require('../services/usageService');
const reportService = require('../services/reportService');
const { resolveOrgWithAccess } = require('./orgMemberController');

/** Shared gate: owner or org-wide admin. Writes the error response itself. */
async function _gate(req, res) {
  const result = await resolveOrgWithAccess(req, res, true);
  if (!result) return null;
  const { org, callerRole, accessScope } = result;
  // Scoped members (agency clients / restricted staff) must not see org-wide
  // usage across every workspace — only the owner or a full org admin may.
  if (accessScope === 'assigned' && callerRole !== 'owner') {
    res.status(403).json({ error: 'You do not have access to usage reporting' });
    return null;
  }
  return org;
}

const getWorkspaceUsage = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    // Validate up front so a malformed ?period=... 400s cleanly rather than
    // silently defaulting. Absent period → current month (service default).
    const period = req.query.period;
    if (period !== undefined && !reportService.isValidPeriod(period)) {
      return res.status(400).json({ error: 'Invalid period — expected YYYY-MM' });
    }

    const report = await usageService.aggregateWorkspaceUsage(org._id, period);
    res.json(report);
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Get workspace usage error:', error);
    res.status(500).json({ error: 'Failed to load workspace usage' });
  }
};

module.exports = { getWorkspaceUsage };
