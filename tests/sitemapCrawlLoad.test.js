/**
 * Load/perf budget (plan §6) + metrics observability (plan §12). NIGHTLY tier —
 * heavier than the PR crawler suites. Uses the injectable `delayMs: 0` seam so a
 * large crawl runs without the per-page politeness delay, and asserts the crawl
 * stays bounded and finishes within a wall-clock budget. Also asserts the
 * structured crawl metric is emitted on success and failure.
 *
 *   npm run test:crawler:load
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
const htmlResp = (b) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => b });
const notFound = () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' });

before(async () => { await connect(); }, { timeout: 120000 });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); __resetTestDeps(); __resetCaches(); __setTestDeps({ resolver: PUBLIC, delayMs: 0 }); });
afterEach(() => { __resetTestDeps(); __resetCaches(); });

// ─── §6 load / perf budget ──────────────────────────────────────────────────────

test('a large crawl stays bounded and finishes within the wall-clock budget', { timeout: 60000 }, async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://load.test' });
  const N = 5000; // homepage advertises far more links than the cap allows
  const homepageLinks = Array.from({ length: N }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
  __setTestDeps({
    resolver: PUBLIC, delayMs: 0,
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://load.test/') return htmlResp(`<title>Home</title>${homepageLinks}`);
      return htmlResp('<title>P</title>');
    },
  });

  const maxPages = 2000;
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  await crawlSite(sm._id, { maxPages });
  const elapsedMs = Date.now() - t0;
  const heapDeltaMb = (process.memoryUsage().heapUsed - memBefore) / 1024 / 1024;

  const count = await CrawlPage.countDocuments({ sitemapId: sm._id, diffStatus: { $ne: 'removed' } });
  const fresh = await Sitemap.findById(sm._id).lean();

  assert.equal(count, maxPages, `stored pages must be bounded to maxPages; got ${count}`);
  assert.equal(fresh.crawlStats.truncated, true, 'truncated flag set when the link graph exceeds the cap');
  assert.ok(elapsedMs < 45000, `crawl of ${maxPages} pages took ${elapsedMs}ms (budget 45s)`);
  console.log(`[load] crawled ${maxPages} pages in ${elapsedMs}ms, heap +${heapDeltaMb.toFixed(1)}MB`);
});

test('a crawl does not retain page bodies in memory (buffers-full-HTML regression guard)', { timeout: 60000 }, async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://mem.test' });
  const N = 400;
  const filler = 'x'.repeat(256 * 1024); // 256KB per page → ~100MB of bodies served in total
  const homepageLinks = Array.from({ length: N }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
  __setTestDeps({
    resolver: PUBLIC, delayMs: 0,
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://mem.test/') return htmlResp(`<title>Home</title>${homepageLinks}`);
      // A distinct ~256KB body per page. The crawler must discard it after extracting
      // the title + links — if it retained bodies, heap would grow by ~N*256KB.
      return htmlResp(`<title>${url}</title><p>${filler}${url}</p>`);
    },
  });

  if (global.gc) global.gc();
  const memBefore = process.memoryUsage().heapUsed;
  await crawlSite(sm._id, { maxPages: N + 10 }); // crawl all N (no truncation)
  if (global.gc) global.gc();
  const heapDeltaMb = (process.memoryUsage().heapUsed - memBefore) / 1024 / 1024;

  const count = await CrawlPage.countDocuments({ sitemapId: sm._id, diffStatus: { $ne: 'removed' } });
  assert.ok(count >= N, `all ${N} pages must be crawled; got ${count}`);
  console.log(`[load] ${N} pages @256KB bodies (~${(N * 256 / 1024).toFixed(0)}MB served) → retained heap +${heapDeltaMb.toFixed(1)}MB`);

  // Gate the memory ceiling only when GC is exposed (npm run test:crawler:load passes
  // --expose-gc); otherwise heap deltas are too noisy to assert. ~100MB of bodies were
  // served; retained heap must be a small fraction — a buffering regression would blow past 50MB.
  if (typeof global.gc === 'function') {
    assert.ok(heapDeltaMb < 50, `retained heap grew ${heapDeltaMb.toFixed(1)}MB — the crawler may be buffering page bodies`);
  } else {
    console.log('[load] memory ceiling NOT asserted — re-run with --expose-gc to gate it');
  }
});

// ─── §12 metrics observability ───────────────────────────────────────────────────

test('a completed crawl emits a structured sitemap.crawl metric', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://m.test' });
  const metrics = [];
  __setTestDeps({
    resolver: PUBLIC, delayMs: 0, onMetric: (m) => metrics.push(m),
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://m.test/') return htmlResp('<title>Home</title><a href="/a">A</a><a href="/b">B</a>');
      return htmlResp('<title>P</title>');
    },
  });

  await crawlSite(sm._id, { maxPages: 10 });

  assert.equal(metrics.length, 1, 'exactly one metric per crawl');
  const m = metrics[0];
  assert.equal(m.event, 'sitemap.crawl');
  assert.equal(m.status, 'completed');
  assert.equal(String(m.sitemapId), String(sm._id));
  assert.equal(String(m.workspaceId), String(sm.workspaceId));
  assert.ok(m.pagesFound >= 3, `pagesFound should count home + /a + /b; got ${m.pagesFound}`);
  assert.equal(typeof m.durationMs, 'number');
});

test('a failed crawl emits an error metric tagged with the reason', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://mf.test' });
  const metrics = [];
  __setTestDeps({
    resolver: PUBLIC, delayMs: 0, onMetric: (m) => metrics.push(m),
    fetchImpl: async (url) => {
      if (url.endsWith('/robots.txt')) return htmlResp('User-agent: *\nAllow: /');
      if (url.endsWith('/sitemap.xml')) return notFound();
      if (url === 'https://mf.test/') return htmlResp('<title>Empty</title>'); // link-less → no_internal_links
      return notFound();
    },
  });

  await crawlSite(sm._id, { maxPages: 10 });

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 'error');
  assert.equal(metrics[0].reason, 'no_internal_links');
});
