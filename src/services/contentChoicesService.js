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
const GenerationSnapshot = require('../models/GenerationSnapshot');

/**
 * Soft-deleted articles must not count anywhere (P5-2). Deletion sets
 * status:'archived' via updateMany, which bypasses the status enum, so the
 * value is easy to miss when reading the model — every query here filters it.
 */
const LIVE = { status: { $ne: 'archived' } };

/**
 * $size throws if its argument isn't an array, and `benchmark` and
 * `aiAnswerAnalysis` are Schema.Types.Mixed — nothing guarantees their shape.
 * One malformed document would 500 the whole endpoint for every admin (P5-1),
 * so array-ness is checked before counting.
 */
const safeSize = (path) => ({
  $cond: [{ $isArray: `$${path}` }, { $size: `$${path}` }, 0],
});

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
const CREATED_VIA_DEFAULT = '2026-08-08T00:00:00.000Z';
const _createdViaParsed = new Date(process.env.CREATED_VIA_SINCE || CREATED_VIA_DEFAULT);
if (Number.isNaN(_createdViaParsed.getTime())) {
  // Invalid Date makes every comparison false, silently deleting the legacy
  // bucket and reporting pre-rollout articles as genuine manual creations —
  // exactly the inflation the bucket exists to prevent. Warn once at boot.
  console.warn(`[contentChoices] CREATED_VIA_SINCE="${process.env.CREATED_VIA_SINCE}" is not a valid date — using ${CREATED_VIA_DEFAULT}`);
}
const CREATED_VIA_SINCE = Number.isNaN(_createdViaParsed.getTime())
  ? new Date(CREATED_VIA_DEFAULT)
  : _createdViaParsed;

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
    { ...LIVE, targetKeywords: { $exists: true, $ne: [] } },
    // workspaceId, not workspaceNumber: Content declares no workspaceNumber
    // path, so mongoose stripped it and this column read 0 for every keyword.
    { targetKeywords: 1, createdVia: 1, workspaceId: 1, score: 1, createdAt: 1 }
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
      if (d.workspaceId != null) row.workspaces.add(String(d.workspaceId));
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
      // The average covers only scored articles; without this the denominator
      // is invisible (plan §9.0 — every figure names its own).
      scored: r.scored,
      lastCreated: r.lastCreated,
    }))
    .sort((a, b) => b.articles - a.articles || a.keyword.localeCompare(b.keyword));
}

