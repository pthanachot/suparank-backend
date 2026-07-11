/**
 * Map Suparank's MongoDB benchmark data to the Writing Engine's ContentBrief format.
 *
 * Suparank stores competitive analysis in MongoDB (from the Go engine pipeline).
 * The Writing Engine expects a ContentBrief (defined in seo/brief.go).
 * This function bridges the two schemas.
 *
 * @param {Object} content - MongoDB Content document (with benchmark, intent, etc.)
 * @returns {Object} ContentBrief for the Writing Engine
 */
function benchmarkToContentBrief(content) {
  const benchmark = content.benchmark || {};
  const intent = content.intent || {};
  const competitorPages = content.competitorPages || [];
  const peopleAlsoAsk = content.peopleAlsoAsk || [];
  const recommendedOutline = content.recommendedOutline || {};
  const keywords = benchmark.keywords || content.targetKeywords || [];

  // Rec 15: fold applied GSC striking-distance queries into the secondary
  // keywords so the whole scoring loop (gauge, term counts, agent feedback)
  // optimizes for the queries the user chose to Apply. Deduped against the
  // existing secondaries (case-insensitive), at most 5 applied queries added.
  const secondaryKeywords = keywords.slice(1);
  const seenSecondary = new Set(secondaryKeywords.map((k) => String(k).toLowerCase()));
  const appliedGscQueries = Array.isArray(content.appliedGscQueries) ? content.appliedGscQueries : [];
  let addedApplied = 0;
  for (const q of appliedGscQueries) {
    if (addedApplied >= 5) break;
    const key = String(q || '').toLowerCase();
    if (q && !seenSecondary.has(key)) {
      seenSecondary.add(key);
      secondaryKeywords.push(q);
      addedApplied += 1;
    }
  }

  const brief = {
    // Core targeting
    targetKeyword: keywords[0] || '',
    secondaryKeywords,
    targetDensity: benchmark.avgKeywordDensity || 1.5,
    searchIntent: intent.primary || 'informational',

    // Content structure
    targetWordCount: content.targetWordCount || benchmark.avgWordCount || 2000,
    serpQuestions: extractSerpQuestions(peopleAlsoAsk),
    competitorHeadings: extractCompetitorHeadings(competitorPages),
    suggestedOutline: extractSuggestedOutline(recommendedOutline),

    // Content type — prefer user's wizard selection over inferred intent
    contentType: content.contentType || mapContentType(intent),

    // User instructions from wizard step 3
    authorContext: content.contentContext || '',

    // Top NLP terms the content should include. Each term gets a
    // recommendedSection tag (Phase 2 / Task #99) derived from topic-cluster
    // membership — frontend groups terms by section so writers see "this
    // section needs these terms" instead of one flat 30-item list.
    nlpTerms: extractNlpTerms(benchmark, benchmark.topicClusters),

    // Benchmark averages for competitive scoring (mirrors frontend BenchmarkData)
    benchmarkAverages: {
      wordCount: benchmark.avgWordCount || 2000,
      h2Count: benchmark.avgH2Count || 6,
      h3Count: benchmark.avgH3Count || 4,
      images: benchmark.avgImages || 3,
      listCount: benchmark.avgListCount || 1,
      tableCount: benchmark.avgTableCount || 0,
      faqCount: benchmark.avgFaqCount || 0,
      paragraphs: benchmark.avgParagraphs || 20,
      keywordDensity: benchmark.avgKeywordDensity || 1.5,
      readingLevel: benchmark.avgReadingLevel || 60,
      keywordInH2Rate: benchmark.keywordInH2Rate || 0,
      keywordInFirst100Rate: benchmark.keywordInFirst100Rate || 0,
      // Engine uses this as the Internal Links signal target (falls back to
      // min(5, len(availableLinks)) when 0) — keeps the engine's live score
      // aligned with the frontend's, which reads avgInternalLinks directly.
      internalLinks: benchmark.avgInternalLinks || 0,
      pageCount: benchmark.pageCount || 0,
    },

    // Topic clusters and subtopics for coverage scoring
    topicClusters: (benchmark.topicClusters || []).map((c) => ({
      label: c.topic || c.label || '',
      terms: c.terms || [],
      docFrequency: c.docFrequency || 0,
    })),
    subtopics: (benchmark.subtopics || []).map((s) => ({
      label: s.label || '',
      docFrequency: s.docFrequency || 0,
      docPercent: s.docPercent || 0,
    })),

    // AEO/citability (R5): carry the AI-answer analysis to the engine
    // STRUCTURALLY, not just as prose in research-outline.md. Inner keys are
    // snake_case and passed through verbatim — the engine's citability port and
    // the frontend citability ring both consume this exact shape, so do not
    // transform the keys here. null when the content has no analysis.
    aiAnswerAnalysis: content.aiAnswerAnalysis || null,
  };

  return brief;
}


