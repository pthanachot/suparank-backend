/**
 * Monthly workspace reporting engine (Phase 14).
 *
 * generateSnapshot aggregates ONLY data that already lives in Mongo:
 *   - Content:        score / wordCount / status / title / contentNumber
 *   - AiTracker(+Scan): monitor count, scans in the period, latest scan's
 *                       visibility / mentionRate / shareOfVoice (computed
 *                       from the stored per-platform results — mirrors
 *                       aiTrackerController.computeWeightedVisibility)
 *   - GSC:            Site.snapshotStats (locally cached rollup written by
 *                       the GSC sync). Report generation v1 NEVER calls
 *                       Google APIs — no local stats → gsc: null.
 *
 * Each source is wrapped individually: a failing source lands as null with
 * a note in data.sourceErrors, never a thrown partial.
 */

const crypto = require('crypto');
const ReportSnapshot = require('../models/ReportSnapshot');
const ReportShare = require('../models/ReportShare');
const Workspace = require('../models/Workspace');
const Content = require('../models/Content');
const AiTracker = require('../models/AiTracker');
const AiTrackerScan = require('../models/AiTrackerScan');
const Site = require('../models/Site');
const brandService = require('./brandService');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_SHARE_TTL_DAYS = 90;

// ─── Period helpers ─────────────────────────────────────────────

function isValidPeriod(period) {
  return typeof period === 'string' && PERIOD_RE.test(period);
}