/** How articles start, and how many keywords people actually give them. */
async function getCreationShape() {
  const docs = await Content.find(LIVE, { createdVia: 1, createdAt: 1, targetKeywords: 1 }).lean();

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
    { $match: LIVE },
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
    { ...LIVE, targetWordCount: { $gt: 0 } },
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
    { $match: { ...LIVE, analysisStatus: 'ready' } },
    {
      $project: {
        nlpTerms: safeSize('benchmark.topNlpTerms'),
        related: safeSize('relatedSearches'),
        paa: safeSize('peopleAlsoAsk'),
        aeoGroups: safeSize('aiAnswerAnalysis.query_groups'),
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

/**
 * Tier 2 (Phase 6): what the human did with what the engine offered.
 *
 * Every figure names its own denominator — "of articles that reached this
 * point", never "of all articles" — because adoption measured against a
 * population that was never offered anything is meaningless (§9.0).
 */
async function getAdoption() {
  const [outlineRows, citability, gscRows] = await Promise.all([
    Content.aggregate([
      { $match: { ...LIVE, 'outlineEdit.depth': { $ne: null } } },
      { $group: { _id: '$outlineEdit.depth', count: { $sum: 1 } } },
    ]),
    Content.aggregate([
      { $match: { ...LIVE, 'citabilitySnapshot.total': { $gt: 0 } } },
      {
        $group: {
          _id: null,
          articles: { $sum: 1 },
          covered: { $sum: '$citabilitySnapshot.covered' },
          total: { $sum: '$citabilitySnapshot.total' },
          // Bands rather than an average: one article using 12 of 14 phrases
          // and another using 0 is a different story from two using 6.
          none: { $sum: { $cond: [{ $eq: ['$citabilitySnapshot.covered', 0] }, 1, 0] } },
          most: {
            $sum: {
              $cond: [
                { $gte: [{ $divide: ['$citabilitySnapshot.covered', '$citabilitySnapshot.total'] }, 0.5] },
                1, 0,
              ],
            },
          },
        },
      },
    ]),
    Content.aggregate([
      { $match: LIVE },
      {
        $group: {
          _id: null,
          // Articles where GSC actually offered something can't be recovered —
          // the offer isn't stored — so this reports acceptance only, and the
          // denominator is named as such rather than implied.
          withApplied: { $sum: { $cond: [{ $gt: [safeSize('appliedGscQueries'), 0] }, 1, 0] } },
          withTracked: { $sum: { $cond: [{ $gt: [safeSize('trackedPrompts'), 0] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const outlineByDepth = {};
  for (const r of outlineRows) outlineByDepth[r._id] = r.count;
  const outlineTotal = Object.values(outlineByDepth).reduce((a, b) => a + b, 0);
  const c = citability[0];

  return {
    outline: {
      // Denominator: outline approvals recorded, NOT all articles. Approvals
      // only exist from Phase 6 onward — earlier ones were never captured.
      approvals: outlineTotal,
      byDepth: outlineByDepth,
      keptAsIs: outlineByDepth.unedited ?? 0,
      capturedSince: 'phase-6',
    },
    aeoPhrases: {
      // Denominator: articles marked done that had phrases offered.
      articlesWithPhrases: c?.articles ?? 0,
      phrasesOffered: c?.total ?? 0,
      phrasesUsed: c?.covered ?? 0,
      articlesUsingNone: c?.none ?? 0,
      articlesUsingMost: c?.most ?? 0,
    },
    accepted: {
      articlesWithGscApplied: gscRows[0]?.withApplied ?? 0,
      articlesWithTrackedKeywords: gscRows[0]?.withTracked ?? 0,
      note: 'acceptance only — what GSC offered is not stored, so no offer denominator exists',
    },
  };
}

/**
 * Tier 3 (Phase 7): the settings that produced each AI run.
 *
 * DEFAULTS IN FORCE — the editor's own initial values (EditorChatBar):
 *   targetScore 75, maxIterations 5   · in force since 2026-08-09 (Phase 7)
 * Snapshots store raw values, never a "kept the default" verdict, so changing
 * these constants reinterprets history correctly instead of leaving old rows
 * judged under rules that no longer apply. If they change, add the new value
 * and its date here rather than editing the line above.
 */
const RUN_DEFAULTS = { targetScore: 75, maxIterations: 5 };

async function getGenerationSettings() {
  const [totals, byVoice, byAvatar, byCommand] = await Promise.all([
    GenerationSnapshot.aggregate([
      { $match: { impersonatedBy: null } },
      {
        $group: {
          _id: null,
          runs: { $sum: 1 },
          // "Sent and differs from the default" is the only thing that counts
          // as changing it. A run that sent nothing tells us nothing about the
          // control, so it is tracked separately rather than read as agreement.
          scoreSent: { $sum: { $cond: [{ $ne: ['$targetScore', null] }, 1, 0] } },
          scoreChanged: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$targetScore', null] }, { $ne: ['$targetScore', RUN_DEFAULTS.targetScore] }] },
                1, 0,
              ],
            },
          },
          iterSent: { $sum: { $cond: [{ $ne: ['$maxIterations', null] }, 1, 0] } },
          iterChanged: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$maxIterations', null] }, { $ne: ['$maxIterations', RUN_DEFAULTS.maxIterations] }] },
                1, 0,
              ],
            },
          },
          withVoice: { $sum: { $cond: [{ $ne: ['$voiceId', null] }, 1, 0] } },
          withAvatar: { $sum: { $cond: [{ $ne: ['$avatarId', null] }, 1, 0] } },
        },
      },
    ]),
    GenerationSnapshot.aggregate([
      { $match: { impersonatedBy: null, voiceId: { $ne: null } } },
      // Two-stage group rather than $addToSet: accumulating every distinct
      // contentId in one document is unbounded memory on the one collection
      // that never expires, and hits the 16MB group-doc ceiling eventually.
      { $group: { _id: { voiceId: '$voiceId', contentId: '$contentId' }, runs: { $sum: 1 } } },
      { $group: { _id: '$_id.voiceId', runs: { $sum: '$runs' }, articles: { $sum: 1 } } },
      { $sort: { runs: -1 } },
    ]),
    GenerationSnapshot.aggregate([
      { $match: { impersonatedBy: null, avatarId: { $ne: null } } },
      { $group: { _id: { avatarId: '$avatarId', contentId: '$contentId' }, runs: { $sum: 1 } } },
      { $group: { _id: '$_id.avatarId', runs: { $sum: '$runs' }, articles: { $sum: 1 } } },
      { $sort: { runs: -1 } },
    ]),
    GenerationSnapshot.aggregate([
      { $match: { impersonatedBy: null, commandName: { $ne: null } } },
      { $group: { _id: '$commandName', runs: { $sum: 1 } } },
      { $sort: { runs: -1 } },
    ]),
  ]);

  const t = totals[0];
  return {
    runs: t?.runs ?? 0,
    defaults: RUN_DEFAULTS,
    targetScore: { sent: t?.scoreSent ?? 0, changed: t?.scoreChanged ?? 0 },
    maxIterations: { sent: t?.iterSent ?? 0, changed: t?.iterChanged ?? 0 },
    withVoice: t?.withVoice ?? 0,
    withAvatar: t?.withAvatar ?? 0,
    // No $limit: the export contract promises full tables, and a silently
    // truncated list is indistinguishable from a short one. The UI shows a head.
    byVoice: byVoice.map((v) => ({ voiceId: v._id, runs: v.runs, articles: v.articles })),
    byAvatar: byAvatar.map((v) => ({ avatarId: v._id, runs: v.runs, articles: v.articles })),
    byCommand: byCommand.map((v) => ({ command: v._id, runs: v.runs })),
    // Capture starts with Phase 7 — runs before it left no snapshot, so a small
    // `runs` next to a large article count is history, not inactivity.
    capturedSince: 'phase-7',
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
  const [ledger, creation, contentType, language, country, device, wordCount, offer, activity, adoption, generation] =
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
      getAdoption(),
      getGenerationSettings(),
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
    adoption,
    generation,
  };
}

module.exports = {
  getContentChoices, getKeywordLedger, getCreationShape, getWordCountChoice,
  getEngineOffer, getKeywordActivity, getAdoption, getGenerationSettings, CONTENT_TYPES, sourceOf, RUN_DEFAULTS,
};
