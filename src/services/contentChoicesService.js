'use strict';

/**
 * Content choices & adoption — Tier 1 (Wave 5 Phase 5, plan §9).
 *
 * Reports over fields that ALREADY exist on Content and its neighbours. No new
 * capture: everything here is first-party product data, so it needs no consent
 * gate, has no TTL, and covers the full history of every article rather than a
 * 90-day event horizon.
 *
 * Two rules the plan fixes for this service:
 *
 *  - KEYWORD GROUPING IS CASE-INSENSITIVE AND TRIMMED (W3). "Best CRM" and
 *    "best crm " are one keyword to a human and must be one row here; the most
 *    common original spelling is kept for display.
 *  - PRE-WAVE-1 ARTICLES GET AN EXPLICIT `legacy` BUCKET (W3). createdVia only
 *    exists on articles created after Wave 1 shipped. Its schema default is
 *    'blank', which is also the value a genuine manual creation carries, so
 *    older rows are indistinguishable from manual ones by value alone — they
 *    are separated by age instead, and labelled, rather than silently inflating
 *    "manual".
 *
 * Keyword text is CUSTOMER CONTENT. This service is platform-admin only and
 * its output must never reach an agency-tier surface.
 */

const Content = require('../models/Content');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');

// Every content type the wizard can set, so the export can show the ones
// nobody picks — a zero is the actionable number when pruning wizard options.
const CONTENT_TYPES = [
  'serp-based', 'blog-post', 'landing-page', 'comparison', 'listicle',
  'product-page', 'category-page', 'service-page', 'llm-optimized',
  'homepage', 'glossary', 'documentation', 'faq',
];

/**
 * Articles created before this date cannot have meaningful createdVia — the
 * field shipped with Wave 1 on 2026-08-08. Overridable so the boundary is
 * testable and adjustable if the deploy date is ever corrected.
 */
const CREATED_VIA_SINCE = new Date(process.env.CREATED_VIA_SINCE || '2026-08-08T00:00:00.000Z');

/**
 * How an article came to exist, with genuinely-unattributed articles held apart.
 *
 * Only 'blank' is ambiguous: it is both the schema default and the value a real
 * manual creation carries, so on an article older than the field it means "we
 * don't know". Every other value ('url', 'keyword', 'template') is only ever
 * written deliberately, so it is trustworthy whenever it appears — including on
 * an article whose createdAt predates the rollout, which happens whenever a
 * backfill or a long-running draft is involved. Ageing those out would throw
 * away attribution we actually have.
 */
function sourceOf(doc) {
  const via = doc.createdVia || 'blank';
  if (via === 'blank' && doc.createdAt && doc.createdAt < CREATED_VIA_SINCE) return 'legacy';
  return via;
}

/**
 * Every target keyword, with who is writing on it and where it came from.
 * Returns the FULL list — the caller paginates for display, but the export
 * carries all of it (plan §9 Phase 2 export contract).
 */
