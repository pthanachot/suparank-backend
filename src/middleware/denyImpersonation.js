/**
 * Blocks a route for IMPERSONATED sessions (Phase 19B hardening).
 *
 * An impersonation token IS the target owner's full identity, so by default it can
 * do everything the owner can. That's acceptable for operating the account, but a
 * short-lived SUPPORT session must never be able to SEIZE the account — i.e. change
 * the owner's login email/password, unlink identity providers, delete the account,
 * or transfer org ownership. Those escalate a 30-minute token into permanent
 * control (e.g. change email → public password-reset → own the account), defeating
 * the whole "short-lived, no-refresh" model. Apply this to those routes only;
 * operational routes stay open (and are attributable via the audit impersonatedBy).
 */

function denyImpersonation(req, res, next) {
  if (req.user?.impersonatedBy) {
    return res.status(403).json({ error: 'This action is not permitted while impersonating a user' });
  }
  next();
}

module.exports = denyImpersonation;
