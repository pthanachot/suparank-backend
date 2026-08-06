/**
 * Migration test for the {workspaceId, url} unique index (plan §11, finding H).
 *
 * Adding the unique index (models/Sitemap.js) fails on a DB that already holds
 * duplicate rows, so scripts/dedupeSitemaps.js must run first. This verifies the
 * migration collapses duplicates (keeping the best row + purging orphaned crawl
 * pages), is idempotent, and leaves the DB able to build & enforce the index.
 *
 *   MONGO_TEST_URI=... node --test tests/sitemapDedupeMigration.test.js
 */

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { connect, clear, disconnect } = require('./helpers/memoryMongo');
const Sitemap = require('../src/models/Sitemap');
const CrawlPage = require('../src/models/CrawlPage');
const { dedupeSitemaps } = require('../src/scripts/dedupeSitemaps');

const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); }, { timeout: 120000 });
after(async () => { await disconnect(); });
// Drop indexes too, so a prior test's unique index doesn't reject the duplicate
// fixtures the next test needs to seed.
beforeEach(async () => { await clear(); try { await Sitemap.collection.dropIndexes(); } catch { /* none yet */ } });
afterEach(async () => {});

test('dedupeSitemaps collapses duplicates, keeps the best row, and purges orphaned crawl pages', async () => {
  const workspaceId = oid();
  const organizationId = oid();
  const url = 'https://dup.test';

  const older = await Sitemap.create({ organizationId, workspaceId, url, crawlCompletedAt: null });
  const completed = await Sitemap.create({ organizationId, workspaceId, url, crawlCompletedAt: new Date(1) });
  const newest = await Sitemap.create({ organizationId, workspaceId, url, crawlCompletedAt: null });
  // A different workspace with the same URL must be untouched (composite key).
  const sibling = await Sitemap.create({ organizationId, workspaceId: oid(), url });

  // One crawl page per sitemap so we can see the losers' pages get purged.
  for (const sm of [older, completed, newest, sibling]) {
    await CrawlPage.create({ sitemapId: sm._id, url: `${url}/p`, title: 't', statusCode: 200, diffStatus: 'new' });
  }

  const result = await dedupeSitemaps();

  assert.equal(result.duplicateGroups, 1, 'exactly one duplicate group');
  assert.equal(result.sitemapsRemoved, 2, 'two of the three duplicates removed');

  // Survivor is the completed-crawl row; the sibling workspace is untouched.
  const survivors = await Sitemap.find({ workspaceId, url }).lean();
  assert.equal(survivors.length, 1, 'one row survives per (workspaceId, url)');
  assert.equal(String(survivors[0]._id), String(completed._id), 'the completed-crawl row is kept');
  assert.equal(await Sitemap.countDocuments({ workspaceId: sibling.workspaceId }), 1, 'sibling workspace untouched');

  // Losers' crawl pages purged; kept + sibling pages remain.
  assert.equal(await CrawlPage.countDocuments({ sitemapId: older._id }), 0);
  assert.equal(await CrawlPage.countDocuments({ sitemapId: newest._id }), 0);
  assert.equal(await CrawlPage.countDocuments({ sitemapId: completed._id }), 1);
  assert.equal(await CrawlPage.countDocuments({ sitemapId: sibling._id }), 1);
});

test('dedupeSitemaps is idempotent (a second run removes nothing)', async () => {
  const workspaceId = oid();
  const organizationId = oid();
  const url = 'https://dup2.test';
  await Sitemap.create({ organizationId, workspaceId, url });
  await Sitemap.create({ organizationId, workspaceId, url });

  const first = await dedupeSitemaps();
  assert.equal(first.sitemapsRemoved, 1);

  const second = await dedupeSitemaps();
  assert.equal(second.duplicateGroups, 0, 'no duplicate groups remain');
  assert.equal(second.sitemapsRemoved, 0, 'idempotent — nothing removed on re-run');
});

test('after dedupe, the unique index builds and enforces {workspaceId, url}', async () => {
  const workspaceId = oid();
  const organizationId = oid();
  const url = 'https://dup3.test';
  await Sitemap.create({ organizationId, workspaceId, url });
  await Sitemap.create({ organizationId, workspaceId, url });

  await dedupeSitemaps();
  await Sitemap.syncIndexes(); // would throw here if duplicates remained

  await assert.rejects(
    () => Sitemap.create({ organizationId, workspaceId, url }),
    (err) => !!err && (err.code === 11000 || /duplicate|E11000/i.test(err.message || '')),
    'the unique index must reject a further duplicate after the migration',
  );
});
