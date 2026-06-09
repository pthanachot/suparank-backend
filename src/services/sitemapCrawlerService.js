/**
 * Sitemap Crawler Service
 *
 * BFS crawl from a homepage URL, discover all internal pages,
 * compare with approved baseline, and generate sitemap XML.
 *
 * Features:
 * - robots.txt compliance (fetch, cache, obey Disallow/Allow)
 * - Crawl depth tracking (BFS level per page)
 * - Response time tracking (TTFB per fetch)
 * - Sitemap.xml seeding (parse existing sitemap to discover pages)
 * - Crawl history (keep past N crawl runs)
 * - Concurrent crawl limit (max 1 per org)
 */

const cheerio = require('cheerio');
const { URL } = require('url');
const Sitemap = require('../models/Sitemap');
const CrawlPage = require('../models/CrawlPage');

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_MAX_PAGES = 500;
const CONCURRENCY = 5;
const REQUEST_DELAY_MS = 100;
const REQUEST_TIMEOUT_MS = 20000;
const PROGRESS_SAVE_INTERVAL = 10;
const MAX_CRAWL_HISTORY = 10; // keep last N crawl runs

// Increase undici's connect timeout (default 10s is too short for slow sites)
let fetchDispatcher;
try {
  const { Agent } = require('undici');
  fetchDispatcher = new Agent({ connect: { timeout: 20000 } });
} catch { /* undici not available as separate module, use defaults */ }

// File extensions to skip (not HTML pages)
const SKIP_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.tar', '.gz', '.7z',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.webm', '.ogg',
  '.css', '.js', '.map', '.woff', '.woff2', '.ttf', '.eot',
  '.json', '.rss', '.atom',
]);

// ─── robots.txt ──────────────────────────────────────────────────────────────

/** In-memory cache: domain → { rules, fetchedAt } */
const robotsCache = new Map();
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Fetch and parse robots.txt for a domain. Returns an array of
 * { allow: boolean, path: string } rules for our user-agent.
 */
async function fetchRobotsTxt(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return cached;
  }

  let rules = [];
  let sitemapUrls = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const opts = {
      signal: controller.signal,
      headers: { 'User-Agent': 'SupaRankBot/1.0' },
    };
    if (fetchDispatcher) opts.dispatcher = fetchDispatcher;
    const res = await fetch(`${origin}/robots.txt`, opts);
    clearTimeout(timeout);

    if (res.ok) {
      const text = await res.text();
      const parsed = parseRobotsTxt(text);
      rules = parsed.rules;
      sitemapUrls = parsed.sitemapUrls;
    }
  } catch {
    // robots.txt unreachable → allow everything
  }

  const entry = { rules, sitemapUrls, fetchedAt: Date.now() };
  robotsCache.set(origin, entry);
  return entry;
}

/**
 * Parse robots.txt content. Extracts rules for our bot or the wildcard agent.
 */
function parseRobotsTxt(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const sitemapUrls = [];
  let currentAgents = [];
  let allRules = []; // rules under User-agent: *
  let botRules = []; // rules under User-agent: SupaRankBot
  let foundBot = false;

  for (const line of lines) {
    if (line.startsWith('#') || line === '') continue;

    const sitemapMatch = line.match(/^Sitemap:\s*(.+)/i);
    if (sitemapMatch) {
      sitemapUrls.push(sitemapMatch[1].trim());
      continue;
    }

    const agentMatch = line.match(/^User-agent:\s*(.+)/i);
    if (agentMatch) {
      currentAgents.push(agentMatch[1].trim().toLowerCase());
      continue;
    }

    const disallowMatch = line.match(/^Disallow:\s*(.*)/i);
    const allowMatch = line.match(/^Allow:\s*(.*)/i);

    if (disallowMatch || allowMatch) {
      const isAllow = !!allowMatch;
      const path = (isAllow ? allowMatch[1] : disallowMatch[1]).trim();
      if (!path && !isAllow) continue; // empty Disallow = allow all

      const rule = { allow: isAllow, path };

      for (const agent of currentAgents) {
        if (agent === 'suparankbot') {
          botRules.push(rule);
          foundBot = true;
        } else if (agent === '*') {
          allRules.push(rule);
        }
      }
    }
  }

  // Prefer bot-specific rules; fall back to wildcard
  const rules = foundBot ? botRules : allRules;
  return { rules, sitemapUrls };
}