/**
 * Extract SERP "People Also Ask" questions.
 * @param {Array} paa - peopleAlsoAsk array from MongoDB
 * @returns {string[]}
 */
function extractSerpQuestions(paa) {
  if (!Array.isArray(paa)) return [];
  return paa
    .map((item) => item.question || item.query || '')
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Extract unique H2 headings from competitor pages.
 * @param {Array} pages - competitorPages from MongoDB
 * @returns {string[]}
 */
function extractCompetitorHeadings(pages) {
  if (!Array.isArray(pages)) return [];
  const seen = new Set();
  const headings = [];
  pages.forEach((page) => {
    const h2s = page.h2s || [];
    h2s.forEach((h) => {
      const norm = h.toLowerCase().trim();
      if (!seen.has(norm)) {
        seen.add(norm);
        headings.push(h);
      }
    });
  });
  return headings.slice(0, 20);
}

/**
 * Extract suggested outline headings from recommendedOutline.
 * @param {Object} outline - { h1: string, sections: [{ h2, children: [{ h3 }] }] }
 * @returns {string[]}
 */
function extractSuggestedOutline(outline) {
  if (!outline || !outline.sections) return [];
  return outline.sections.map((s) => s.h2).filter(Boolean);
}

/**
 * Extract top NLP terms from benchmark for the Writing Engine.
 *
 * Phase 2 / Task #99: each term is tagged with `recommendedSection` —
 * the topic cluster it belongs to. Frontend uses this to group terms in
 * the sidebar gauge so writers see "Section X needs these terms" instead
 * of one flat 30-item list. Terms not appearing in any cluster get an
 * empty recommendedSection (rendered as the "General" bucket).
 *
 * @param {Object} benchmark
 * @param {Array} topicClusters - clusters array (each { topic|label, terms[] })
 * @returns {Array<{term, min, max, category, recommendedSection}>}
 */
function extractNlpTerms(benchmark, topicClusters) {
  const terms = benchmark.topNlpTerms || [];
  if (!Array.isArray(terms)) return [];

  // Build term → cluster-label map. Lowercased for case-insensitive lookup;
  // a term that appears in multiple clusters takes its first appearance
  // (clusters are already ranked by docFrequency upstream).
  const termToCluster = new Map();
  if (Array.isArray(topicClusters)) {
    for (const c of topicClusters) {
      const label = c.topic || c.label || '';
      if (!label) continue;
      const clusterTerms = Array.isArray(c.terms) ? c.terms : [];
      for (const t of clusterTerms) {
        const key = String(t || '').toLowerCase().trim();
        if (key && !termToCluster.has(key)) {
          termToCluster.set(key, label);
        }
      }
    }
  }

  return terms
    .slice(0, 30)
    .filter((t) => t.term)
    .map((t) => {
      const lookupKey = String(t.term).toLowerCase().trim();
      const recommendedSection = termToCluster.get(lookupKey) || '';
      return {
        term: t.term,
        min: t.usageRange?.min ?? 1,
        max: t.usageRange?.max ?? Math.max(t.count || 1, 5),
        category: t.category || 'nlp',
        recommendedSection,
      };
    });
}

/**
 * Map Suparank intent to a content type string.
 * @param {Object} intent - { primary, sophistication, decisionStage }
 * @returns {string}
 */
function mapContentType(intent) {
  const primary = (intent.primary || '').toLowerCase();
  switch (primary) {
    case 'informational': return 'guide';
    case 'commercial': return 'comparison';
    case 'transactional': return 'review';
    case 'navigational': return 'guide';
    default: return 'guide';
  }
}

/**
 * Build the internal-link inventory (ContentBrief.availableLinks) from the
 * workspace's crawled sitemap pages. The Writing Engine verifies every link
 * the AI inserts against this allowlist (hallucinated-link detection) and
 * scores link coverage — the signal is SKIPPED when the array is empty, so
 * workspaces without a completed crawl are unaffected.
 *
 * Ranking: stemmed-token overlap between the target/secondary keywords and
 * each page's title + URL slug; ties broken by depth (shallower first),
 * sitemap priority, then recency.
 *
 * @param {ObjectId|string} workspaceId
 * @param {string} targetKeyword
 * @param {string[]} secondaryKeywords
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<{url, anchorText, title, relevance}>>}
 */
// setupSession runs on EVERY chat/agent request and re-pushes the brief, so
// without a cache this would hit Mongo (Sitemap + up to 500 CrawlPages) and
// re-stem every page title on every message. Crawled pages change rarely —
// a short TTL keeps sessions fresh without the per-message cost.
const linksCache = new Map(); // key: `${workspaceId}|${targetKeyword}` → { links, at }
// pagesCache is keyed by workspaceId ALONE — the deduped crawled-page set is
// keyword-independent, so buildAvailableLinks (per-keyword) and buildAllowlistUrls
// (keyword-agnostic, R3) share one fetch instead of hitting Mongo twice per
// setupSession.
const pagesCache = new Map(); // key: `${workspaceId}` → { pages, at }
const LINKS_CACHE_TTL_MS = 5 * 60 * 1000;
const LINKS_CACHE_MAX = 200;

/**
 * Fetch the workspace's deduped, linkable crawled pages (non-removed, 200/null
 * status) once and cache them. Shared by buildAvailableLinks and
 * buildAllowlistUrls so they don't each re-query Mongo on every message.
 *
 * NOTE: titleless pages are INCLUDED here — the allowlist (R3) is defined as
 * every real crawled URL regardless of title, so a titleless-but-real page is
 * not falsely flagged as hallucinated. buildAvailableLinks (which needs a title
 * for anchor text) skips titleless pages itself; the dedup below prefers a
 * titled row over a titleless duplicate so that path is byte-identical to the
 * pre-R3 DB-level title filter.
 * @returns {Promise<Array<{url, title, depth, priority, updatedAt}>>}
 */
async function fetchCrawledPages(workspaceId) {
  if (!workspaceId) return [];
  const key = String(workspaceId);
  const cached = pagesCache.get(key);
  if (cached && Date.now() - cached.at < LINKS_CACHE_TTL_MS) {
    return cached.pages;
  }
  // Lazy requires keep this module dependency-light for its sync default export.
  const Sitemap = require('../models/Sitemap');
  const CrawlPage = require('../models/CrawlPage');

  const sitemaps = await Sitemap.find({ workspaceId, crawlCompletedAt: { $ne: null } })
    .sort({ crawlCompletedAt: -1 })
    .select('_id')
    .limit(5)
    .lean();
  if (sitemaps.length === 0) {
    pagesCachePut(key, []);
    return [];
  }

  const raw = await CrawlPage.find({
    sitemapId: { $in: sitemaps.map((s) => s._id) },
    diffStatus: { $ne: 'removed' },
    $or: [{ statusCode: 200 }, { statusCode: null }, { statusCode: { $exists: false } }],
  })
    .select('url title depth priority updatedAt')
    .lean();

  // Dedupe by url across sitemaps. Prefer a titled row over a titleless
  // duplicate of the same URL so buildAvailableLinks (which drops titleless)
  // still sees the titled version — matching the old DB-level title filter.
  const byUrl = new Map();
  for (const p of raw) {
    if (!p.url) continue;
    const existing = byUrl.get(p.url);
    if (!existing) {
      byUrl.set(p.url, p);
    } else if ((!existing.title || existing.title === '') && p.title) {
      byUrl.set(p.url, p); // upgrade titleless → titled (Map keeps original position)
    }
  }
  const pages = Array.from(byUrl.values());
  pagesCachePut(key, pages);
  return pages;
}

async function buildAvailableLinks(workspaceId, targetKeyword, secondaryKeywords = [], { limit = 30 } = {}) {
  if (!workspaceId) return [];

  const cacheKey = `${workspaceId}|${(targetKeyword || '').toLowerCase()}|${(secondaryKeywords || [])
    .map((k) => String(k).toLowerCase())
    .sort()
    .join(',')}`;
  const cached = linksCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LINKS_CACHE_TTL_MS) {
    // Defensive copy: three independent call sites receive this — a mutation
    // by any of them must not poison the cache.
    return cached.links.map((l) => ({ ...l }));
  }
  const { stem, tokenize } = require('./stemmer');

  const pages = await fetchCrawledPages(workspaceId);
  if (pages.length === 0) {
    cachePut(cacheKey, []);
    return [];
  }

  // Stemmed keyword set from target + secondary keywords.
  const keywordStems = new Set(
    [targetKeyword, ...(secondaryKeywords || [])]
      .filter(Boolean)
      .flatMap((kw) => tokenize(kw).map(stem)),
  );

  const scored = [];
  for (const page of pages) {
    // Titleless pages are kept in the shared fetch for the allowlist, but the
    // top-30 inventory needs a title (anchor text + relevance stemming), so
    // skip them here — matches the pre-R3 DB-level `title` filter.
    if (!page.title) continue;
    let slugText = '';
    try {
      slugText = decodeURIComponent(new URL(page.url).pathname).replace(/[-_/]+/g, ' ');
    } catch {
      /* unparseable URL — rank on title alone */
    }
    const pageStems = new Set(tokenize(`${page.title} ${slugText}`).map(stem));
    let overlap = 0;
    for (const ks of keywordStems) {
      if (pageStems.has(ks)) overlap++;
    }
    scored.push({ page, overlap });
  }

  scored.sort((a, b) =>
    b.overlap - a.overlap ||
    (a.page.depth ?? 99) - (b.page.depth ?? 99) ||
    (b.page.priority ?? 0) - (a.page.priority ?? 0) ||
    new Date(b.page.updatedAt || 0) - new Date(a.page.updatedAt || 0),
  );

  const links = scored.slice(0, limit).map(({ page, overlap }) => ({
    url: page.url,
    anchorText: page.title,
    title: page.title,
    relevance: overlap >= 2 ? 'high' : overlap === 1 ? 'medium' : 'low',
  }));
  cachePut(cacheKey, links);
  return links;
}

