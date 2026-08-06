/**
 * Property/invariant tests for the sitemap crawler's pure functions (plan §2).
 * Uses fast-check to assert invariants that must hold for ALL inputs, not just
 * the hand-picked examples in sitemapCrawler.test.js.
 *
 *   node --test tests/sitemapProperties.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const cheerio = require('cheerio');

const { generateSitemapXml, _internals } = require('../src/services/sitemapCrawlerService');
const { normalizeUrl } = _internals;

test('normalizeUrl is idempotent — normalizing a normalized URL is a no-op', () => {
  fc.assert(fc.property(fc.webUrl(), (u) => {
    const n1 = normalizeUrl(u, u);
    if (n1 === null) return true; // fc.webUrl is always parseable, but be defensive
    return normalizeUrl(n1, n1) === n1;
  }));
});

test('normalizeUrl always returns a parseable absolute URL (or null)', () => {
  fc.assert(fc.property(fc.webUrl(), (u) => {
    const n = normalizeUrl(u, u);
    if (n === null) return true;
    new URL(n); // throws if not absolute/parseable → property fails
    return true;
  }));
});

test('generateSitemapXml is always well-formed and preserves the loc count', () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.webUrl({ withQueryParameters: true }), { minLength: 1, maxLength: 25 }),
    (urls) => {
      const pages = urls.map((u) => ({ url: u, lastmod: '2026-01-01', changefreq: 'weekly', priority: 0.5 }));
      const xml = generateSitemapXml(pages);
      const $ = cheerio.load(xml, { xmlMode: true });
      const locs = $('urlset url loc');
      return locs.length === urls.length;
    },
  ));
});

test('generateSitemapXml escapes XML metacharacters so URLs round-trip exactly', () => {
  // A URL carrying every character escapeXml handles must survive generate→parse.
  const tricky = 'https://x.test/p?a=1&b=2&q=<x>&t="q"&z=\'s\'';
  const xml = generateSitemapXml([{ url: tricky, lastmod: '2026-01-01', changefreq: 'weekly', priority: 1.0 }]);
  // Raw (unescaped) metacharacters must not appear in the element body.
  const body = xml.slice(xml.indexOf('<loc>') + 5, xml.indexOf('</loc>'));
  assert.ok(!/[<>]/.test(body), 'no raw angle brackets in <loc>');
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(body), 'every & is a proper entity');
  // And it decodes back to the original URL.
  const $ = cheerio.load(xml, { xmlMode: true });
  assert.equal($('urlset url loc').first().text(), tricky);
});