/**
 * Check if a URL path is allowed by robots.txt rules.
 * Longer paths take priority (most specific match wins).
 */
function isAllowedByRobots(urlPath, rules) {
  if (rules.length === 0) return true;

  let bestMatch = null;
  let bestLen = -1;

  for (const rule of rules) {
    // Convert robots wildcard pattern to check
    if (urlPath.startsWith(rule.path) || rule.path === '/') {
      if (rule.path.length > bestLen) {
        bestLen = rule.path.length;
        bestMatch = rule;
      }
    }
  }

  if (!bestMatch) return true;
  return bestMatch.allow;
}

// ─── Sitemap.xml parser ──────────────────────────────────────────────────────

/**
 * Fetch and parse sitemap.xml (and sitemap index files) to discover URLs.
 * Returns an array of URL strings.
 */
async function fetchSitemapXml(sitemapUrl, baseDomain, maxUrls = 5000) {
  const urls = new Set();
  const visited = new Set();

  async function parseSitemap(url) {
    if (visited.has(url) || urls.size >= maxUrls) return;
    visited.add(url);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const opts = {
        signal: controller.signal,
        headers: { 'User-Agent': 'SupaRankBot/1.0', 'Accept': 'application/xml, text/xml' },
      };
      if (fetchDispatcher) opts.dispatcher = fetchDispatcher;
      const res = await fetch(url, opts);
      clearTimeout(timeout);

      if (!res.ok) return;
      const text = await res.text();
      const $ = cheerio.load(text, { xmlMode: true });

      // Check if sitemap index
      const sitemapLocs = $('sitemapindex sitemap loc');
      if (sitemapLocs.length > 0) {
        const childUrls = [];
        sitemapLocs.each((_, el) => childUrls.push($(el).text().trim()));
        for (const childUrl of childUrls) {
          if (urls.size >= maxUrls) break;
          await parseSitemap(childUrl);
        }
        return;
      }

      // Regular sitemap — extract <url><loc>
      $('urlset url loc').each((_, el) => {
        if (urls.size >= maxUrls) return false;
        const loc = $(el).text().trim();
        try {
          const parsed = new URL(loc);
          if (parsed.hostname === baseDomain || parsed.hostname.endsWith('.' + baseDomain)) {
            urls.add(loc);
          }
        } catch { /* invalid URL */ }
      });
    } catch {
      // Sitemap fetch/parse failed — silently skip
    }
  }

  await parseSitemap(sitemapUrl);
  return [...urls];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a URL: resolve relative paths, strip fragments and trailing slashes.
 *
 * Optional 3rd/4th args enable same-domain scheme upgrade: when crawling an
 * https origin, any discovered http://samedomain URL is rewritten to https.
 * Most sites force-redirect http→https anyway, so this prevents non-canonical
 * (http) entries from polluting the output sitemap (smoking gun: github.com
 * had `http://github.com/features/ai` in results despite the seed being https).
 * Backward-compatible — call sites that pass only 2 args get the old behavior.
 */
