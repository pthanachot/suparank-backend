/**
 * One-time migration: collapse duplicate {workspaceId, url} Sitemap rows so the
 * unique index (models/Sitemap.js) can build cleanly on a DB that predates it.
 *
 * For each duplicate group it KEEPS the best row — a completed crawl first, then
 * the most recently updated/created — and deletes the rest along with their
 * CrawlPage children. Idempotent: a second run finds no groups and removes nothing.
 *
 *   node src/scripts/dedupeSitemaps.js        # uses MONGODB_URI / DB_NAME
 */

const mongoose = require('mongoose');
const Sitemap = require('../models/Sitemap');
const CrawlPage = require('../models/CrawlPage');

async function dedupeSitemaps() {
  const groups = await Sitemap.aggregate([
    { $group: { _id: { workspaceId: '$workspaceId', url: '$url' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  let removed = 0;
  let crawlPagesRemoved = 0;
  for (const group of groups) {
    // Best row wins: a completed crawl (crawlCompletedAt not null) sorts before
    // nulls under descending order, then most recently touched.
    const rows = await Sitemap.find({ _id: { $in: group.ids } })
      .sort({ crawlCompletedAt: -1, updatedAt: -1, createdAt: -1 })
      .select('_id')
      .lean();
    const drop = rows.slice(1).map((r) => r._id);
    if (drop.length) {
      const pageRes = await CrawlPage.deleteMany({ sitemapId: { $in: drop } });
      crawlPagesRemoved += pageRes.deletedCount || 0;
      const smRes = await Sitemap.deleteMany({ _id: { $in: drop } });
      removed += smRes.deletedCount || 0;
    }
  }

  return { duplicateGroups: groups.length, sitemapsRemoved: removed, crawlPagesRemoved };
}

module.exports = { dedupeSitemaps };

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.error('Set MONGODB_URI to run this migration.'); process.exit(1); }
    await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'suparank' });
    const result = await dedupeSitemaps();
    console.log('[dedupeSitemaps]', result);
    // Build the unique index now that duplicates are gone.
    await Sitemap.syncIndexes();
    await mongoose.disconnect();
  })();
}
