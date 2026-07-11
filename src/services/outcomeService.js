/**
 * Rec 14 — outcome feedback loop. Records what happened AFTER optimization:
 * the content's score, GSC position/clicks for its primary keyword, and AI
 * visibility (Rec 11 tracking). Cost $0: GSC API is free (5-min cached in
 * gscService), everything else is Mongo.
 *
 * FUTURE (explicitly out of v1): anonymized cross-customer learning over
 * (recommendation-applied → outcome) pairs. Needs an anonymization design and
 * a ToS review before any aggregation across organizations is built.
 */

const Content = require('../models/Content');
const ContentOutcome = require('../models/ContentOutcome');
const Workspace = require('../models/Workspace');
const Site = require('../models/Site');
const GscConnection = require('../models/GscConnection');
const gscService = require('./gscService');
// Namespace require (not destructured) so tests can stub the series lookup.
const trackerSeries = require('./trackerSeriesService');

// Sweep eligibility: analyzed content that is published or was edited
// recently — abandoned drafts stop accumulating rows.
const MAX_IDLE_DAYS = 120;

/** UTC midnight of "now" — the per-day snapshot key. */
function utcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Resolve the GSC (orgId, siteUrl) pair for a workspace, or null when GSC is
 * not connected / no property is linked. Mirrors the opportunities
 * controller's resolution.
 */
async function resolveGscContext(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select('organizationId').lean();
  const orgId = ws?.organizationId;
  if (!orgId) return null;
  const conn = await GscConnection.findOne({ organizationId: orgId }).select('refreshToken').lean();
  if (!conn?.refreshToken) return null;
  const site = await Site.findOne({ workspaceId, gscPropertyId: { $nin: [null, ''] } }).lean();
  if (!site?.gscPropertyId) return null;
  return { orgId, siteUrl: site.gscPropertyId };
}

/**
 * Take (or refresh) today's snapshot for one content. Null-safe throughout:
 * disconnected GSC, unfound keyword, or tracking-off all still snapshot the
 * score. Upserts on {contentId, utc-day} — max one row per content per day
 * regardless of trigger (unique index enforces it).
 *
 * `gscCtx` can be passed in by the sweep (per-workspace cache); when omitted
 * it is resolved here.
 */
async function snapshotContent(content, { source = 'cron', gscCtx, now = new Date() } = {}) {
  const fields = {
    workspaceId: content.workspaceId,
    overallScore: typeof content.score === 'number' ? content.score : null,
    gscPosition: null,
    gscClicks: null,
    gscImpressions: null,
    aiCited: null,
    aiMentioned: null,
    source,
  };

  // GSC stats for the primary keyword — best-effort.
  const primary = ((content.targetKeywords || [])[0] || '').trim();
  if (primary) {
    try {
      const ctx = gscCtx !== undefined ? gscCtx : await resolveGscContext(content.workspaceId);
      if (ctx) {
        const stats = await gscService.getKeywordStats(ctx.orgId, ctx.siteUrl, primary, '28d');
        fields.gscPosition = stats.position;
        fields.gscClicks = stats.clicks;
        fields.gscImpressions = stats.impressions;
      }
    } catch (err) {
      console.error(`[outcome] GSC stats failed for content ${content._id}:`, err.message);
    }
  }

  // AI visibility from tracker scans (Rec 11) — best-effort.
  if (Array.isArray(content.trackedPrompts) && content.trackedPrompts.length > 0) {
    try {
      const { series } = await trackerSeries.getScanSeriesForPrompts(content.workspaceId, content.trackedPrompts, 14);
      const latest = series[series.length - 1];
      if (latest) {
        fields.aiCited = latest.cited;
        fields.aiMentioned = latest.mentioned;
      }
    } catch (err) {
      console.error(`[outcome] tracker series failed for content ${content._id}:`, err.message);
    }
  }

  const filter = { contentId: content._id, date: utcDay(now) };
  const update = { $set: fields };
  const opts = { new: true, upsert: true, setDefaultsOnInsert: true };
  try {
    return await ContentOutcome.findOneAndUpdate(filter, update, opts);
  } catch (err) {
    // Concurrent same-day triggers (cron sweep × reanalyze completion, or two
    // backend instances) can both try to insert the same {contentId, day} key
    // → one hits the unique index. The row now exists — retry as an update.
    if (err && err.code === 11000) {
      return ContentOutcome.findOneAndUpdate(filter, update, opts);
    }
    throw err;
  }
}

/**
 * Weekly sweep: snapshot every eligible content (analyzed + published-or-
 * recently-edited). Runs in batches until the eligible set is DRAINED or the
 * maxTotal ceiling is hit — a single capped batch sorted by recency would
 * permanently starve published-but-stable contents (the exact contents this
 * feature exists for). Contents already snapshotted today (e.g. by the
 * reanalyze trigger, or a prior run after a restart) are excluded up front,
 * which also makes the sweep idempotent. GSC context cached per workspace;
 * per-doc failures are counted, never fatal, and can't cause a re-select loop
 * (the in-memory attempted set covers failures too).
 */
