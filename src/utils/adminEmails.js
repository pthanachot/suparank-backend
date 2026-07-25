/**
 * Single source of truth for "is this email a platform admin" (Phase 19B).
 *
 * Admin = the ADMIN_EMAILS env vars only (Phase 2 made this env-only: the
 * DB-managed SystemSettings.adminEmails path was retired). Synchronous, no DB
 * hit on the request path. Deliberately ignores JWT `roles` (stale until
 * re-login), matching validateAdmin.
 *
 * Env slots: ADMIN_EMAILS plus ADMIN_EMAILS_2..ADMIN_EMAILS_5, so up to five
 * admins can be managed as separate Railway variables. Each slot is still
 * comma-tolerant (one slot may list several emails) for backward compat with
 * the original single-var, comma-separated ADMIN_EMAILS.
 *
 * Extracted so validateAdmin AND impersonationService judge admin-ness the same
 * way — critical, because impersonation must NEVER target a platform admin, and
 * that guard must not drift from the gate that grants admin.
 */

// Slot 1 is the original ADMIN_EMAILS; slots 2–5 are the Railway expansion.
const ENV_SLOTS = [
  'ADMIN_EMAILS',
  'ADMIN_EMAILS_2',
  'ADMIN_EMAILS_3',
  'ADMIN_EMAILS_4',
  'ADMIN_EMAILS_5',
];

function envAdminEmails() {
  const out = [];
  for (const slot of ENV_SLOTS) {
    const raw = process.env[slot];
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const email = part.trim().toLowerCase();
      if (email) out.push(email);
    }
  }
  return out;
}

function adminEmailSet() {
  return new Set(envAdminEmails());
}

function isAdminEmail(email) {
  if (!email) return false;
  return adminEmailSet().has(String(email).toLowerCase());
}

module.exports = { isAdminEmail, adminEmailSet };
