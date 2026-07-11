/**
 * Agency console (Phase 19) — READ-ONLY endpoints powering an agency's client
 * roster + overview. Owner or org-wide admin only (same gate as usage reporting).
 * Routes are behind requireFeature('saasMode'), so this ships inert until SaaS
 * mode launches (no client subs exist while dark → empty anyway).
 *
 *   GET /api/org/organizations/:orgId/console/roster?period=YYYY-MM
 *   GET /api/org/organizations/:orgId/console/overview?period=YYYY-MM
 */

const agencyConsoleService = require('../services/agencyConsoleService');
const reportService = require('../services/reportService');
const orgMemberController = require('./orgMemberController');

/** Shared gate: owner or org-wide admin (scoped clients/staff can't see it). */
async function _gate(req, res) {
  const result = await orgMemberController.resolveOrgWithAccess(req, res, true);
  if (!result) return null;
  const { org, callerRole, accessScope } = result;
  if (accessScope === 'assigned' && callerRole !== 'owner') {
    res.status(403).json({ error: 'You do not have access to the agency console' });
    return null;
  }
  return org;
}

/** Validate ?period= up front (absent → service default = current month). */
function _period(req, res) {
  const period = req.query.period;
  if (period !== undefined && !reportService.isValidPeriod(period)) {
    res.status(400).json({ error: 'Invalid period — expected YYYY-MM' });
    return { bad: true };
  }
  return { period };
}

const getRoster = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;
    const { bad, period } = _period(req, res);
    if (bad) return;
    res.json(await agencyConsoleService.getClientRoster(org._id, period));
  } catch (error) {
    console.error('Agency console roster error:', error);
    res.status(500).json({ error: 'Failed to load client roster' });
  }
};

const getOverview = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;
    const { bad, period } = _period(req, res);
    if (bad) return;
    res.json(await agencyConsoleService.getAgencyOverview(org._id, period));
  } catch (error) {
    console.error('Agency console overview error:', error);
    res.status(500).json({ error: 'Failed to load agency overview' });
  }
};

module.exports = { getRoster, getOverview };