async function runOutcomeSweep({ batchSize = 100, maxTotal = 1000, now = new Date() } = {}) {
  const day = utcDay(now);
  const idleCutoff = new Date(now.getTime() - MAX_IDLE_DAYS * 86400000);

  let snapshotted = 0;
  let errors = 0;
  let seen = 0;
  const gscCtxCache = new Map(); // workspaceId → ctx | null
  const attempted = new Set(); // String(_id) tried this run (success OR failure)
  const attemptedIds = []; // raw _ids for the $nin (keep ObjectId type intact)

  while (seen < maxTotal) {
    // Already-done today (any trigger, any instance) + already-attempted.
    const doneIds = await ContentOutcome.distinct('contentId', { date: day });
    const batch = await Content.find({
      analysisStatus: 'ready',
      _id: { $nin: [...doneIds, ...attemptedIds] },
      $or: [
        { publishedUrl: { $nin: [null, ''] } },
        { updatedAt: { $gte: idleCutoff } },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(Math.min(batchSize, maxTotal - seen))
      .select('score targetKeywords trackedPrompts workspaceId publishedUrl');

    // Belt-and-suspenders: drop anything already attempted even if the query
    // didn't exclude it (guarantees termination regardless of store behavior).
    const fresh = batch.filter((c) => !attempted.has(String(c._id)));
    if (fresh.length === 0) break;
    seen += fresh.length;

    for (const content of fresh) {
      attempted.add(String(content._id));
      attemptedIds.push(content._id);
      try {
        const wsKey = String(content.workspaceId);
        let ctx = gscCtxCache.get(wsKey);
        if (ctx === undefined) {
          ctx = await resolveGscContext(content.workspaceId).catch(() => null);
          gscCtxCache.set(wsKey, ctx);
        }
        await snapshotContent(content, { source: 'cron', gscCtx: ctx, now });
        snapshotted += 1;
      } catch (err) {
        errors += 1;
        console.error(`[outcome] snapshot failed for content ${content._id}:`, err.message);
      }
    }
  }

  console.log(`[outcome] sweep: snapshotted ${snapshotted}, errors ${errors} (of ${seen} candidates)`);
  return { candidates: seen, snapshotted, errors };
}

/** Time-ordered series for one content, last `days` days. */
async function getOutcomeSeries(contentId, days = 180) {
  const cutoff = new Date(Date.now() - days * 86400000);
  return ContentOutcome.find({ contentId, date: { $gte: cutoff } })
    .sort({ date: 1 })
    .select('-__v')
    .lean();
}

/**
 * First-vs-latest deltas over a series. Per metric, the FIRST and LAST
 * non-null points are compared, so a mid-series GSC disconnect doesn't zero
 * the story. Sign conventions:
 *   positionDelta: negative = IMPROVED (position 14 → 8 gives -6)
 *   clicksDelta / scoreDelta: positive = improved
 * Fewer than 2 non-null points for a metric → null delta.
 */
function computeDelta(series) {
  const span = (key) => {
    const points = (series || []).filter((s) => s[key] != null);
    if (points.length < 2) return null;
    return { first: points[0][key], last: points[points.length - 1][key] };
  };

  const pos = span('gscPosition');
  const clicks = span('gscClicks');
  const score = span('overallScore');
  const latest = (series || [])[Math.max(0, (series || []).length - 1)];

  return {
    positionDelta: pos ? +(pos.last - pos.first).toFixed(1) : null,
    positionFirst: pos ? pos.first : null,
    positionLast: pos ? pos.last : null,
    clicksDelta: clicks ? clicks.last - clicks.first : null,
    scoreDelta: score ? score.last - score.first : null,
    aiCitedNow: latest ? latest.aiCited === true : false,
  };
}

/**
 * Monthly-report rows: contents of a workspace whose outcome history spans
 * ≥ 2 snapshots at least 14 days apart → {title, contentNumber, deltas}.
 */
async function getReportDeltas(workspaceId, { maxRows = 20 } = {}) {
  const contents = await Content.find({ workspaceId, analysisStatus: 'ready' })
    .select('title contentNumber')
    .lean();

  const rows = [];
  for (const content of contents) {
    if (rows.length >= maxRows) break;
    const series = await getOutcomeSeries(content._id, 365);
    if (series.length < 2) continue;
    const spanDays = (new Date(series[series.length - 1].date) - new Date(series[0].date)) / 86400000;
    if (spanDays < 14) continue;
    const delta = computeDelta(series);
    if (delta.positionDelta == null && delta.clicksDelta == null && delta.scoreDelta == null) continue;
    rows.push({
      title: content.title || 'Untitled',
      contentNumber: content.contentNumber,
      positionDelta: delta.positionDelta,
      clicksDelta: delta.clicksDelta,
      scoreDelta: delta.scoreDelta,
    });
  }
  return rows;
}

module.exports = {
  snapshotContent,
  runOutcomeSweep,
  getOutcomeSeries,
  computeDelta,
  getReportDeltas,
  utcDay,
};