/**
 * Build the FULL crawled-URL allowlist (R3) for hallucination classification —
 * every non-removed 200/null crawled URL, deduped, capped at 2000. Unlike
 * buildAvailableLinks (top-30, feeds prompts + suggestions), this list is used
 * ONLY to verify inserted links and is NEVER rendered into a prompt. Pushed to
 * the engine as brief.allowlistUrls and returned to the editor via
 * /available-links so the Go engine and the frontend ring classify identically.
 * @returns {Promise<string[]>}
 */
async function buildAllowlistUrls(workspaceId, { cap = 2000 } = {}) {
  if (!workspaceId) return [];
  const pages = await fetchCrawledPages(workspaceId);
  const urls = [];
  for (const p of pages) {
    if (!p.url) continue;
    urls.push(p.url); // already deduped by fetchCrawledPages
    if (urls.length >= cap) break;
  }
  // Silent truncation would make the extra pages look "covered" when they'd
  // still be flagged as hallucinated. Log it so a site that outgrows the cap
  // is visible (the fix would be raising cap + the engine's 1MB brief limit).
  if (pages.length > cap) {
    console.warn(
      `[buildAllowlistUrls] workspace ${workspaceId}: ${pages.length} crawled pages exceed the ${cap} allowlist cap — ` +
      `${pages.length - cap} URLs excluded and may be false-flagged as hallucinated links.`,
    );
  }
  return urls;
}

/**
 * Drop every cached link inventory for a workspace — called when a sitemap
 * crawl completes so fresh pages appear immediately instead of after the TTL.
 */
function invalidateLinksCache(workspaceId) {
  if (!workspaceId) return;
  const prefix = `${workspaceId}|`;
  for (const key of linksCache.keys()) {
    if (key.startsWith(prefix)) linksCache.delete(key);
  }
  // Also drop the shared page set so buildAllowlistUrls / buildAvailableLinks
  // both see fresh crawl results immediately after a crawl completes.
  pagesCache.delete(String(workspaceId));
}

function cachePut(key, links) {
  if (linksCache.size >= LINKS_CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const first = linksCache.keys().next().value;
    if (first !== undefined) linksCache.delete(first);
  }
  linksCache.set(key, { links, at: Date.now() });
}

function pagesCachePut(key, pages) {
  if (pagesCache.size >= LINKS_CACHE_MAX) {
    const first = pagesCache.keys().next().value;
    if (first !== undefined) pagesCache.delete(first);
  }
  pagesCache.set(key, { pages, at: Date.now() });
}

module.exports = { benchmarkToContentBrief, buildAvailableLinks, buildAllowlistUrls, invalidateLinksCache };