async function getKeywordLedger() {
  const docs = await Content.find(
    { targetKeywords: { $exists: true, $ne: [] } },
    { targetKeywords: 1, createdVia: 1, workspaceNumber: 1, score: 1, createdAt: 1 }
  ).lean();

  const byKey = new Map();
  for (const d of docs) {
    const source = sourceOf(d);
    for (const raw of d.targetKeywords || []) {
      if (typeof raw !== 'string') continue;
      const display = raw.trim();
      if (!display) continue;
      const key = display.toLowerCase();
      let row = byKey.get(key);
      if (!row) {
        row = {
          keyword: display,
          spellings: new Map(),
          articles: 0,
          workspaces: new Set(),
          sources: {},
          scoreSum: 0,
          scored: 0,
          lastCreated: null,
        };
        byKey.set(key, row);
      }
      row.spellings.set(display, (row.spellings.get(display) || 0) + 1);
      row.articles += 1;
      if (d.workspaceNumber != null) row.workspaces.add(d.workspaceNumber);
      row.sources[source] = (row.sources[source] || 0) + 1;
      if (typeof d.score === 'number' && d.score > 0) {
        row.scoreSum += d.score;
        row.scored += 1;
      }
      if (!row.lastCreated || (d.createdAt && d.createdAt > row.lastCreated)) row.lastCreated = d.createdAt;
    }
  }

  return [...byKey.values()]
    .map((r) => ({
      // Display the spelling people actually use most, not whichever we saw first.
      keyword: [...r.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      articles: r.articles,
      workspaces: r.workspaces.size,
      sources: r.sources,
      avgScore: r.scored ? Math.round(r.scoreSum / r.scored) : null,
      lastCreated: r.lastCreated,
    }))
    .sort((a, b) => b.articles - a.articles || a.keyword.localeCompare(b.keyword));
}

/** How articles start, and how many keywords people actually give them. */
async function getCreationShape() {
  const docs = await Content.find({}, { createdVia: 1, createdAt: 1, targetKeywords: 1 }).lean();

  const sources = {};
  const perArticle = { 0: 0, 1: 0, 2: 0, 3: 0, '4-5': 0 };
  for (const d of docs) {
    const s = sourceOf(d);
    sources[s] = (sources[s] || 0) + 1;
    const n = (d.targetKeywords || []).filter((k) => typeof k === 'string' && k.trim()).length;
    if (n >= 4) perArticle['4-5'] += 1;
    else perArticle[n] = (perArticle[n] || 0) + 1;
  }
  return { total: docs.length, sources, keywordsPerArticle: perArticle };
}

/** Distribution of a single field, as {value: count}. */
async function distribution(field, { includeEmptyAs = '(unset)' } = {}) {
  const rows = await Content.aggregate([
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const out = {};
  for (const r of rows) {
    const key = r._id === '' || r._id == null ? includeEmptyAs : String(r._id);
    out[key] = (out[key] || 0) + r.count;
  }
  return out;
}

/**
 * Did the author keep the engine's recommended length? Only articles that were
 * analysed AND had a target set can answer — the rest are reported as "no
 * comparison possible" rather than counted as agreement.
 */
async function getWordCountChoice() {
  const docs = await Content.find(
    { targetWordCount: { $gt: 0 } },
    { targetWordCount: 1, 'aiFormatData.recommendedStructure.targetWordCount': 1 }
  ).lean();

  const out = { kept: 0, raised: 0, lowered: 0, noRecommendation: 0 };
  for (const d of docs) {
    const rec = d.aiFormatData?.recommendedStructure?.targetWordCount;
    const recValue = typeof rec === 'number' ? rec : rec?.recommended;
    if (typeof recValue !== 'number' || recValue <= 0) {
      out.noRecommendation += 1;
      continue;
    }
    // Within 5% counts as kept — nudging 1,500 to 1,520 is not disagreement.
    const delta = (d.targetWordCount - recValue) / recValue;
    if (Math.abs(delta) <= 0.05) out.kept += 1;
    else if (delta > 0) out.raised += 1;
    else out.lowered += 1;
  }
  return out;
}

/**
 * How much the engine offers per analysed article. CURRENT STATE ONLY: each
 * re-analysis overwrites these fields, so this is a snapshot of what articles
 * hold right now, not a history of what was ever suggested.
 */
async function getEngineOffer() {
  const rows = await Content.aggregate([
    { $match: { analysisStatus: 'ready' } },
    {
      $project: {
        nlpTerms: { $size: { $ifNull: ['$benchmark.topNlpTerms', []] } },
        related: { $size: { $ifNull: ['$relatedSearches', []] } },
        paa: { $size: { $ifNull: ['$peopleAlsoAsk', []] } },
        aeoGroups: { $size: { $ifNull: ['$aiAnswerAnalysis.query_groups', []] } },
      },
    },
    {
      $group: {
        _id: null,
        articles: { $sum: 1 },
        nlpTerms: { $avg: '$nlpTerms' },
        related: { $avg: '$related' },
        paa: { $avg: '$paa' },
        aeoGroups: { $avg: '$aeoGroups' },
      },
    },
  ]);
  const r = rows[0];
  const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : 0);
  return {
    analysedArticles: r?.articles ?? 0,
    avgNlpTerms: round(r?.nlpTerms),
    avgRelatedSearches: round(r?.related),
    avgPeopleAlsoAsk: round(r?.paa),
    avgAeoQueryGroups: round(r?.aeoGroups),
    currentStateOnly: true,
  };
}

/** Keyword activity that happens after an article exists. */
async function getKeywordActivity() {
  const [gsc, tracked, promptSources, research] = await Promise.all([
    Content.aggregate([
      { $group: { _id: null, applied: { $sum: { $size: { $ifNull: ['$appliedGscQueries', []] } } } } },
    ]),
    Content.aggregate([
      { $group: { _id: null, tracked: { $sum: { $size: { $ifNull: ['$trackedPrompts', []] } } } } },
    ]),
    AiTrackerPrompt.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }]),
    KeywordResearchHistory.aggregate([
      { $group: { _id: null, searches: { $sum: 1 }, workspaces: { $addToSet: '$workspaceId' } } },
    ]),
  ]);

  const bySource = {};
  for (const r of promptSources) bySource[r._id || 'manual'] = r.count;

  return {
    gscQueriesApplied: gsc[0]?.applied ?? 0,
    keywordsTracked: tracked[0]?.tracked ?? 0,
    trackerPromptsBySource: bySource,
    researchSeeds: research[0]?.searches ?? 0,
    researchWorkspaces: (research[0]?.workspaces ?? []).length,
  };
}

async function getContentChoices() {
  const [ledger, creation, contentType, language, country, device, wordCount, offer, activity] =
    await Promise.all([
      getKeywordLedger(),
      getCreationShape(),
      distribution('contentType', { includeEmptyAs: '(not set)' }),
      distribution('language'),
      distribution('country'),
      distribution('device', { includeEmptyAs: '(unset)' }),
      getWordCountChoice(),
      getEngineOffer(),
      getKeywordActivity(),
    ]);

  // Types nobody picks are the actionable ones when pruning the wizard, so the
  // zero-count entries are materialised rather than omitted.
  const contentTypeFull = {};
  for (const t of CONTENT_TYPES) contentTypeFull[t] = contentType[t] ?? 0;
  for (const [k, v] of Object.entries(contentType)) if (!(k in contentTypeFull)) contentTypeFull[k] = v;

  return {
    // No window: this reads product state, not a TTL'd event stream.
    scope: 'all-time',
    createdViaSince: CREATED_VIA_SINCE,
    keywordLedger: ledger,
    creation,
    settings: { contentType: contentTypeFull, language, country, device, wordCount },
    engineOffer: offer,
    keywordActivity: activity,
  };
}

module.exports = {
  getContentChoices, getKeywordLedger, getCreationShape, getWordCountChoice,
  getEngineOffer, getKeywordActivity, CONTENT_TYPES, sourceOf,
};
