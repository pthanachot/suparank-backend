/**
 * Single source of truth for "is this email a platform admin" (Phase 19B).
 *
 * Admin = union of the ADMIN_EMAILS env var (locked safety floor) and the
 * DB-managed SystemSettings.adminEmails list (editable in the dashboard). Reads
 * the settings cache — synchronous, no DB hit on the request path. Deliberately
 * ignores JWT `roles` (stale until re-login), matching validateAdmin.
 *
 * Extracted so validateAdmin AND impersonationService judge admin-ness the same
 * way — critical, because impersonation must NEVER target a platform admin, and
 * that guard must not drift from the gate that grants admin.
 */

const { getSettings } = require('../services/systemSettingsService');

function adminEmailSet() {
  const env = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const db = (getSettings().adminEmails || []).map((e) => String(e).toLowerCase());
  return new Set([...env, ...db]);
}

function isAdminEmail(email) {
  if (!email) return false;
  return adminEmailSet().has(String(email).toLowerCase());
}

module.exports = { isAdminEmail, adminEmailSet };
