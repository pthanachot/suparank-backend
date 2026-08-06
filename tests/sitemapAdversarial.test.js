/**
 * Adversarial corpus for the sitemap crawler's parsers/fetchers (plan §3).
 * Hostile, malformed, and abusive inputs — the crawler's inputs are attacker-
 * controlled (a target site's robots.txt / sitemap.xml / HTML). NO real network:
 * egress goes through the injected fetchImpl seam, with a public resolver so the
 * SSRF guard doesn't block the test hostnames. Also covers finding G (bounded
 * sitemapindex expansion).
 *
 *   node --test tests/sitemapAdversarial.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const crawler = require('../src/services/sitemapCrawlerService');
const { __setTestDeps, __resetTestDeps, __resetCaches, _internals } = crawler;
const { fetchSitemapXml, parseRobotsTxt, extractLinksAndTitle, fetchPage, backoffNextCrawl, MAX_SITEMAP_DOCS, MAX_SITEMAP_DEPTH } = _internals;

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
function xml(body) { return { ok: true, status: 200, headers: { get: () => 'application/xml' }, text: async () => body }; }
function resp(status, body, ct = 'text/html') {
  return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) }, text: async () => body };
}

beforeEach(() => { __resetTestDeps(); __resetCaches(); __setTestDeps({ resolver: PUBLIC }); });
afterEach(() => { __resetTestDeps(); __resetCaches(); });

// ─── fetchSitemapXml robustness ────────────────────────────────────────────────

test('malformed/unclosed XML does not throw', async () => {
  __setTestDeps({ fetchImpl: async () => xml('<urlset><url><loc>https://x.test/a</loc>') });
  const urls = await fetchSitemapXml('https://x.test/sitemap.xml', 'x.test', 50);
  assert.ok(Array.isArray(urls));
});

test('HTML served where XML is expected yields no URLs', async () => {
  __setTestDeps({ fetchImpl: async () => xml('<!doctype html><html><body><a href="/a">a</a></body></html>') });
  assert.deepEqual(await fetchSitemapXml('https://x.test/sitemap.xml', 'x.test', 50), []);
});

test('empty urlset yields no URLs', async () => {
  __setTestDeps({ fetchImpl: async () => xml('<urlset></urlset>') });
  assert.deepEqual(await fetchSitemapXml('https://x.test/sitemap.xml', 'x.test', 50), []);
});

test('off-domain <loc> entries are filtered out', async () => {
  __setTestDeps({ fetchImpl: async () => xml('<urlset><url><loc>https://x.test/a</loc></url><url><loc>https://evil.test/b</loc></url></urlset>') });
  assert.deepEqual(await fetchSitemapXml('https://x.test/sitemap.xml', 'x.test', 50), ['https://x.test/a']);
});

test('maxUrls caps the number of extracted URLs', async () => {
  const many = Array.from({ length: 100 }, (_, i) => `<url><loc>https://x.test/p${i}</loc></url>`).join('');
  __setTestDeps({ fetchImpl: async () => xml(`<urlset>${many}</urlset>`) });
  const urls = await fetchSitemapXml('https://x.test/sitemap.xml', 'x.test', 10);
  assert.equal(urls.length, 10);
});

// ─── finding G: hostile sitemapindex must be bounded ────────────────────────────

test('a sitemapindex with hundreds of children fetches at most MAX_SITEMAP_DOCS (finding G)', async () => {
  const children = Array.from({ length: 500 }, (_, i) => `<sitemap><loc>https://x.test/s${i}.xml</loc></sitemap>`).join('');
  const calls = [];
  __setTestDeps({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://x.test/index.xml') return xml(`<sitemapindex>${children}</sitemapindex>`);
      return xml('<urlset></urlset>'); // children carry no in-domain URLs → old code fetched all 500
    },
  });
  await fetchSitemapXml('https://x.test/index.xml', 'x.test', 5000);
  assert.ok(calls.length <= MAX_SITEMAP_DOCS, `fetched ${calls.length} docs, must be <= ${MAX_SITEMAP_DOCS}`);
});

test('a cyclic sitemapindex terminates (finding G)', async () => {
  const calls = [];
  __setTestDeps({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://x.test/a.xml') return xml('<sitemapindex><sitemap><loc>https://x.test/b.xml</loc></sitemap></sitemapindex>');
      if (url === 'https://x.test/b.xml') return xml('<sitemapindex><sitemap><loc>https://x.test/a.xml</loc></sitemap></sitemapindex>');
      return xml('<urlset></urlset>');
    },
  });
  await fetchSitemapXml('https://x.test/a.xml', 'x.test', 5000);
  assert.ok(calls.length <= 3, `cycle must terminate quickly via the visited set; fetched ${calls.length}`);
});

test('a deeply-nested sitemapindex chain is depth-bounded (finding G)', async () => {
  const calls = [];
  __setTestDeps({
    fetchImpl: async (url) => {
      calls.push(url);
      const m = url.match(/n(\d+)\.xml$/);
      const n = m ? Number(m[1]) : 0;
      return xml(`<sitemapindex><sitemap><loc>https://x.test/n${n + 1}.xml</loc></sitemap></sitemapindex>`);
    },
  });
  await fetchSitemapXml('https://x.test/n0.xml', 'x.test', 5000);
  // Pin the DEPTH cap specifically (not just the doc cap): depths 0..MAX_SITEMAP_DEPTH
  // are fetched, the next is refused → MAX_SITEMAP_DEPTH + 1 docs.
  assert.equal(calls.length, MAX_SITEMAP_DEPTH + 1, `depth cap must bound the chain to ${MAX_SITEMAP_DEPTH + 1} fetches`);
});

test('sitemapindex children on another domain are not fetched (finding M2)', async () => {
  const calls = [];
  __setTestDeps({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://x.test/index.xml') {
        return xml('<sitemapindex><sitemap><loc>https://evil.test/s.xml</loc></sitemap><sitemap><loc>https://x.test/ok.xml</loc></sitemap></sitemapindex>');
      }
      if (url === 'https://x.test/ok.xml') return xml('<urlset><url><loc>https://x.test/a</loc></url></urlset>');
      return xml('<urlset></urlset>');
    },
  });
  const urls = await fetchSitemapXml('https://x.test/index.xml', 'x.test', 50);
  assert.ok(!calls.includes('https://evil.test/s.xml'), 'must NOT fetch an off-domain child sitemap');
  assert.deepEqual(urls, ['https://x.test/a'], 'the same-domain child is still followed');
});

test('backoffNextCrawl follows the documented schedule then gives up (finding J)', () => {
  const now = 1_000_000_000_000;
  __setTestDeps({ now: () => now });
  const hrs = (f) => { const d = backoffNextCrawl(f); return d === null ? null : Math.round((d.getTime() - now) / 3600000); };
  assert.deepEqual([hrs(1), hrs(2), hrs(3), hrs(4), hrs(5)], [6, 12, 24, 48, 96]);
  assert.equal(backoffNextCrawl(6), null, 'gives up auto-retry at 6 failures');
  assert.equal(backoffNextCrawl(7), null);
});

// ─── parseRobotsTxt robustness (pure) ───────────────────────────────────────────

test('parseRobotsTxt handles a UTF-8 BOM and CRLF line endings', () => {
  const BOM = '﻿';
  const { rules } = parseRobotsTxt(`${BOM}User-agent: *\r\nDisallow: /admin\r\n`);
  assert.deepEqual(rules, [{ allow: false, path: '/admin' }]);
});

test('parseRobotsTxt ignores comments and blank lines', () => {
  const { rules } = parseRobotsTxt('# comment\n\nUser-agent: *\n\n  Disallow: /x  \n');
  assert.deepEqual(rules, [{ allow: false, path: '/x' }]);
});

// ─── extractLinksAndTitle robustness (pure) ─────────────────────────────────────

test('extractLinksAndTitle drops off-domain, nofollow, and mailto/tel links', () => {
  const html = `<title>T</title>
    <a href="/in">in</a>
    <a href="https://evil.test/out">out</a>
    <a href="/nf" rel="nofollow">nf</a>
    <a href="mailto:x@y.z">mail</a>
    <a href="tel:+123">call</a>`;
  const { title, links } = extractLinksAndTitle(html, 'https://x.test/', 'x.test');
  assert.equal(title, 'T');
  assert.deepEqual(links, ['https://x.test/in']);
});

test('extractLinksAndTitle returns empty for link-less/title-less HTML', () => {
  const { title, links } = extractLinksAndTitle('<html><body><p>hi</p></body></html>', 'https://x.test/', 'x.test');
  assert.equal(title, '');
  assert.deepEqual(links, []);
});

// ─── fetchPage content gating ───────────────────────────────────────────────────

test('fetchPage returns null html for non-HTML content types', async () => {
  __setTestDeps({ fetchImpl: async () => resp(200, '{}', 'application/json') });
  const r = await fetchPage('https://x.test/data');
  assert.equal(r.html, null);
  assert.equal(r.statusCode, 200);
});

test('fetchPage surfaces a 503-with-HTML status (crawl ok-check excludes it)', async () => {
  __setTestDeps({ fetchImpl: async () => resp(503, '<title>err</title>', 'text/html') });
  const r = await fetchPage('https://x.test/down');
  assert.equal(r.statusCode, 503);
});
