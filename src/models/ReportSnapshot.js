const mongoose = require('mongoose');

/**
 * Monthly workspace performance report (Phase 14).
 *
 * One snapshot per {workspaceId, period} — regeneration upserts in place
 * (idempotent). `data` is a denormalized, display-ready aggregate built by
 * reportService.generateSnapshot from Content, AiTracker/AiTrackerScan and
 * locally-stored GSC snapshot stats (Site.snapshotStats). Report generation
 * NEVER calls external APIs — it only reads what is already in Mongo.
 *
 * data shape:
 *   {
 *     workspaceName,
 *     content: null | { total, createdInPeriod, avgScore, scoredCount,
 *                       topContent: [{ contentNumber, title, score, wordCount }] },
 *     tracker: null | { monitors, scansInPeriod,
 *                       latest: { visibility, mentionRate, shareOfVoice, scannedAt } },
 *     gsc:     null | { sites, clicks, impressions, avgCtr, avgPosition, updatedAt },
 *     sourceErrors?: [{ source, error }]   // present only when a source failed
 *   }
 */
const reportSnapshotSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    // Calendar month, e.g. '2026-06'
    period: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    generatedAt: { type: Date, default: Date.now },
    // Set once the monthly cron has sent this report's emails. The cron's
    // dedupe key is "snapshot exists AND reportEmailedAt set" — so a snapshot
    // generated manually (or a crash between generate and email) still gets
    // its monthly email on the next cron run, and re-runs never double-send.
    reportEmailedAt: { type: Date, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// One report per workspace per month — regeneration upserts
reportSnapshotSchema.index({ workspaceId: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('ReportSnapshot', reportSnapshotSchema);
