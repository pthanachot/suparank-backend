// @ts-check
/**
 * Backend crawler mutation (Phase 6 §9). Scoped to the crawler's PURE logic — the
 * §9-named targets (robots parser, normalizeUrl, link/URL helpers, backoff, XML
 * generation) — run against the fast, no-DB `test:crawler` suite via the command
 * runner. crawlSite's DB-heavy body (incl. the diff) is intentionally EXCLUDED: it
 * needs the in-memory-Mongo suite per mutant, which is a slow nightly-only job.
 * Line ranges track src/services/sitemapCrawlerService.js — re-check if it moves.
 *
 *   npx stryker run     (Node 20.12+ / 22 — Stryker deps use node:util.styleText;
 *                        the child `npm run test:crawler` inherits the same node)
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: "command",
  commandRunner: { command: "npm run test:crawler" },
  reporters: ["clear-text", "progress"],
  mutate: [
    "src/services/sitemapCrawlerService.js:173-250",  // parseRobotsTxt + isAllowedByRobots
    "src/services/sitemapCrawlerService.js:333-465",  // normalizeUrl + isSameDomain + shouldSkipUrl + extractLinksAndTitle
    "src/services/sitemapCrawlerService.js:531-535",  // backoffNextCrawl
    "src/services/sitemapCrawlerService.js:968-995",  // generateSitemapXml + escapeXml
  ],
  thresholds: { high: 85, low: 70, break: null }, // report-only for now; wire a break gate in nightly CI
};
