const mongoose = require('mongoose');

/**
 * Site — represents a website connected to Google Search Console.
 * See TierConfig.maxSites for per-tier limits.
 */

const snapshotStatsSchema = new mongoose.Schema(
  {
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    position: { type: Number, default: 0 },
    clicksTrend: { type: [Number], default: [] },
    trendDirection: { type: String, enum: ['up', 'down', 'flat'], default: 'flat' },
    pagesCount: { type: Number, default: 0 },
    keywordsCount: { type: Number, default: 0 },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const siteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    gscPropertyId: {
      type: String,
      default: null,
    },
    gscPropertyType: {
      type: String,
      enum: ['URL_PREFIX', 'DOMAIN'],
      default: 'URL_PREFIX',
    },
    verified: {
      type: Boolean,
      default: false,
    },
    syncFrequency: {
      type: String,
      enum: ['daily', 'weekly'],
      default: 'daily',
    },
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'error'],
      default: 'idle',
    },
    syncError: {
      type: String,
      default: null,
    },
    lastSyncAt: {
      type: Date,
      default: null,
    },
    snapshotStats: {
      type: snapshotStatsSchema,
      default: null,
    },
    locked: {
      type: Boolean,
      default: false,
    },
    // Rec 7: last AI-crawler access audit (robots.txt verdicts + CDN probe)
    // from the engine's /api/bot-access. Cached 7 days; shape is the engine's
    // Report JSON, stored as-is.
    botAccess: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    botAccessCheckedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

siteSchema.index({ organizationId: 1, url: 1 }, { unique: true });
siteSchema.index({ workspaceId: 1 });

module.exports = mongoose.model('Site', siteSchema);
