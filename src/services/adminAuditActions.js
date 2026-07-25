/**
 * Admin audit action taxonomy (Phase 13) — the single source of truth for the
 * dot-notation `action` strings written to AdminAuditLog. Phase 14 instrumentation
 * imports these so action names can't drift/typo across call sites.
 *
 * Convention: `admin.<area>.<verb>`. targetType is chosen per call (see the model).
 */
const ADMIN_AUDIT_ACTIONS = Object.freeze({
  // users
  USER_UPDATE: 'admin.user.update',
  USER_DELETE: 'admin.user.delete',
  USER_CREDITS: 'admin.user.credits',
  USER_QUOTA: 'admin.user.quota',

  // organizations
  ORG_UPDATE: 'admin.org.update',
  ORG_DELETE: 'admin.org.delete',
  ORG_CREDITS: 'admin.org.credits',
  ORG_QUOTA: 'admin.org.quota',
  ORG_RESET_FREE: 'admin.org.reset_to_free',
  ORG_PLAN_OVERRIDE: 'admin.org.plan_override',

  // billing
  SUB_UPDATE: 'admin.sub.update',
  CREDITS_BULK: 'admin.credits.bulk',

  // system
  SETTINGS_UPDATE: 'admin.settings.update',
  BACKUP_RUN: 'admin.backup.run',

  // sessions
  SESSION_REVOKE: 'admin.session.revoke',
  SESSION_REVOKE_ALL: 'admin.session.revoke_all',

  // email portal
  EMAIL_SEND: 'admin.email.send',
  EMAIL_TEMPLATE_SAVE: 'admin.email.template_save',
  EMAIL_TEMPLATE_DELETE: 'admin.email.template_delete',
  EMAIL_DEFAULT_UPDATE: 'admin.email.default_update',

  // white-label brand
  BRAND_UPDATE: 'admin.brand.update',

  // announcements
  ANNOUNCEMENT_CREATE: 'admin.announcement.create',
  ANNOUNCEMENT_UPDATE: 'admin.announcement.update',

  // impersonation
  IMPERSONATE_START: 'admin.impersonate.start',
  IMPERSONATE_STOP: 'admin.impersonate.stop',
});

module.exports = ADMIN_AUDIT_ACTIONS;
