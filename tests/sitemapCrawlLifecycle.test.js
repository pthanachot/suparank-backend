/**
 * Crawl-lifecycle invariants & resilience (plan §2 crawl invariants + §5 chaos;
 * findings I & J). Drives the REAL crawlSite end-to-end on in-memory MongoDB with
 * network via the Phase 1 seams (public resolver so the SSRF guard allows the
 * mock hosts; injected clock for deterministic backoff assertions).
 *
 *   node --test tests/sitemapCrawlLifecycle.test.js
 */

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { connect, clear, disconnect } = require('./helpers/memoryMongo');
const Sitemap = require('../src/models/Sitemap');
const CrawlPage = require('../src/models/CrawlPage');
const crawler = require('../src/services/sitemapCrawlerService');
const { crawlSite, __setTestDeps, __resetTestDeps, __resetCaches } = crawler;

const oid = () => new mongoose.Types.ObjectId();
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];

function htmlResp(body) { return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => body }; }
function xmlResp(body) { return { ok: true, status: 200, headers: { get: () => 'application/xml' }, text: async () => body }; }
function notFound() { return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }; }

before(async () => { await connect(); }, { timeout: 120000 });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); __resetTestDeps(); __resetCaches(); __setTestDeps({ resolver: PUBLIC }); });
afterEach(() => { __resetTestDeps(); __resetCaches(); });

// ─── §2 crawl invariants ────────────────────────────────────────────────────────

test('re-crawling a stable site yields all unchanged (0 new, 0 removed) + progress 100', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://stable.test' });
  __setTestDeps({
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://stable.test/') return htmlResp('<title>Home</title><a href="/a">A</a><a href="/b">B</a>');
      return htmlResp('<title>Page</title>');
    },
  });

  await crawlSite(sm._id, { maxPages: 50 });
  await crawlSite(sm._id, { maxPages: 50 });

  const fresh = await Sitemap.findById(sm._id).lean();
  assert.equal(fresh.crawlStatus, 'completed');
  assert.equal(fresh.crawlProgress, 100, 'progress reaches 100 on success');
  assert.equal(fresh.crawlStats.newUrls, 0, 'no new URLs on a stable re-crawl');
  assert.equal(fresh.crawlStats.removedUrls, 0, 'no removed URLs on a stable re-crawl');

  const pages = await CrawlPage.find({ sitemapId: sm._id, diffStatus: { $ne: 'removed' } }).lean();
  assert.equal(pages.length, 3, 'exactly home + /a + /b crawled');
  assert.ok(pages.every((p) => p.diffStatus === 'unchanged'), 'every page is unchanged after the 2nd crawl');
});

test('a crawl never stores more than maxPages pages (bounded) and flags truncation', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://big.test' });
  const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
  __setTestDeps({
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://big.test/') return htmlResp(`<title>Home</title>${links}`);
      return htmlResp('<title>P</title>');
    },
  });

  await crawlSite(sm._id, { maxPages: 3 });

  const count = await CrawlPage.countDocuments({ sitemapId: sm._id, diffStatus: { $ne: 'removed' } });
  assert.equal(count, 3, `stored ${count} pages, must equal maxPages (3)`);
  const fresh = await Sitemap.findById(sm._id).lean();
  assert.equal(fresh.crawlStats.truncated, true, 'truncated flag set when the page cap is hit');
});

// ─── finding I: a concurrent org crawl defers to idle, not error ─────────────────

test('a second concurrent org crawl defers to idle, not error (finding I)', async () => {
  const orgId = oid();
  const now = 1_700_000_000_000;
  await Sitemap.create({ organizationId: orgId, workspaceId: oid(), url: 'https://running.test', crawlStatus: 'crawling' });
  const second = await Sitemap.create({ organizationId: orgId, workspaceId: oid(), url: 'https://second.test' });
  __setTestDeps({ now: () => now, fetchImpl: async () => htmlResp('<title>x</title>') });

  await crawlSite(second._id, { maxPages: 10 });

  const fresh = await Sitemap.findById(second._id).lean();
  assert.notEqual(fresh.crawlStatus, 'error', 'a queue condition must not surface as an error');
  assert.equal(fresh.crawlStatus, 'idle', 'released back to idle');
  assert.equal(new Date(fresh.nextCrawlAt).getTime(), now, 'made due so the next pass retries it');
});

