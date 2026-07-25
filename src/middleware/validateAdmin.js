/**
 * Platform-admin gate. Admin = the ADMIN_EMAILS env vars only (ADMIN_EMAILS +
 * ADMIN_EMAILS_2..5; see utils/adminEmails). Env-only since Phase 2. Deliberately
 * ignores req.user.roles — JWT role claims are stale until re-login.
 *
 * Phase 19B: also hard-blocks any IMPERSONATED session. An impersonation token
 * carries the target's identity, so without this a support session could reach
 * admin routes if the target happened to be admin-allowlisted. Belt-and-
 * suspenders with impersonationService, which already refuses admin targets.
 */

const { isAdminEmail } = require('../utils/adminEmails');

function validateAdmin(req, res, next) {
  if (req.user?.impersonatedBy) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!isAdminEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = validateAdmin;
