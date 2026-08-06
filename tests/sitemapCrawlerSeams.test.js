/**
 * Phase 1 seam validation for the sitemap crawler.
 *
 * Proves the test seams added in SITE-SITEMAP-TEST-PLAN.md §0 actually work:
 * every network fetch is interceptable, the clock is injectable, DNS resolution
 * is injectable, and module-global caches can be reset between cases. These
 * exercise the low-level fetchers directly (no Mongo) — full crawlSite()
 * integration lands with mongodb-memory-server in Phase 2.
 *
 *   node --test tests/sitemapCrawlerSeams.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const crawler = require('../src/services/sitemapCrawlerService');
const { __setTestDeps, __resetTestDeps, __resetCaches, _internals } = crawler;
const { httpGet, fetchRobotsTxt, fetchSitemapXml, fetchPage, resolveHost, nowMs } = _internals;

/** Minimal stand-in for a fetch Response covering the fields the crawler reads. */
function mockResponse({ status = 200, body = '', contentType = 'text/html' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

beforeEach(() => {
  __resetTestDeps();
  __resetCaches();
  // The SSRF guard resolves each host before fetching; give the seam a public
  // answer so these seam tests (which use .test hostnames) aren't blocked.
  __setTestDeps({ resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
});
afterEach(() => { __resetTestDeps(); __resetCaches(); });

// ─── egress ──────────────────────────────────────────────────────────────────

test('httpGet routes through injected fetchImpl and injects the dispatcher once', async () => {
  const calls = [];
  const marker = { id: 'mock-dispatcher' };
  __setTestDeps({
    dispatcher: marker,
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return mockResponse({ body: 'ok' }); },
  });

  const res = await httpGet('https://example.com/x', { headers: { A: '1' } });

  assert.equal(await res.text(), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/x');
  assert.equal(calls[0].opts.headers.A, '1');
  assert.equal(calls[0].opts.dispatcher, marker);
});

test('every fetcher is fully intercepted — no real network escapes', async () => {
  __setTestDeps({
    fetchImpl: async (url) => {
      if (url === 'https://site.test/robots.txt') {
        return mockResponse({ body: 'User-agent: *\nDisallow: /private\nSitemap: https://site.test/sitemap.xml' });
      }
      throw new Error(`unexpected network call to ${url}`);
    },
  });

  const parsed = await fetchRobotsTxt('https://site.test');

  assert.deepEqual(parsed.rules, [{ allow: false, path: '/private' }]);
  assert.deepEqual(parsed.sitemapUrls, ['https://site.test/sitemap.xml']);
});

// ─── clock + cache reset ───────────────────────────────────────────────────────

test('robots cache honors the injectable clock, and __resetCaches clears it', async () => {
  let fetchCount = 0;
  let clock = 1_000_000;
  __setTestDeps({
    now: () => clock,
    fetchImpl: async () => { fetchCount++; return mockResponse({ body: 'User-agent: *\nDisallow: /x' }); },
  });

  await fetchRobotsTxt('https://c.test');
  await fetchRobotsTxt('https://c.test');            // within 24h TTL → served from cache
  assert.equal(fetchCount, 1);

  clock += 25 * 60 * 60 * 1000;                        // advance past the 24h TTL
  await fetchRobotsTxt('https://c.test');             // expired → refetch
  assert.equal(fetchCount, 2);

  __resetCaches();
  await fetchRobotsTxt('https://c.test');             // cache cleared → refetch
  assert.equal(fetchCount, 3);
});

// ─── sitemap.xml parsing through the seam ──────────────────────────────────────

test('fetchSitemapXml parses a urlset, filters off-domain, and honors maxUrls', async () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://d.test/a</loc></url>
    <url><loc>https://d.test/b</loc></url>
    <url><loc>https://other.test/c</loc></url>
  </urlset>`;
  __setTestDeps({ fetchImpl: async () => mockResponse({ body: xml, contentType: 'application/xml' }) });

  const urls = await fetchSitemapXml('https://d.test/sitemap.xml', 'd.test', 50);
  assert.deepEqual(urls.sort(), ['https://d.test/a', 'https://d.test/b']);

  const capped = await fetchSitemapXml('https://d.test/sitemap.xml', 'd.test', 1);
  assert.equal(capped.length, 1);
});

test('fetchSitemapXml recurses into a sitemap index', async () => {
  const index = '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://i.test/child.xml</loc></sitemap></sitemapindex>';
  const child = '<?xml version="1.0"?><urlset><url><loc>https://i.test/page</loc></url></urlset>';
  __setTestDeps({
    fetchImpl: async (url) => {
      if (url === 'https://i.test/sitemap.xml') return mockResponse({ body: index, contentType: 'application/xml' });
      if (url === 'https://i.test/child.xml') return mockResponse({ body: child, contentType: 'application/xml' });
      throw new Error(`unexpected ${url}`);
    },
  });

  const urls = await fetchSitemapXml('https://i.test/sitemap.xml', 'i.test', 50);
  assert.deepEqual(urls, ['https://i.test/page']);
});

// ─── page fetch through the seam ───────────────────────────────────────────────

test('fetchPage returns HTML for text/html and null html for other content types', async () => {
  __setTestDeps({
    fetchImpl: async (url) => (url.endsWith('/html')
      ? mockResponse({ status: 200, body: '<title>Hi</title>', contentType: 'text/html' })
      : mockResponse({ status: 200, body: '{}', contentType: 'application/json' })),
  });

  const ok = await fetchPage('https://p.test/html');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.html, /Hi/);

  const nonHtml = await fetchPage('https://p.test/data.json');
  assert.equal(nonHtml.statusCode, 200);
  assert.equal(nonHtml.html, null);
});

// ─── DNS resolver seam (for the Phase 3 SSRF guard) ────────────────────────────

test('resolveHost uses the injectable resolver', async () => {
  __setTestDeps({ resolver: async (host) => [{ address: '10.0.0.5', family: 4, host }] });

  const res = await resolveHost('internal.test');
  assert.equal(res[0].address, '10.0.0.5');
  assert.equal(res[0].host, 'internal.test');
});

// ─── restore ───────────────────────────────────────────────────────────────────

test('__resetTestDeps restores default deps', () => {
  __setTestDeps({ now: () => 42 });
  assert.equal(nowMs(), 42);

  __resetTestDeps();
  assert.notEqual(nowMs(), 42); // back to real Date.now()
});
