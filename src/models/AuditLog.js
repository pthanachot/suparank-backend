const mongoose = require('mongoose');

/**
 * Org-scoped audit trail — who did what, where, when.
 * Written fire-and-forget by auditService; a failed write must never
 * break the operation being audited.
 *
 * Entries auto-expire after ~180 days (matches the agency tier's
 * contentVersionHistoryDays) via the TTL index on createdAt.
 */
const auditLogSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      // No standalone index — covered by the {organizationId, createdAt, _id}
      // compound below (prefix rule).
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // null = system actor (e.g. Stripe webhook, cron)
    },
    actorEmail: {
      type: String,
      default: '',
      // Denormalized at write time so entries stay readable after the
      // actor's account is deleted or their email changes.
    },
    action: {
      type: String,
      required: true,
      // Dot notation: 'content.create', 'member.invite', 'billing.subscription_canceled'
    },
    resource: { type: String, required: true }, // 'content' | 'workspace' | 'member' | 'invite' | 'org' | 'billing'
    resourceId: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }, // small display context only
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Primary read pattern: latest activity for an org, with _id as the
// pagination tiebreaker so same-millisecond entries are never skipped.
auditLogSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
// TTL — 180 days
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
