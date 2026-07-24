const mongoose = require('mongoose');

// Per-user, in-app notification rows written by system events (e.g. analysis
// ready). Fanned OUT on write — one row per recipient — which is the opposite
// economics of Announcement (authored once, fanned IN on read). A notification
// is a POINTER, not a payload: `link` is where clicking it takes the user.
//
// DEFERRED (email delivery): these rows are IN-APP ONLY. When email lands it
// must NOT create a second parallel row here or loop sendEmail off this write —
// it reads the same source event and delivers through an idempotent
// claim-and-drain worker. See NOTIFICATION-SYSTEM-PLAN.md Phase 2/6.
const NOTIFICATION_TYPES = [
  'analysis.ready',
  'analysis.failed',
  'content.locked',
];

const notificationSchema = new mongoose.Schema(
  {
    // No inline index here — the compound { userId, createdAt } below is a
    // superset (userId is its leftmost prefix), so a standalone userId index
    // would be redundant write cost on every insert.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, enum: NOTIFICATION_TYPES },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    // The actionable target, e.g. /workspace/12/new/34. Every emitting event
    // supplies one — a notification you can't act on is noise.
    link: { type: String, default: '' },
    // DEFERRED (per-item read state): the v1 badge uses only
    // User.notificationsSeenAt. readAt is stored now — cheap to add, miserable
    // to backfill — so a later "dismiss this one" feature has its column ready.
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Feed query: this user's notifications, newest first.
notificationSchema.index({ userId: 1, createdAt: -1 });
// TTL — personal rows self-expire after 90 days. This MUST be its own
// single-field index: a TTL index cannot also be the compound index above.
// `timestamps:true` makes createdAt a BSON Date, which TTL requires.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'createdAt_ttl_90d' }
);

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
