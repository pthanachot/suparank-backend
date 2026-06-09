/**
 * Sitemap crawler regression fixtures.
 *
 * Each case below corresponds to a real edge case we discovered in production
 * during smoke testing. Adding new cases here when bugs are found prevents
 * the same class of bug from re-shipping.
 *
 * Tests use Node's built-in test runner — no external test deps.
 *   node --test tests/sitemapCrawler.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../src/services/sitemapCrawlerService');
const { normalizeUrl, shouldSkipUrl, extractLinksAndTitle, isSameDomain } = _internals;

// ─── normalizeUrl ──────────────────────────────────────────────────────────

test('normalizeUrl strips trailing slash on non-root paths', () => {
  assert.equal(
    normalizeUrl('https://example.com/about/', 'https://example.com'),
    'https://example.com/about',
  );
});

test('normalizeUrl preserves the root slash (so seed and discovered root match)', () => {
  // Both forms should normalize to the same canonical form.
  // This was the BUG #1 root cause: controller stripped to 'example.com'
  // while crawler discovered 'example.com/' — they disagreed.
  const a = normalizeUrl('https://example.com', 'https://example.com');
  const b = normalizeUrl('https://example.com/', 'https://example.com');
  assert.equal(a, b);
});

test('normalizeUrl resolves relative paths against base', () => {
  assert.equal(
    normalizeUrl('articles.html', 'https://example.com/'),
    'https://example.com/articles.html',
  );
});

test('normalizeUrl strips fragments', () => {
  assert.equal(
    normalizeUrl('https://example.com/page#section', 'https://example.com'),
    'https://example.com/page',
  );
});

test('normalizeUrl returns null on truly invalid input', () => {
  // Empty href with empty base — new URL() throws "Invalid URL".
  // (Random strings get URL-encoded against the base, which is by design.)
  assert.equal(normalizeUrl('', ''), null);
});

// ─── Same-domain scheme upgrade (Follow-up #1) ─────────────────────────────

test('normalizeUrl upgrades same-domain http→https when origin is https', () => {
  // Smoking gun: github.com had `http://github.com/features/ai` in results
  // despite the seed being https. With baseDomain + originScheme, the http
  // version gets canonicalized to match the seed.
  assert.equal(
    normalizeUrl('http://example.com/page', 'https://example.com', 'example.com', 'https:'),
    'https://example.com/page',
  );
});

test('normalizeUrl upgrades same-domain http→https for subdomains', () => {
  assert.equal(
    normalizeUrl('http://blog.example.com/post', 'https://example.com', 'example.com', 'https:'),
    'https://blog.example.com/post',
  );
});

test('normalizeUrl does NOT upgrade http→https for off-domain URLs', () => {
  // Leave other-domain links alone — they may genuinely only support http.
  assert.equal(
    normalizeUrl('http://attacker.com/x', 'https://example.com', 'example.com', 'https:'),
    'http://attacker.com/x',
  );
});

test('normalizeUrl does NOT upgrade when origin is http (no signal)', () => {
  // If the seed is http, we have no evidence the site supports https, so
  // leave http URLs alone.
  assert.equal(
    normalizeUrl('http://example.com/x', 'http://example.com', 'example.com', 'http:'),
    'http://example.com/x',
  );
});

test('normalizeUrl is backward-compatible — 2-arg form unchanged', () => {
  // All existing call sites and tests pre-Follow-up #1 only pass 2 args.
  // Without baseDomain/originScheme, the scheme upgrade is silently skipped.
  assert.equal(
    normalizeUrl('http://example.com/x', 'https://example.com'),
    'http://example.com/x',
  );
});

// ─── shouldSkipUrl ─────────────────────────────────────────────────────────

test('shouldSkipUrl filters CDN protection paths (BUG #2 fix)', () => {
  assert.equal(shouldSkipUrl('https://example.com/cdn-cgi/l/email-protection'), true);
});

test('shouldSkipUrl filters WordPress admin paths', () => {
  assert.equal(shouldSkipUrl('https://example.com/wp-admin/edit.php'), true);
  assert.equal(shouldSkipUrl('https://example.com/wp-json/wp/v2/posts'), true);
  assert.equal(shouldSkipUrl('https://example.com/wp-login.php'), true);
});

test('shouldSkipUrl filters .well-known and xmlrpc', () => {
  assert.equal(shouldSkipUrl('https://example.com/.well-known/security.txt'), true);
  assert.equal(shouldSkipUrl('https://example.com/xmlrpc.php'), true);
});

test('shouldSkipUrl filters non-http(s) protocols', () => {
  assert.equal(shouldSkipUrl('mailto:hi@example.com'), true);
  assert.equal(shouldSkipUrl('tel:+1234567890'), true);
  assert.equal(shouldSkipUrl('javascript:void(0)'), true);
});

test('shouldSkipUrl allows normal article paths', () => {
  assert.equal(shouldSkipUrl('https://example.com/articles.html'), false);
  assert.equal(shouldSkipUrl('https://example.com/about'), false);
});

test('shouldSkipUrl filters binary file extensions', () => {
  // From the SKIP_EXTENSIONS set: images, archives, etc. Don't index in sitemap.
  assert.equal(shouldSkipUrl('https://example.com/photo.jpg'), true);
  assert.equal(shouldSkipUrl('https://example.com/file.pdf'), true);
});

// ─── isSameDomain ──────────────────────────────────────────────────────────

test('isSameDomain matches exact hostname', () => {
  assert.equal(isSameDomain('https://example.com/path', 'example.com'), true);
});

test('isSameDomain matches subdomain', () => {
  assert.equal(isSameDomain('https://blog.example.com/path', 'example.com'), true);
});

test('isSameDomain rejects different domain', () => {
  assert.equal(isSameDomain('https://attacker.com/path', 'example.com'), false);
});

// ─── extractLinksAndTitle ──────────────────────────────────────────────────

test('extractLinksAndTitle pulls href from <a> tags', () => {
  const html = '<html><head><title>T</title></head><body>'
    + '<a href="/about">About</a>'
    + '<a href="/contact">Contact</a>'
    + '</body></html>';
  const { title, links } = extractLinksAndTitle(html, 'https://example.com/', 'example.com');
  assert.equal(title, 'T');
  assert.equal(links.length, 2);
});

test('extractLinksAndTitle pulls href from <area> tags (BUG #11 fix)', () => {
  // paulgraham.com-style: image-map nav lives in <area href>, not <a href>.
  const html = '<html><body>'
    + '<map name="nav">'
    + '<area href="articles.html" shape="rect">'
    + '<area href="books.html" shape="rect">'
    + '</map></body></html>';
  const { links } = extractLinksAndTitle(html, 'https://example.com/', 'example.com');
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.endsWith('/articles.html')));
  assert.ok(links.some((l) => l.endsWith('/books.html')));
});

test('extractLinksAndTitle honors rel="nofollow" (BUG #2 fix part 2)', () => {
  // Cloudflare email-protection and ads wrap links with rel="nofollow".
  const html = '<html><body>'
    + '<a href="/real-page">Real</a>'
    + '<a href="/ad" rel="nofollow sponsored">Ad</a>'
    + '<a href="/email" rel="nofollow">Email</a>'
    + '</body></html>';
  const { links } = extractLinksAndTitle(html, 'https://example.com/', 'example.com');
  assert.equal(links.length, 1);
  assert.ok(links[0].endsWith('/real-page'));
});

test('extractLinksAndTitle filters off-domain links', () => {
  const html = '<a href="https://example.com/internal">i</a>'
    + '<a href="https://other.com/external">e</a>';
  const { links } = extractLinksAndTitle(html, 'https://example.com/', 'example.com');
  assert.equal(links.length, 1);
  assert.ok(links[0].endsWith('/internal'));
});

test('extractLinksAndTitle deduplicates same URL appearing multiple times', () => {
  const html = '<a href="/about">a</a><a href="/about/">b</a><a href="/about">c</a>';
  const { links } = extractLinksAndTitle(html, 'https://example.com/', 'example.com');
  // /about and /about/ should both normalize to /about — only one entry.
  assert.equal(links.length, 1);
});

test('extractLinksAndTitle returns empty links for content with no <a> or <area>', () => {
  // BUG #3 trigger: this is the input that would make the crawler stop with
  // a misleading "completed" status. The crawler's check fires only if BOTH
  // this returns 0 links AND sitemap.xml seeding yielded 0.
  const html = '<html><body><h1>Just text, no nav</h1></body></html>';
  const { links } = extractLinksAndTitle(html, 'https://example.com/', 'example.com');
  assert.equal(links.length, 0);
});
