const mongoose = require('mongoose');

const crawlPageSchema = new mongoose.Schema({
  sitemapId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sitemap',
    required: true,
  },
  url: { type: String, required: true },
  title: { type: String, default: '' },
  statusCode: { type: Number, default: null },
  discoveredFrom: { type: String, default: null },
  depth: { type: Number, default: null },
  responseTimeMs: { type: Number, default: null },
  diffStatus: {
    type: String,
    enum: ['new', 'unchanged', 'removed'],
    default: 'new',
  },
  // XML export fields (replaces approvedPages on Sitemap)
  lastmod: { type: String, default: null },
  changefreq: { type: String, default: 'weekly' },
  priority: { type: Number, default: 0.5 },
}, { timestamps: true });

// Fast filtered queries (e.g. "show me all new pages for this sitemap")
crawlPageSchema.index({ sitemapId: 1, diffStatus: 1 });

// Unique lookup and diff comparison
crawlPageSchema.index({ sitemapId: 1, url: 1 });

// Tree building by depth
crawlPageSchema.index({ sitemapId: 1, depth: 1 });

module.exports = mongoose.model('CrawlPage', crawlPageSchema);
