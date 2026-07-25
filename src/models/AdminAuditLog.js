const mongoose = require('mongoose');

/**
 * Platform-admin audit trail — who (which admin) did what to whom, when.
 *
 * DISTINCT from the org-scoped AuditLog (models/AuditLog.js). That one records a
 * tenant's own activity (organizationId REQUIRED). This one records PLATFORM
 * admin actions, which are frequently not org-scoped (system settings, backups,
 * bulk ops, sending email), need a GLOBAL query index, and want a longer
 * retention — so it deliberately does NOT reuse AuditLog and has no
 * organizationId (Phase 11 decision D3).
 *
 * Written fire-and-forget by adminAuditService (Phase 13) after each successful
 * mutating admin action (mutations only — D5). A failed write must never break
 * the operation being audited.
 *
 * Retention: 730-day TTL (D4) — longer than the org log's 180 days, since an
 * admin/compliance trail should outlive tenant activity.
 */

const RETENTION_DAYS = 730;

const adminAuditLogSchema = new mongoose.Schema(
  {
    // The admin who performed the action. userId may be null for a system actor
    // (e.g. a scheduled job); actorEmail is denormalized so the row stays
    // readable after the admin's account is deleted or their email changes.
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: '' },

    // Dot-notation verb, e.g. 'admin.credits.grant', 'admin.user.delete',
    // 'admin.settings.update', 'admin.impersonate.start'.
    action: { type: String, required: true },

    // What was acted on. FREE STRING by convention (NOT an enum): the writer is
    // fire-and-forget, so a hard enum would make an unforeseen/typo'd targetType
    // throw a ValidationError that the writer swallows → the audit row is
    // silently dropped, the one failure an audit log must never have. Matches
    // AuditLog.resource. Conventional values:
    //   user | org | sub | session | system | email | announcement |
    //   impersonation | brand | admin
    // targetId is a String because it varies by type (numeric userId, ObjectId
    // org/sub id, an email, a trigger key, …).
    targetType: { type: String, required: true },
    targetId: { type: String, default: null },

    // Small before/after snapshots for mutations (NOT full documents) + any
    // extra display context. Keep these small — this is a trail, not a backup.
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },

    ip: { type: String, default: null },

    // Defense-in-depth flag: admin routes hard-block impersonated sessions
    // (validateAdmin), so this should always be false — recorded anyway so a
    // future regression would be visible in the trail rather than invisible.
    impersonated: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    // Fail-fast instead of buffering: the fire-and-forget writer should get an
    // immediate rejection (which it catches + logs) if the DB is unreachable,
    // never queue audit writes waiting on a connection. In production the app is
    // connected before serving requests, so this only affects outage/test paths.
    bufferCommands: false,
  }
);

// Primary read pattern: the global admin feed, newest first, with _id as the
// keyset-pagination tiebreaker so same-millisecond rows are never skipped.
adminAuditLogSchema.index({ createdAt: -1, _id: -1 });
// Filter by actor (which admin did things).
adminAuditLogSchema.index({ actorEmail: 1, createdAt: -1 });
// Filter by action type over time (Phase 15 read API's action filter).
adminAuditLogSchema.index({ action: 1, createdAt: -1 });
// Filter by target (everything that happened to a given user/org/…).
adminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
// TTL — 730 days (single-field on createdAt, separate from the feed index).
adminAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;
