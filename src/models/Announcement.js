const mongoose = require('mongoose');

// Admin-authored broadcast. ONE row per announcement, fanned IN on read — the
// feed query matches it against the reader's audience + brand — so a
// platform-wide post costs zero per-user rows.
//
// v1 authors ONLY platform-scope, product-class, in-app announcements. The
// class / authorScope / (commented) email fields exist now because they are
// impossible to retrofit once rows exist, and are the attach points for two
// deferred phases. See NOTIFICATION-SYSTEM-PLAN.md.
const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'published', 'unpublished'];

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, default: '', maxlength: 5000 },
    // A RELATIVE path (e.g. /workspace/12/new/34), never an absolute URL — a
    // relative link stays on whatever brand host the reader is on, and an
    // absolute one would be an open-redirect/phishing surface once tenant
    // owners can author (deferred). Phase 6 authoring must enforce the leading
    // slash; system-emitted links are code-generated and already safe.
    link: { type: String, default: '' },

    // DEFERRED (consent, 2-axis): 'marketing' vs 'product' decides whether the
    // email opt-out applies. v1 writes only 'product'. When email lands, the
    // single User.preferences.emailNotifications boolean splits along this axis.
    class: { type: String, enum: ['product', 'marketing'], default: 'product' },

    // DEFERRED (tenant authoring): authorScope 'org' + authorOrgId is how a
    // white-label owner broadcasts to their own clients — needs an RBAC
    // permission + white-label entitlement gate. v1 writes only 'platform'. The
    // READ path already serves org-scope; only the WRITE side is deferred.
    authorScope: { type: String, enum: ['platform', 'org'], default: 'platform' },
    authorOrgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },

    // Audience filter, evaluated at read time. excludeRoles defaults to hiding
    // platform news from external agency clients (the 'client' role).
    audience: {
      tiers: { type: [String], default: [] }, // empty = all tiers
      excludeRoles: { type: [String], default: ['client'] },
    },

    // Scheduling is a READ-TIME predicate: live when
    // publishAt <= now <= expiresAt AND status === 'published'. No worker,
    // and unpublish is instant. Null publishAt = live as soon as published;
    // null expiresAt = never expires.
    publishAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    // No inline index — the compound { status, publishAt } below covers
    // status-equality lookups as its leftmost prefix. The admin list view is
    // low-volume (a handful of announcements ever) so it needs no index of its
    // own.
    status: { type: String, enum: ANNOUNCEMENT_STATUSES, default: 'draft' },
    // The row IS the publish record — who / what / when / how many — because a
    // platform-wide broadcast has no organizationId and auditService no-ops
    // without one. publishedBy + publishAt + audienceCount together are the
    // audit trail (mirrors EmailSendLog's intent without a second collection).
    publishedBy: { type: String, default: '' }, // admin email
    audienceCount: { type: Number, default: 0 }, // reach estimate at publish time

    // DEFERRED (email delivery): a { enabled, sentAt } sub-doc attaches here.
    // sentAt is the idempotency guard — a claim-and-drain worker sets it
    // atomically so a republish or a double-click Send can never re-broadcast.
    // Absent in v1.
    // email: { enabled: { type: Boolean, default: false }, sentAt: { type: Date, default: null } },
  },
  { timestamps: true }
);

// Feed query: currently-live announcements — status equality, then window.
announcementSchema.index({ status: 1, publishAt: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);
module.exports.ANNOUNCEMENT_STATUSES = ANNOUNCEMENT_STATUSES;
