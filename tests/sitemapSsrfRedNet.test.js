/**
 * SSRF regression tests for the sitemap crawler (findings A & B2). NO DATABASE.
 *
 * Originally a Phase 2 red-net (all `{ todo }`); Phase 3 added the egress guard
 * (src/services/ssrfGuard.js, wired into httpGet via the resolver seam) so these
 * are now enforcing. See SITE-SITEMAP-TEST-PLAN.md §4.
 *
 * The guard: (1) covers every crawl fetch — tests drive the real callers
 * (fetchPage, fetchSitemapXml); (2) resolves hostnames via deps.resolver, never
 * real DNS; (3) decodes IPv4-mapped IPv6 in its normalized hex form; (4) fails
 * closed on resolution failure.
 *
 *   node --test tests/sitemapSsrfRedNet.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const crawler = require('../src/services/sitemapCrawlerService');
const { __setTestDeps, __resetTestDeps, __resetCaches, _internals } = crawler;
const { fetchPage, fetchSitemapXml } = _internals;

function mockResponse({ status = 200, body = '', contentType = 'text/html' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

/** A fetch stand-in that records every URL it is asked to fetch. */
function recordingFetch(body = '') {
  const calls = [];
  const fn = async (url) => { calls.push(url); return mockResponse({ body }); };
  return { fn, calls };
}

beforeEach(() => { __resetTestDeps(); __resetCaches(); });
afterEach(() => { __resetTestDeps(); __resetCaches(); });

// ─── A: literal private / metadata / loopback IPs (no DNS needed) ──────────────
// Driven through fetchPage (a real crawl egress path) so the assertion holds
// whether the guard lives in httpGet or in fetchPage. fetchPage swallows a guard
// rejection internally, so "blocked" is observable purely as "no outbound call".

const LITERAL_BLOCKED = [
  ['cloud metadata (link-local)', 'http://169.254.169.254/latest/meta-data/'],
  ['IPv4 loopback', 'http://127.0.0.1/'],
  ['private RFC1918 (10.x)', 'http://10.0.0.5/'],
  ['private RFC1918 (172.16)', 'http://172.16.0.1/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]/'],
];

for (const [label, url] of LITERAL_BLOCKED) {
  test(`SSRF: ${label} is not fetched during a page crawl (finding A)`, async () => {
    const { fn, calls } = recordingFetch();
    __setTestDeps({ fetchImpl: fn });
    await fetchPage(url);
    assert.deepEqual(calls, [], `expected NO outbound request to ${url}`);
  });
}

// ─── A: a hostname that RESOLVES to a private IP (exercises the resolver seam) ──

test('SSRF: a hostname resolving to a private IP is not fetched (finding A)', async () => {
  const { fn, calls } = recordingFetch();
  __setTestDeps({
    fetchImpl: fn,
    resolver: async () => [{ address: '10.1.2.3', family: 4 }], // guard MUST consult this
  });
  await fetchPage('http://internal.corp.test/');
  assert.deepEqual(calls, [], 'a host resolving to 10.x must not be fetched');
});

// ─── B2: a robots.txt Sitemap: directive pointing at a private host ────────────

test('SSRF: a Sitemap: directive to a private host is not fetched (finding B2)', async () => {
  const { fn, calls } = recordingFetch('<urlset></urlset>');
  __setTestDeps({ fetchImpl: fn });
  // fetchSitemapXml is what crawlSite calls for each robots Sitemap: directive.
  await fetchSitemapXml('http://169.254.169.254/sitemap.xml', 'example.com', 50);
  assert.deepEqual(calls, [], 'a Sitemap: directive to a metadata IP must not be fetched');
});

// ─── Controls — a genuine public host MUST still be crawled (no over-blocking) ──

test('control: a public IP literal is still fetched (no over-blocking)', async () => {
  const { fn, calls } = recordingFetch();
  __setTestDeps({ fetchImpl: fn });
  await fetchPage('http://93.184.216.34/');
  assert.deepEqual(calls, ['http://93.184.216.34/'], 'a public IP must be fetched');
});

test('control: a public hostname resolved via the seam is fetched (guard must use the resolver seam)', async () => {
  const { fn, calls } = recordingFetch();
  __setTestDeps({
    fetchImpl: fn,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }], // public
  });
  await fetchPage('http://scan-target.test/');
  assert.deepEqual(calls, ['http://scan-target.test/'], 'a public host (resolved via the seam) must be fetched');
});

// ─── Redirect re-validation (finding A — HIGH; a public host 302→private) ───────

function redirectResponse(location) {
  return { ok: false, status: 302, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) }, text: async () => '' };
}

test('SSRF: a public host that redirects to a private IP is not followed (redirect re-validation)', async () => {
  const calls = [];
  __setTestDeps({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }], // evil.test is "public"
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'http://evil.test/') return redirectResponse('http://169.254.169.254/latest/meta-data/');
      return mockResponse({ body: 'SHOULD NOT REACH' });
    },
  });
  await fetchPage('http://evil.test/');
  assert.deepEqual(calls, ['http://evil.test/'], 'the private redirect target must never be fetched');
});

test('control: a redirect chain to a public host IS followed (legit redirects still work)', async () => {
  const calls = [];
  __setTestDeps({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'http://start.test/') return redirectResponse('http://dest.test/');
      return mockResponse({ body: '<title>Dest</title>' });
    },
  });
  const res = await fetchPage('http://start.test/');
  assert.deepEqual(calls, ['http://start.test/', 'http://dest.test/'], 'a public redirect chain must be followed');
  assert.match(res.html || '', /Dest/, 'the final page content is returned');
});