test('the lower-_id crawl proceeds even while a higher-_id org sibling is crawling (finding H1 tiebreaker)', async () => {
  // Deterministic tiebreaker: the lowest _id among the org's crawling sitemaps
  // wins. This is what prevents two concurrently-claimed crawls from BOTH
  // deferring (the starvation livelock). A higher-id sibling crawling must NOT
  // block the lower-id one.
  const orgId = oid();
  const lowId = new mongoose.Types.ObjectId('000000000000000000000001');
  const highId = new mongoose.Types.ObjectId('0000000000000000000000ff');
  await Sitemap.create({ _id: highId, organizationId: orgId, workspaceId: oid(), url: 'https://high.test', crawlStatus: 'crawling' });
  const low = await Sitemap.create({ _id: lowId, organizationId: orgId, workspaceId: oid(), url: 'https://low.test' });
  __setTestDeps({
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://low.test/') return htmlResp('<title>Home</title><a href="/a">A</a>');
      return htmlResp('<title>A</title>');
    },
  });

  await crawlSite(low._id, { maxPages: 10 });

  const fresh = await Sitemap.findById(low._id).lean();
  assert.equal(fresh.crawlStatus, 'completed', 'the lower-_id crawl wins the tiebreak and proceeds');
});

test('a robots.txt listing many Sitemap directives is bounded to MAX_SITEMAP_SEEDS (finding M1)', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://many.test' });
  const directives = Array.from({ length: 30 }, (_, i) => `Sitemap: https://many.test/s${i}.xml`).join('\n');
  const calls = [];
  __setTestDeps({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/robots.txt')) return htmlResp(`User-agent: *\nAllow: /\n${directives}`);
      if (url === 'https://many.test/') return htmlResp('<title>Home</title>');
      return xmlResp('<urlset></urlset>'); // each seed sitemap is empty
    },
  });

  await crawlSite(sm._id, { maxPages: 50 });

  const seedFetches = calls.filter((u) => /\/s\d+\.xml$/.test(u)).length;
  assert.ok(seedFetches <= 10, `only MAX_SITEMAP_SEEDS(10) seed sitemaps fetched (of 30 listed), got ${seedFetches}`);
});

// ─── finding J: failed crawls back off, give up, and reset on success ────────────

// A homepage that returns link-less HTML with no sitemap seeds hits the
// "no internal links" error exit WITHOUT the 3s homepage-retry sleep.
function failingSite(host) {
  return async (url) => {
    if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
    if (url.endsWith('/sitemap.xml')) return notFound();
    if (url === `https://${host}/`) return htmlResp('<title>Empty</title>');
    return notFound();
  };
}

test('the first crawl failure backs off ~6h and increments the failure count (finding J)', async () => {
  const now = 1_700_000_000_000;
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://fail.test' });
  __setTestDeps({ now: () => now, fetchImpl: failingSite('fail.test') });

  await crawlSite(sm._id, { maxPages: 10 });

  const f = await Sitemap.findById(sm._id).lean();
  assert.equal(f.crawlStatus, 'error');
  assert.equal(f.crawlFailCount, 1);
  assert.equal(new Date(f.nextCrawlAt).getTime(), now + 6 * 3600 * 1000, 'first failure → +6h backoff');
});

test('auto-retry is given up after repeated failures (finding J)', async () => {
  const now = 1_700_000_000_000;
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://fail2.test', crawlFailCount: 5 });
  __setTestDeps({ now: () => now, fetchImpl: failingSite('fail2.test') });

  await crawlSite(sm._id, { maxPages: 10 });

  const f = await Sitemap.findById(sm._id).lean();
  assert.equal(f.crawlFailCount, 6);
  assert.equal(f.nextCrawlAt, null, 'nextCrawlAt cleared → cron no longer re-crawls a permanently-broken domain');
});

test('a successful crawl resets the failure counter (finding J)', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://recover.test', crawlFailCount: 3 });
  __setTestDeps({
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://recover.test/') return htmlResp('<title>Home</title><a href="/a">A</a>');
      return htmlResp('<title>A</title>');
    },
  });

  await crawlSite(sm._id, { maxPages: 10 });

  const f = await Sitemap.findById(sm._id).lean();
  assert.equal(f.crawlStatus, 'completed');
  assert.equal(f.crawlFailCount, 0, 'the failure counter resets after a success');
});
