const mongoose = require('mongoose');

/**
 * ObservationDailyRollup — durable per-day usage aggregates (Wave 0, §3.6).
 *
 * Raw ObservationEvent rows TTL at 90 days; retention curves, cohort math and
 * the Reach×Stickiness quadrant need history measured in years. The nightly
 * rollup (observationRollupService, cron 03:40 UTC) folds each UTC day into
 * one row per (day × event × org × workspace) BEFORE the raw events expire.
 * NO TTL — this collection is the long-term memory. Every day the rollup
 * doesn't run is a day of retention history lost forever once the TTL bites.
 *
 * `workspaceNumber` is a first-class dimension (null when the event carries
 * none): Active Workspaces, WAW, workspace-active cohort retention and the
 * quadrant's reach axis are all workspace-denominated and unrecoverable
 * retroactively (USAGE-TELEMETRY-PLAN.md Rev 2).
 *
 * `source`: 'observation' = aggregated from ObservationEvent;
 *           'audit' = billing/lifecycle actions folded in from AuditLog
 *           (which TTLs at 180d — churn context must outlive it).
 *
 * Impersonated events are EXCLUDED at aggregation time, not query time.
 */
const observationDailyRollupSchema = new mongoose.Schema(
  {
    day: { type: Date, required: true }, // UTC midnight of the aggregated day
    event: { type: String, required: true },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    workspaceNumber: { type: Number, default: null },
    count: { type: Number, required: true, min: 0 },
    // Distinct non-null userIds that day (per event × org × workspace).
    uniqueUsers: { type: Number, required: true, min: 0 },
    source: { type: String, enum: ['observation', 'audit'], default: 'observation' },
  },
  { timestamps: true }
);

// Idempotency: re-rolling a day upserts on this identity instead of duplicating.
observationDailyRollupSchema.index(
  { day: 1, event: 1, organizationId: 1, workspaceNumber: 1, source: 1 },
  { unique: true, name: 'rollup_identity' }
);
// Read paths: one event over time; one org's activity over time.
observationDailyRollupSchema.index({ event: 1, day: -1 });
observationDailyRollupSchema.index({ organizationId: 1, day: -1 });

module.exports = mongoose.model('ObservationDailyRollup', observationDailyRollupSchema);