function normalizeUrl(href, baseUrl, baseDomain = null, originScheme = null) {
  try {
    const parsed = new URL(href, baseUrl);
    parsed.hash = '';
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;
    if (
      originScheme === 'https:' &&
      parsed.protocol === 'http:' &&
      baseDomain &&
      (parsed.hostname === baseDomain || parsed.hostname.endsWith('.' + baseDomain))
    ) {
      parsed.protocol = 'https:';
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function isSameDomain(url, baseDomain) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === baseDomain || parsed.hostname.endsWith('.' + baseDomain);
  } catch {
    return false;
  }
}

// Known-infrastructure path prefixes that should never appear in a sitemap
// (CDN protection endpoints, CMS admin areas, well-known config paths).
const SKIP_PATH_PREFIXES = [
  '/cdn-cgi/',          // Cloudflare email-protection, challenges, etc.
  '/wp-admin/',         // WordPress admin
  '/wp-json/',          // WordPress REST API
  '/wp-login.php',      // WordPress login
  '/.well-known/',      // RFC 8615 metadata endpoints
  '/xmlrpc.php',        // Legacy WordPress RPC
];

function shouldSkipUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const lastDot = path.lastIndexOf('.');
    if (lastDot > path.lastIndexOf('/')) {
      const ext = path.substring(lastDot);
      if (SKIP_EXTENSIONS.has(ext)) return true;
    }
    if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:' || parsed.protocol === 'javascript:') {
      return true;
    }
    for (const prefix of SKIP_PATH_PREFIXES) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Fetch a URL with timeout, return { html, statusCode, contentType, responseTimeMs } or error.
 */
