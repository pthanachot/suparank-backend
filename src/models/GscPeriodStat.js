const mongoose = require('mongoose');

/**
 * GscPeriodStat — per-site, per-calendar-month GSC rollup (Phase 2 of the
 * client-report work).
 *
 * Why this exists: Site.snapshotStats is a trailing-28-days-at-last-sync
 * window, so a monthly report reading it shows CURRENT data under a past
 * month's heading. These rows pin each calendar month's real numbers so
 * report generation stays a pure Mongo read (the "no external APIs at
 * generate time" invariant on ReportSnapshot) and regenerating a historical
 * report never mutates its GSC section.
 *
 * Written by gscService (refreshSiteStats upserts the current and previous
 * month on every sync; the daily cron sweep guarantees syncs happen even
 * when nobody opens the Sites page). Numbers follow snapshotStats
 * conventions: ctr is a percentage rounded to 2dp, position to 1dp.
 * The current month's row is necessarily partial (GSC data lags ~3 days);
 * each later sync self-heals it, and the previous-month upsert finalizes a
 * month shortly after it ends.
 */

const topQuerySchema = new mongoose.Schema(
  {
    query: { type: String, default: '' },
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    position: { type: Number, default: 0 },
  },
  { _id: false }
);

const gscPeriodStatSchema = new mongoose.Schema(
  {
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Site',
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    // Calendar month, e.g. '2026-06' (same convention as ReportSnapshot)
    period: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }, // percent, 2dp (snapshotStats parity)
    position: { type: Number, default: 0 }, // 1dp
    topQueries: { type: [topQuerySchema], default: [] },
    // The GSC date range this row actually covers (endDate < month end
    // while the month is still in progress — lets readers label partials).
    rangeStart: { type: String, default: null }, // 'YYYY-MM-DD'
    rangeEnd: { type: String, default: null },
  },
  { timestamps: true }
);

// One row per site per month — sync upserts in place
gscPeriodStatSchema.index({ siteId: 1, period: 1 }, { unique: true });
// Report read path: all of a workspace's sites for one period
gscPeriodStatSchema.index({ workspaceId: 1, period: 1 });

module.exports = mongoose.model('GscPeriodStat', gscPeriodStatSchema);
