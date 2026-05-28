const mongoose = require('mongoose');

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

// NOTE: crawlPages and approvedPages have been moved to the CrawlPage collection
// (see src/models/CrawlPage.js) for enterprise scalability.

const crawlStatsSchema = new mongoose.Schema({
  totalFound: { type: Number, default: 0 },
  newUrls: { type: Number, default: 0 },
  removedUrls: { type: Number, default: 0 },
  unchanged: { type: Number, default: 0 },
  errors: { type: Number, default: 0 },
}, { _id: false });

const crawlHistoryEntrySchema = new mongoose.Schema({
  crawledAt: { type: Date, required: true },
  stats: { type: crawlStatsSchema, default: () => ({}) },
  pageCount: { type: Number, default: 0 },
}, { _id: false });

// ─── Main schema ──────────────────────────────────────────────────────────────

const sitemapSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
  },
  url: {
    type: String,
    required: true,
    maxlength: 2048,
  },
  label: {
    type: String,
    default: '',
    maxlength: 100,
  },

  // ─── Crawl state ─────────────────────────────────────────────────────
  crawlStatus: {
    type: String,
    enum: ['idle', 'crawling', 'completed', 'error'],
    default: 'idle',
  },
  crawlError: { type: String, default: null },
  crawlProgress: { type: Number, default: 0, min: 0, max: 100 },
  lastCrawlAt: { type: Date, default: null },
  nextCrawlAt: { type: Date, default: null },
  schedule: {
    type: String,
    enum: ['weekly'],
    default: 'weekly',
  },

  // ─── Approved baseline timestamp ─────────────────────────────────────
  // Pages are now stored in the CrawlPage collection (not embedded here)
  approvedAt: { type: Date, default: null },

  // ─── Latest crawl results (stats only — pages in CrawlPage collection) ─
  crawlStats: { type: crawlStatsSchema, default: () => ({}) },
  crawlCompletedAt: { type: Date, default: null },

  // ─── Crawl history (last N runs) ─────────────────────────────────────
  crawlHistory: { type: [crawlHistoryEntrySchema], default: [] },
}, { timestamps: true });

sitemapSchema.index({ organizationId: 1, workspaceId: 1 });
sitemapSchema.index({ crawlStatus: 1, nextCrawlAt: 1 });

module.exports = mongoose.model('Sitemap', sitemapSchema);