async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startTime = Date.now();

  try {
    const opts = {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SupaRankBot/1.0; +https://suparank.com/bot)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    };
    if (fetchDispatcher) opts.dispatcher = fetchDispatcher;
    const res = await fetch(url, opts);
    const responseTimeMs = Date.now() - startTime;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { html: null, statusCode: res.status, contentType, responseTimeMs };
    }

    const html = await res.text();
    return { html, statusCode: res.status, contentType, responseTimeMs };
  } catch (err) {
    const responseTimeMs = Date.now() - startTime;
    if (err.name === 'AbortError') {
      return { html: null, statusCode: 0, contentType: '', responseTimeMs, error: 'timeout' };
    }
    const cause = err.cause?.message || err.cause?.code || err.message;
    return { html: null, statusCode: 0, contentType: '', responseTimeMs, error: cause };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract internal links and page title from HTML using Cheerio.
 */
function extractLinksAndTitle(html, pageUrl, baseDomain, originScheme = null) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || '';

  const links = new Set();
  // Include <area href> for HTML image maps (e.g. paulgraham.com uses
  // <map><area href="..."> for its main navigation). Semantically identical
  // to <a href> — same href/rel/target attribute handling applies.
  $('a[href], area[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    // Honor rel="nofollow" — covers Cloudflare email-protection wrappers,
    // sponsored/ad links, and any link the site explicitly marks as not
    // indexable. Splits on whitespace because rel can have multiple tokens.
    const rel = ($(el).attr('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('nofollow')) return;

    const normalized = normalizeUrl(href, pageUrl, baseDomain, originScheme);
    if (!normalized) return;
    if (!isSameDomain(normalized, baseDomain)) return;
    if (shouldSkipUrl(normalized)) return;

    links.add(normalized);
  });

  return { title, links: [...links] };
}

/**
 * Simple async concurrency pool.
 */
async function asyncPool(concurrency, items, fn) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = fn(item).then((r) => {
      executing.delete(p);
      return r;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ─── Main crawl function ──────────────────────────────────────────────────────

/**
 * Crawl a site by BFS from its homepage URL.
 *
 * @param {string} sitemapId - Sitemap document ID
 * @param {object} [options]
 * @param {number} [options.maxPages] - Max pages to crawl (from tier config)
 * @returns {object} { pagesFound, errors }
 */
async function crawlSite(sitemapId, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  // ── 1. Atomic guard: claim the crawl ──────────────────────────────────
  let sitemap = await Sitemap.findOneAndUpdate(
    { _id: sitemapId, crawlStatus: { $in: ['idle', 'completed', 'error'] } },
    { $set: { crawlStatus: 'crawling', crawlProgress: 0, crawlError: null } },
    { new: true },
  );

  if (!sitemap) {
    // Controller may have pre-claimed (set status to 'crawling' before fire-and-forget)
    sitemap = await Sitemap.findOne({ _id: sitemapId, crawlStatus: 'crawling' });
    if (!sitemap) {
      console.log(`[sitemap-crawler] skipping ${sitemapId}: not found or invalid state`);
      return null;
    }
  }

  // ── 1b. Concurrent crawl limit: max 1 active crawl per org ────────────
  const concurrentCount = await Sitemap.countDocuments({
    organizationId: sitemap.organizationId,
    crawlStatus: 'crawling',
    _id: { $ne: sitemap._id },
  });
  if (concurrentCount > 0) {
    await Sitemap.updateOne({ _id: sitemapId }, {
      $set: { crawlStatus: 'error', crawlError: 'Another crawl is already running. Please wait for it to finish.' },
    });
    console.log(`[sitemap-crawler] skipping ${sitemapId}: concurrent crawl limit (org ${sitemap.organizationId})`);
    return null;
  }

  // Canonicalize the seed URL using the same normalizer that discovered links
  // pass through. Without this, the controller stores 'https://example.com'
  // (trailing slash stripped) while normalizeUrl produces 'https://example.com/'
  // (root slash preserved), causing the root to appear twice in the sitemap.
  const startUrl = normalizeUrl(sitemap.url, sitemap.url) || sitemap.url;
  const baseDomain = new URL(startUrl).hostname;
  const origin = new URL(startUrl).origin;
  const originScheme = new URL(startUrl).protocol; // 'https:' or 'http:'
  console.log(`[sitemap-crawler] starting crawl for ${sitemap.label || startUrl} (max ${maxPages} pages)`);

  const visited = new Set();
  const queue = []; // { url, depth }
  const queued = new Set([startUrl]);
  const results = []; // { url, title, statusCode, depth, responseTimeMs }
  let errorCount = 0;
  let pagesProcessed = 0;
  let lastProgressSave = 0; // Track when we last saved progress to DB
  let maxProgress = 0; // Never let progress go backwards

  try {
    // ── 2. Fetch robots.txt ──────────────────────────────────────────────
    const { rules: robotsRules, sitemapUrls: robotsSitemapUrls } = await fetchRobotsTxt(origin);
    if (robotsRules.length > 0) {
      console.log(`[sitemap-crawler] loaded ${robotsRules.length} robots.txt rule(s) for ${baseDomain}`);
    }

    // ── 3. Seed from sitemap.xml ─────────────────────────────────────────
    // Try robots.txt Sitemap: directives first, then default /sitemap.xml
    const sitemapSeedUrls = robotsSitemapUrls.length > 0
      ? robotsSitemapUrls
      : [`${origin}/sitemap.xml`];

    let seededCount = 0;
    for (const sitemapUrl of sitemapSeedUrls) {
      const discovered = await fetchSitemapXml(sitemapUrl, baseDomain, maxPages);
      for (const url of discovered) {
        const normalized = normalizeUrl(url, origin, baseDomain, originScheme);
        if (normalized && !queued.has(normalized) && !shouldSkipUrl(normalized)) {
          const urlPath = new URL(normalized).pathname;
          if (isAllowedByRobots(urlPath, robotsRules)) {
            queue.push({ url: normalized, depth: 0 }); // sitemap-seeded = depth 0
            queued.add(normalized);
            seededCount++;
          }
        }
      }
    }
    if (seededCount > 0) {
      console.log(`[sitemap-crawler] seeded ${seededCount} URLs from sitemap.xml`);
    }

    // ── 4. Validate homepage is reachable ─────────────────────────────────
    {
      let { html, statusCode, error, responseTimeMs } = await fetchPage(startUrl);

      if (error || !html) {
        console.log(`[sitemap-crawler] homepage fetch failed (${error}), retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        ({ html, statusCode, error, responseTimeMs } = await fetchPage(startUrl));
      }

      visited.add(startUrl);
      queued.add(startUrl);

      if (error || !html) {
        // If we already seeded URLs from sitemap.xml, the homepage being
        // non-HTML (typical for SPA / JS-rendered marketing sites) shouldn't
        // kill the whole crawl. Skip the homepage and let BFS process the
        // seeded URLs. Don't push the homepage to results — it returned no
        // useful content and shouldn't appear in the output sitemap.
        if (seededCount > 0) {
          console.log(`[sitemap-crawler] homepage returned no HTML for ${sitemap.label || startUrl} (${error || `HTTP ${statusCode}`}) — continuing with ${seededCount} seeded URLs`);
          pagesProcessed = 0;
        } else {
          const reason = error === 'timeout'
            ? `Cannot reach ${baseDomain} — connection timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
            : `Cannot reach ${baseDomain} — ${error || `HTTP ${statusCode} with no HTML content`}`;

          await Sitemap.updateOne({ _id: sitemapId }, {
            $set: {
              crawlStatus: 'error',
              crawlProgress: 0,
              crawlError: reason,
              crawlPages: [],
              crawlStats: { totalFound: 0, newUrls: 0, removedUrls: 0, unchanged: 0, errors: 1 },
            },
          });
          console.log(`[sitemap-crawler] homepage unreachable for ${sitemap.label || startUrl}: ${reason}`);
          return null;
        }
      } else {

      // Homepage succeeded — seed BFS with its links
      const { title, links } = extractLinksAndTitle(html, startUrl, baseDomain, originScheme);

      // Capture diagnostic info (cheap — single cheerio parse already done).
      // Persisted on the Sitemap doc at the end of the crawl so customer-
      // reported "thin result" cases can be diagnosed via GET /sitemaps/:id
      // without needing Railway log access.
      {
        const $diag = cheerio.load(html);
        // eslint-disable-next-line no-var
        var crawlDiag = {
          htmlBytes: html.length,
          anchors: $diag('a[href]').length,
          areas: $diag('area[href]').length,
          sameDomainLinks: links.length,
          seededCount,
        };
      }
      if (links.length < 5) {
        console.log(`[sitemap-crawler] thin-response diag for ${baseDomain}: ${JSON.stringify(crawlDiag)}`);
      }

      results.push({ url: startUrl, title, statusCode, depth: 0, responseTimeMs });
      for (const link of links) {
        if (!queued.has(link)) {
          const linkPath = new URL(link).pathname;
          if (isAllowedByRobots(linkPath, robotsRules)) {
            queue.push({ url: link, depth: 1 });
            queued.add(link);
          }
        }
      }
      pagesProcessed = 1;

      // ── 4b. Fail loudly if no internal links were discovered ────────────
      // Catches frameset-based sites, SPAs / JS-rendered apps, and sites
      // with non-standard navigation — all of which would otherwise complete
      // with a misleading 1-URL "successful" sitemap. Only error if BOTH
      // sources (homepage <a> extraction AND sitemap.xml seeding) yielded
      // zero same-domain URLs.
      if (seededCount === 0 && links.length === 0) {
        await Sitemap.updateOne({ _id: sitemapId }, {
          $set: {
            crawlStatus: 'error',
            crawlProgress: 0,
            crawlError: 'No internal links discovered. The site may be JavaScript-rendered or use non-standard navigation.',
            crawlPages: [],
            crawlStats: { totalFound: 0, newUrls: 0, removedUrls: 0, unchanged: 0, errors: 1 },
          },
        });
        await CrawlPage.deleteMany({ sitemapId: sitemap._id });
        console.log(`[sitemap-crawler] no internal links discovered for ${sitemap.label || startUrl}`);
        return null;
      }
      }
    }

    // ── 5. BFS crawl remaining pages ──────────────────────────────────────
    while (queue.length > 0 && visited.size < maxPages) {
      const batchSize = Math.min(CONCURRENCY, queue.length, maxPages - visited.size);
      const batch = [];
      while (batch.length < batchSize && queue.length > 0) {
        const item = queue.shift();
        if (visited.has(item.url)) continue;
        visited.add(item.url);
        batch.push(item);
      }
      if (batch.length === 0) break;

      const batchResults = await asyncPool(CONCURRENCY, batch, async (item) => {
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        const { html, statusCode, error, responseTimeMs } = await fetchPage(item.url);

        // ok requires THREE things: no network error, response had HTML body,
        // AND HTTP status was 2xx/3xx (3xx is rare since fetch follows redirects).
        // Without the status check, HN-style 503-with-HTML error pages would
        // pass the html-exists check and pollute the sitemap. Smoking-gun fix:
        // /hide?id=...&goto=news returns 503 with HTML — we still don't want it.
        const okStatus = statusCode >= 200 && statusCode < 400;
        if (error || !html || !okStatus) {
          errorCount++;
          return { url: item.url, title: '', statusCode, depth: item.depth, responseTimeMs, links: [], ok: false };
        }

        const { title, links } = extractLinksAndTitle(html, item.url, baseDomain, originScheme);
        return { url: item.url, title, statusCode, depth: item.depth, responseTimeMs, links, ok: true };
      });

      for (const page of batchResults) {
        // Only store URLs that successfully returned crawlable HTML. Failed
        // fetches (4xx/5xx, network errors, non-HTML 200s) are tracked in
        // errorCount but excluded from the exported sitemap. Smoking gun
        // case: news.ycombinator.com /vote?id=... 401 endpoints — 68 of 100
        // results were dead URLs before this filter.
        if (page.ok) {
          results.push({
            url: page.url,
            title: page.title,
            statusCode: page.statusCode,
            depth: page.depth,
            responseTimeMs: page.responseTimeMs,
          });
        }

        for (const link of page.links) {
          if (!visited.has(link) && !queued.has(link)) {
            const linkPath = new URL(link).pathname;
            if (isAllowedByRobots(linkPath, robotsRules)) {
              queue.push({ url: link, depth: page.depth + 1 });
              queued.add(link);
            }
          }
        }
      }

      pagesProcessed += batch.length;

      if (pagesProcessed - lastProgressSave >= PROGRESS_SAVE_INTERVAL) {
        lastProgressSave = pagesProcessed;
        // Use discovered pages (processed + remaining queue) as denominator, capped by maxPages
        const totalEstimate = Math.min(pagesProcessed + queue.length, maxPages);
        const rawProgress = Math.min(95, Math.round((pagesProcessed / totalEstimate) * 100));
        maxProgress = Math.max(rawProgress, maxProgress); // never go backwards
        await Sitemap.updateOne(
          { _id: sitemapId },
          { $set: { crawlProgress: maxProgress } },
        );
      }
    }

    // ── 6. Compute diff vs approved baseline ────────────────────────────
    // Read previous pages from the CrawlPage collection (not embedded anymore)
    const previousPages = await CrawlPage.find(
      { sitemapId: sitemap._id, diffStatus: { $ne: 'removed' } },
      { url: 1, title: 1 },
    ).lean();
    const approvedUrls = new Set(previousPages.map((p) => p.url));
    const crawledUrls = new Set(results.map((r) => r.url));

    const crawlPages = [];

    for (const page of results) {
      crawlPages.push({
        url: page.url,
        title: page.title,
        statusCode: page.statusCode,
        depth: page.depth,
        responseTimeMs: page.responseTimeMs,
        diffStatus: approvedUrls.has(page.url) ? 'unchanged' : 'new',
      });
    }

    for (const prevPage of previousPages) {
      if (!crawledUrls.has(prevPage.url)) {
        crawlPages.push({
          url: prevPage.url,
          title: prevPage.title,
          statusCode: null,
          depth: null,
          responseTimeMs: null,
          diffStatus: 'removed',
        });
      }
    }

    // discoveredButSkipped = URLs we had queued but didn't crawl because the
    // page cap was hit. The BFS loop exits on `visited.size >= maxPages`, so
    // anything left in `queue` is the lower-bound of "more pages exist".
    const truncated = visited.size >= maxPages && queue.length > 0;
    const stats = {
      totalFound: results.length,
      newUrls: crawlPages.filter((p) => p.diffStatus === 'new').length,
      removedUrls: crawlPages.filter((p) => p.diffStatus === 'removed').length,
      unchanged: crawlPages.filter((p) => p.diffStatus === 'unchanged').length,
      errors: errorCount,
      truncated,
      discoveredButSkipped: queue.length,
      // crawlDiag is set in the homepage-success branch (~line 535). If the
      // homepage never succeeded (took the error path), the field stays as
      // the schema default (all zeros) — also a valid diagnostic signal.
      diag: typeof crawlDiag !== 'undefined' ? crawlDiag : undefined,
    };

    // ── 7. Save results to CrawlPage collection + update Sitemap ──────
    const now = new Date();
    const nextCrawlAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Delete all old CrawlPages for this sitemap
    await CrawlPage.deleteMany({ sitemapId: sitemap._id });

    // Bulk insert new pages — each as its own document in the CrawlPage collection
    const crawlPageDocs = crawlPages.map((p) => ({
      sitemapId: sitemap._id,
      url: p.url,
      title: p.title,
      statusCode: p.statusCode,
      depth: p.depth,
      responseTimeMs: p.responseTimeMs,
      diffStatus: p.diffStatus,
      // XML export fields (replaces approvedPages)
      lastmod: p.diffStatus !== 'removed' ? now.toISOString().split('T')[0] : null,
      changefreq: 'weekly',
      priority: p.url === startUrl ? 1.0 : 0.5,
    }));

    if (crawlPageDocs.length > 0) {
      await CrawlPage.insertMany(crawlPageDocs, { ordered: false });
    }

    // Build history entry from current crawl
    const historyEntry = {
      crawledAt: now,
      stats: { ...stats },
      pageCount: results.length,
    };

    // Trim history to MAX_CRAWL_HISTORY (keep most recent)
    const existingHistory = sitemap.crawlHistory || [];
    const newHistory = [historyEntry, ...existingHistory].slice(0, MAX_CRAWL_HISTORY);

    // Update Sitemap document (no page data — just metadata and stats)
    await Sitemap.updateOne({ _id: sitemapId }, {
      $set: {
        crawlStatus: 'completed',
        crawlProgress: 100,
        crawlError: null,
        lastCrawlAt: now,
        nextCrawlAt,
        crawlStats: stats,
        crawlCompletedAt: now,
        approvedAt: now,
        crawlHistory: newHistory,
      },
    });

    console.log(`[sitemap-crawler] completed ${sitemap.label || startUrl}: ${stats.totalFound} pages (${stats.newUrls} new, ${stats.removedUrls} removed, ${errorCount} errors)`);
    return stats;
  } catch (err) {
    console.error(`[sitemap-crawler] error crawling ${sitemapId}:`, err.message);
    await Sitemap.updateOne({ _id: sitemapId }, {
      $set: {
        crawlStatus: 'error',
        crawlProgress: 0,
        crawlError: err.message,
      },
    });
    return null;
  }
}

// ─── XML generation ───────────────────────────────────────────────────────────

function generateSitemapXml(pages) {
  const today = new Date().toISOString().split('T')[0];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const page of pages) {
    xml += '<url>\n';
    xml += `<loc>${escapeXml(page.url)}</loc>\n`;
    xml += `<lastmod>${page.lastmod || today}</lastmod>\n`;
    xml += `<changefreq>${page.changefreq || 'weekly'}</changefreq>\n`;
    xml += `<priority>${page.priority ?? 0.5}</priority>\n`;
    xml += '</url>\n';
  }

  xml += '</urlset>\n';
  return xml;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  crawlSite,
  generateSitemapXml,
  // Exposed for unit testing. Not intended for external use.
  _internals: { normalizeUrl, shouldSkipUrl, extractLinksAndTitle, isSameDomain },
};
