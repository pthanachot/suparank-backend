const mongoose = require('mongoose');

/**
 * UserActivityRollup — durable per-day "who was active" (Wave 5 Phase 2, §9).
 *
 * Retention and cohort math need to answer "was this user active in week N?"
 * for windows measured in months. Raw ObservationEvent rows TTL at 90 days, so
 * that question becomes permanently unanswerable for any period older than the
 * TTL horizon — and the horizon moves forward every day. This collection is
 * written by the same nightly job as ObservationDailyRollup (03:40 UTC, 3-day
 * idempotent re-roll) and has NO TTL.
 *
 * Why a separate collection from ObservationDailyRollup: that one is keyed by
 * event and answers "how much of feature X happened"; distinct-user math can't
 * be recovered from it, because summing uniqueUsers across events double-counts
 * anyone who fired two different events. This one is keyed by user.
 *
 * Identity is (day × user × org) so a user active in two organizations on the
 * same day produces one row each — per-org retention needs that split, and
 * whole-product retention just groups by userId.
 *
 * Impersonated events are EXCLUDED at aggregation time: an admin browsing as a
 * customer must never make that customer look retained.
 */
const userActivityRollupSchema = new mongoose.Schema(
  {
    day: { type: Date, required: true }, // UTC midnight of the aggregated day
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    // Events that user emitted that day in that org — activity depth, not just
    // presence, so "active" can later be re-thresholded without a re-roll.
    eventCount: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

// Idempotency: re-rolling a day upserts on this identity instead of duplicating.
userActivityRollupSchema.index(
  { day: 1, userId: 1, organizationId: 1 },
  { unique: true, name: 'user_activity_identity' }
);
// Read paths: one user's activity over time; a cohort's activity in a window.
userActivityRollupSchema.index({ userId: 1, day: 1 });
userActivityRollupSchema.index({ day: 1 });

module.exports = mongoose.model('UserActivityRollup', userActivityRollupSchema);
