/**
 * Maintenance-mode gate. When SystemSettings.maintenanceMode is on, non-exempt
 * traffic gets a 503. Exemptions (path-based, NOT role-based):
 *   /api/auth     — admins must be able to log in
 *   /api/admin    — the dashboard, incl. the toggle to turn maintenance back off
 *   /api/internal — server-to-server engine traffic
 *   /health       — health checks
 * Stripe webhooks are mounted ABOVE this middleware, so they bypass it entirely.
 *
 * The /api/admin exemption is the guarantee that an admin can never be locked
 * out: whatever else is down, the dashboard stays reachable to disable it.
 */
const systemSettingsService = require('../services/systemSettingsService');

const EXEMPT_PREFIXES = ['/api/auth', '/api/admin', '/api/internal', '/health'];

function maintenanceGate(req, res, next) {
  if (!systemSettingsService.getSettings().maintenanceMode) return next();
  const url = req.originalUrl;
  if (EXEMPT_PREFIXES.some((p) => url.startsWith(p))) return next();
  return res.status(503).json({ error: 'SupaRank is undergoing maintenance. Please try again shortly.' });
}

module.exports = maintenanceGate;
module.exports.EXEMPT_PREFIXES = EXEMPT_PREFIXES;