/** UTC [start, end) bounds of a 'YYYY-MM' period. */
function periodBounds(period) {
  const [year, month] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

function _formatPeriod(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Current calendar month as 'YYYY-MM' (UTC). */
function currentPeriod(now = new Date()) {
  return _formatPeriod(now);
}

/** Previous calendar month as 'YYYY-MM' (UTC). */
function previousPeriod(now = new Date()) {
  return _formatPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/**
 * Human-readable label for a 'YYYY-MM' period, e.g. '2026-06' → 'June 2026'.
 * For client-facing surfaces (emails); falls back to the raw string if the
 * input isn't a well-formed period.
 */
function formatPeriodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return String(period || '');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ─── Source aggregators (each returns its section or throws) ────

async function _aggregateContent(workspaceId, { start, end }) {
  // Library-as-of-period-end semantics: total / avgScore / scoredCount /
  // topContent are bounded by createdAt < periodEnd so a historical report
  // stops mutating when content is created later. They are intentionally
  // NOT bounded by periodStart — scoring is a library health metric, not a
  // this-month-only metric (the UI copy says "library, as of this period").
  //
  // score: { $gt: 0 } — Content.score defaults to 0, so an unscored article
  // is indistinguishable from a genuine 0/100. Excluding 0 deliberately
  // treats default-0 as "not scored yet"; a real zero score is vanishingly
  // rare and would otherwise drag averages with unscored noise.
  const asOfPeriodEnd = { $lt: end };
  const [total, createdInPeriod, scoredAgg, top] = await Promise.all([
    Content.countDocuments({ workspaceId, createdAt: asOfPeriodEnd }),
    Content.countDocuments({ workspaceId, createdAt: { $gte: start, $lt: end } }),
    Content.aggregate([
      { $match: { workspaceId, createdAt: asOfPeriodEnd, score: { $gt: 0 } } },
      { $group: { _id: null, avgScore: { $avg: '$score' }, count: { $sum: 1 } } },
    ]),
    Content.find({ workspaceId, createdAt: asOfPeriodEnd, score: { $gt: 0 } })
      .select('contentNumber title score wordCount')
      .sort({ score: -1 })
      .limit(10)
      .lean(),
  ]);

  const scored = (scoredAgg && scoredAgg[0]) || { avgScore: 0, count: 0 };
  return {
    total,
    createdInPeriod,
    avgScore: scored.count > 0 ? Math.round(scored.avgScore) : 0,
    scoredCount: scored.count,
    topContent: (top || []).map((c) => ({
      contentNumber: c.contentNumber,
      title: c.title,
      score: c.score,
      wordCount: c.wordCount,
    })),
  };
}

/**
 * Weighted visibility from stored platform results — same formula and
 * weights as aiTrackerController.computeWeightedVisibility (0.4 mention,
 * 0.3 position, 0.3 citation) so report numbers match the dashboard.
 */
function _computeScanMetrics(scan) {
  const platforms = (scan.results || []).flatMap((r) => r.platforms || []);
  const valid = platforms.filter((p) => !p.error);
  if (valid.length === 0) return { visibility: 0, mentionRate: 0, shareOfVoice: 0 };

  const mentioned = valid.filter((p) => p.mentioned);
  const cited = valid.filter((p) => p.cited);
  const mentionRate = (mentioned.length / valid.length) * 100;
  const citationRate = mentioned.length > 0 ? (cited.length / mentioned.length) * 100 : 0;

  let positionScore = 0;
  if (mentioned.length > 0) {
    const values = mentioned.map((p) => {
      if (p.position != null) return ((10 - p.position) / 9) * 100; // 1=best → 100
      if (p.brandRanking && p.brandRanking.length > 0) {
        const idx = p.brandRanking.findIndex((b) => b.isTargetBrand);
        if (idx >= 0) {
          return p.brandRanking.length > 1 ? (1 - idx / (p.brandRanking.length - 1)) * 100 : 100;
        }
      }
      return 50;
    });
    positionScore = values.reduce((s, v) => s + v, 0) / mentioned.length;
  }

  const visibility = Math.round(mentionRate * 0.4 + positionScore * 0.3 + citationRate * 0.3);

  // Share of voice: own mentions vs all brand mentions in competitorResults.
  // Denominator construction keeps the ratio bounded in [0,1] even when the
  // scan predates own-brand competitor rows (see aiTrackerController F6-01).
  const competitorResults = scan.competitorResults || [];
  const ownRow = competitorResults.find((cr) => cr.isOwn);
  const ownMentions = ownRow ? ownRow.mentions || 0 : mentioned.length;
  const allCompMentions = competitorResults.reduce((s, cr) => s + (cr.mentions || 0), 0);
  const denom = ownRow ? allCompMentions : allCompMentions + ownMentions;
  const shareOfVoice = denom > 0 ? Math.round((ownMentions / denom) * 100) : 0;

  return { visibility, mentionRate: Math.round(mentionRate), shareOfVoice };
}

async function _aggregateTracker(workspaceId, { start, end }) {
  const trackers = await AiTracker.find({ workspaceId }).select('_id').lean();
  if (!trackers || trackers.length === 0) return null;

  const trackerIds = trackers.map((t) => t._id);
  const [scansInPeriod, latestScan] = await Promise.all([
    AiTrackerScan.countDocuments({
      trackerId: { $in: trackerIds },
      status: 'ready',
      completedAt: { $gte: start, $lt: end },
    }),
    // completedAt < periodEnd: the "latest scan" is the latest AS OF the
    // report's period — a June report must never absorb July scans, and
    // regenerating a historical report stays stable.
    AiTrackerScan.findOne({
      trackerId: { $in: trackerIds },
      status: 'ready',
      completedAt: { $lt: end },
    })
      .sort({ completedAt: -1 })
      .lean(),
  ]);

  return {
    monitors: trackers.length,
    scansInPeriod,
    latest: latestScan
      ? {
          ..._computeScanMetrics(latestScan),
          scannedAt: latestScan.completedAt || null,
        }
      : null,
  };
}

async function _aggregateGsc(workspaceId) {
  const sites = await Site.find({ workspaceId }).select('url snapshotStats').lean();
  const withStats = (sites || []).filter((s) => s.snapshotStats);
  if (withStats.length === 0) return null; // no local GSC data → gsc: null

  const clicks = withStats.reduce((s, x) => s + (x.snapshotStats.clicks || 0), 0);
  const impressions = withStats.reduce((s, x) => s + (x.snapshotStats.impressions || 0), 0);
  const avgCtr =
    Math.round((withStats.reduce((s, x) => s + (x.snapshotStats.ctr || 0), 0) / withStats.length) * 100) / 100;
  const avgPosition =
    Math.round((withStats.reduce((s, x) => s + (x.snapshotStats.position || 0), 0) / withStats.length) * 10) / 10;
  const updatedAt = withStats.reduce((latest, x) => {
    const u = x.snapshotStats.updatedAt;
    return u && (!latest || u > latest) ? u : latest;
  }, null);

  return { sites: withStats.length, clicks, impressions, avgCtr, avgPosition, updatedAt };
}

// ─── Snapshot generation ────────────────────────────────────────

/**
 * Build (or rebuild) the report for a workspace + period. Idempotent —
 * upserts the unique {workspaceId, period} row. Never throws for a failing
 * data source; only for invalid period / missing workspace.
 */
async function generateSnapshot(workspaceId, period) {
  if (!isValidPeriod(period)) {
    const err = new Error('Invalid period — expected YYYY-MM');
    err.status = 400;
    throw err;
  }

  const workspace = await Workspace.findById(workspaceId).select('name organizationId').lean();
  if (!workspace) {
    const err = new Error('Workspace not found');
    err.status = 404;
    throw err;
  }

  const bounds = periodBounds(period);
  const data = {
    workspaceName: workspace.name || 'Workspace',
    content: null,
    tracker: null,
    gsc: null,
  };
  const sourceErrors = [];

  // Each source is independent — one failing must not lose the others.
  try {
    data.content = await _aggregateContent(workspaceId, bounds);
  } catch (err) {
    sourceErrors.push({ source: 'content', error: err.message });
  }
  try {
    data.tracker = await _aggregateTracker(workspaceId, bounds);
  } catch (err) {
    sourceErrors.push({ source: 'tracker', error: err.message });
  }
  try {
    data.gsc = await _aggregateGsc(workspaceId);
  } catch (err) {
    sourceErrors.push({ source: 'gsc', error: err.message });
  }

  if (sourceErrors.length > 0) data.sourceErrors = sourceErrors;

  return ReportSnapshot.findOneAndUpdate(
    { workspaceId, period },
    {
      $set: {
        data,
        generatedAt: new Date(),
        organizationId: workspace.organizationId || null,
      },
      $setOnInsert: { workspaceId, period },
    },
    { new: true, upsert: true }
  );
}

/** All snapshots for a workspace (light projection, newest first). */
function getSnapshots(workspaceId) {
  return ReportSnapshot.find({ workspaceId })
    .select('period generatedAt')
    .sort({ period: -1 })
    .lean();
}

// ─── Share links ────────────────────────────────────────────────

/**
 * Mint a share token for a report. Only the hash is stored — the raw token
 * exists solely in the returned URL. `ttlDays` may be fractional (the PDF
 * renderer mints 15-minute internal tokens).
 */
async function createShare(reportId, { ttlDays = DEFAULT_SHARE_TTL_DAYS, internal = false, createdBy = null } = {}) {
  const report = await ReportSnapshot.findById(reportId).select('workspaceId organizationId').lean();
  if (!report) {
    const err = new Error('Report not found');
    err.status = 404;
    throw err;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const share = await ReportShare.create({
    reportId,
    workspaceId: report.workspaceId,
    organizationId: report.organizationId || null,
    tokenHash: ReportShare.hashToken(rawToken),
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    createdBy,
    internal,
  });

  return { share, rawToken };
}

/**
 * Resolve a raw share token into the PUBLIC report payload — display-safe
 * only: no ObjectIds, no token hashes, no org internals. Brand comes from
 * brandService so white-label tenants' clients see the agency identity.
 * Returns null for invalid/expired tokens (controller maps to 404).
 */
async function resolvePublicReport(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;

  const share = await ReportShare.findValidByToken(rawToken);
  if (!share) return null;

  const snapshot = await ReportSnapshot.findById(share.reportId).lean();
  if (!snapshot) return null;

  let brand = null;
  try {
    const resolved = await brandService.getBrandForOrg(snapshot.organizationId || null);
    const b = resolved.brand || {};
    brand = {
      productName: b.productName || 'SupaRank',
      logoUrl: b.logoUrl || '',
      logoIconUrl: b.logoIconUrl || '',
      faviconUrl: b.faviconUrl || '',
      primaryColor: b.primaryColor || '#2B5BE8',
      hideAttribution: Boolean(b.hideAttribution),
    };
  } catch (err) {
    console.error('[reports] brand lookup failed for public report:', err.message);
  }

  // Strip internal error details from the public payload: sourceErrors
  // carries raw err.message text (stack-adjacent internals) — the public
  // page only needs to know WHICH sources were unavailable, by name.
  const { workspaceName, sourceErrors, ...rest } = snapshot.data || {};
  const sourcesUnavailable = Array.isArray(sourceErrors)
    ? sourceErrors
        .map((e) => (typeof e === 'string' ? e : e && e.source))
        .filter(Boolean)
    : [];

  return {
    report: {
      workspaceName: workspaceName || 'Workspace',
      period: snapshot.period,
      generatedAt: snapshot.generatedAt,
      ...rest,
      ...(sourcesUnavailable.length > 0 ? { sourcesUnavailable } : {}),
    },
    brand,
  };
}

/** Revoke every user-facing share for a report (internal PDF rows survive). */
function revokeShares(reportId) {
  return ReportShare.deleteMany({ reportId, internal: { $ne: true } });
}

/**
 * Invariant: ONE live public link per report. Revokes all non-internal
 * shares, then mints a fresh one — every caller that creates a user-facing
 * share (controller re-share, monthly cron) must go through this so DELETE
 * /share reliably kills all access.
 */
async function rotateShare(reportId, opts = {}) {
  await revokeShares(reportId);
  return createShare(reportId, opts);
}

/** Set of reportIds (as strings) that currently have a live public share. */
async function findSharedReportIds(workspaceId) {
  const rows = await ReportShare.find({
    workspaceId,
    internal: { $ne: true },
    expiresAt: { $gt: new Date() },
  })
    .select('reportId')
    .lean();
  return new Set(rows.map((r) => String(r.reportId)));
}

module.exports = {
  PERIOD_RE,
  isValidPeriod,
  periodBounds,
  currentPeriod,
  previousPeriod,
  formatPeriodLabel,
  generateSnapshot,
  getSnapshots,
  createShare,
  rotateShare,
  resolvePublicReport,
  revokeShares,
  findSharedReportIds,
  DEFAULT_SHARE_TTL_DAYS,
};
