const mongoose = require('mongoose');

// Phase 7.3 — durable sink for product-metric observations batched from the
// editor (POST /api/observe). Append-only, TTL-expired at 90 days. Identity is
// the authenticated user; workspace/content/org come from the event payload.
const observationEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    workspaceNumber: { type: Number, default: null },
    contentNumber: { type: Number, default: null },
    // Client-side epoch-ms when the event fired (may differ from createdAt due
    // to the 5s batch window / offline queue).
    ts: { type: Number, default: null },
    // Wave 0 (§3.5): the real admin's userId when this event was recorded by an
    // impersonation session (middleware swaps session_token → impersonation_token,
    // so `userId` above is the impersonated tenant). String, not ObjectId — a
    // cast error inside the swallowed insertMany would drop the whole batch.
    // Analytics queries filter { impersonatedBy: null } (matches missing too).
    impersonatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

// Common analytics query: events of a kind over a recent window.
observationEventSchema.index({ event: 1, createdAt: -1 });
// TTL: observations are aggregate signal, not records — expire after 90 days.
observationEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'createdAt_ttl_90d' }
);

module.exports = mongoose.model('ObservationEvent', observationEventSchema);
