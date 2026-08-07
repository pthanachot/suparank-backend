/**
 * Monthly workspace reporting engine (Phase 14).
 *
 * generateSnapshot aggregates ONLY data that already lives in Mongo:
 *   - Content:        score / wordCount / status / title / contentNumber
 *   - AiTracker(+Scan): per-monitor scans-in-period + latest-scan metrics
 *                       (visibility / mentionRate / shareOfVoice, computed
 *                       from the stored per-platform results — mirrors
 *                       aiTrackerController.computeWeightedVisibility),
 *                       plus a workspace roll-up merged across every
 *                       monitor's latest scan
 *   - GSC:            GscPeriodStat rows (per-site per-calendar-month, written
 *                       by the GSC sync + daily cron sweep) — the named month's
 *                       real numbers. Falls back to Site.snapshotStats
 *                       (trailing-28d-at-last-sync) flagged approximate: true.
 *                       Report generation NEVER calls Google APIs — no local
 *                       data at all → gsc: null.
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
const GscPeriodStat = require('../models/GscPeriodStat');
const Opportunity = require('../models/Opportunity');
const brandService = require('./brandService');
// Brand/URL matching reused from the scan engine so report numbers dedup
// and attribute exactly like the AI-tracker dashboard.
const { isSameBrand, extractBrand, urlMatchesDomain } = require('./aiTrackerScanEngine');
// Per-prompt suggestion strings — same generator the dashboard shows, so the
// report's "What's next" never contradicts the in-app advice. Pure function;
// the controller never requires reportService (no cycle).
const { generatePromptSuggestions } = require('../controllers/aiTrackerController');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_SHARE_TTL_DAYS = 90;
// Phase 5: freelancer-written narrative on the report cover. Plain text,
// bounded — it ships to the logged-out public page and the PDF.
const COMMENTARY_MAX_LENGTH = 1500;

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

// ─── Phase 4: trend series + deltas + recommendations ───────────

// Trend/baseline scans only need metric fields — this projection drops
// aiResponse / citedUrls / fanoutQueries / prompt text, which dominate scan
// document size (a month of daily scans would otherwise pull tens of MB).
const SCAN_METRICS_PROJECTION =
  'completedAt results.platforms.platformId results.platforms.mentioned ' +
  'results.platforms.cited results.platforms.position results.platforms.error ' +
  'results.platforms.brandRanking results.platforms.sentimentScore competitorResults';

// Defensive cap: real cadences produce ≤31 in-period scans, but the dev
// time-scale can flood a month with hundreds. monitorsDetail.scansInPeriod
// carries the true count, so the cap is never silent.
const TREND_POINTS_CAP = 31;

/**
 * One trend point from one scan. Every point is a REAL scan — a week with
 * no scan simply has no point (the date axis carries the gap). "No scan"
 * must never be synthesized as visibility 0.
 */
function _scanTrendPoint(scan) {
  const metrics = _computeScanMetrics(scan);
  const valid = (scan.results || []).flatMap((r) => r.platforms || []).filter((p) => !p.error);
  const mentioned = valid.filter((p) => p.mentioned);
  const cited = valid.filter((p) => p.cited);
  const citationRate = mentioned.length > 0 ? Math.round((cited.length / mentioned.length) * 100) : 0;
  const scores = mentioned.filter((p) => p.sentimentScore != null).map((p) => p.sentimentScore);
  const sentiment = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
  return {
    date: scan.completedAt ? scan.completedAt.toISOString() : null,
    visibility: metrics.visibility,
    mentionRate: metrics.mentionRate,
    shareOfVoice: metrics.shareOfVoice,
    citationRate,
    sentiment,
  };
}

/**
 * Merge each monitor's latest scan into one pseudo-scan for the workspace
 * roll-up. A single scan passes through untouched so the one-monitor path
 * stays bit-identical to the pre-monitorsDetail behavior. Multi-monitor:
 * platform results concatenate (rates weight by prompt volume) and
 * competitor rows merge by lowercased name, with own-brand rows (isOwn)
 * summed into ONE row — _computeScanMetrics finds a single own row, so
 * leaving one per monitor would undercount share-of-voice's numerator.
 */
function _mergeLatestScans(scans) {
  if (scans.length === 1) return scans[0];

  const ownRow = { name: '', isOwn: true, mentions: 0 };
  let hasOwn = false;
  const byName = new Map();
  for (const scan of scans) {
    for (const cr of scan.competitorResults || []) {
      if (cr.isOwn) {
        hasOwn = true;
        if (!ownRow.name) ownRow.name = cr.name;
        ownRow.mentions += cr.mentions || 0;
        continue;
      }
      const key = String(cr.name || '').trim().toLowerCase();
      const existing = byName.get(key);
      if (existing) existing.mentions += cr.mentions || 0;
      else byName.set(key, { name: cr.name, mentions: cr.mentions || 0 });
    }
  }

  return {
    results: scans.flatMap((s) => s.results || []),
    competitorResults: [...(hasOwn ? [ownRow] : []), ...byName.values()],
  };
}

// ─── Phase 3: tracker enrichment (engines / funnel / competitors /
//     citations / highlights / prompt detail) ──────────────────────
//
// Everything below ships verbatim to the logged-out public report page and
// the A4 PDF, so it is bounded by design: query-level detail caps at 20
// rows (market guidance: 10–20 priority queries), answer text NEVER lands
// whole — ±200-char excerpts only, max one highlight per kind.

const PROMPT_ROWS_CAP = 20;
const COMPETITORS_CAP = 10; // non-own rows; the own row is always included
const CITATIONS_CAP = 10;
const EXCERPT_RADIUS = 200;
const ENGINE_ORDER = ['chatgpt', 'gemini', 'claude', 'perplexity'];

/** Strip HTML tags + markdown link syntax; collapse whitespace. */
function _cleanAnswerText(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function _truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str;
}

/**
 * ±EXCERPT_RADIUS chars around the first case-insensitive occurrence of
 * `needle` in the cleaned answer text; null when the needle is absent.
 */
function _excerptAround(text, needle) {
  const clean = _cleanAnswerText(text);
  if (!clean || !needle) return null;
  const idx = clean.toLowerCase().indexOf(String(needle).toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(clean.length, idx + String(needle).length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}

/** Weighted visibility of ONE prompt's platform results (scan-roll-up formula). */
function _promptVisibility(platforms) {
  return _computeScanMetrics({ results: [{ platforms }], competitorResults: [] }).visibility;
}

/**
 * Build the enriched tracker sections from each monitor's latest scan.
 * Returns null when no monitor has a scan (keys stay absent — legacy-safe).
 */
function _trackerEnrichment(perMonitor) {
  const withScans = perMonitor.filter((m) => m.latestScan);
  if (withScans.length === 0) return null;
  const multi = perMonitor.length > 1;

  // Flatten to per-prompt entries carrying their monitor context. Errored
  // platform results are excluded everywhere (S71 convention) — and a
  // prompt whose EVERY engine errored is dropped entirely: it has no data,
  // and counting it in the funnel would present a vendor outage as "not
  // mentioned" (data absence masquerading as brand absence).
  const entries = [];
  for (const m of withScans) {
    const ownBrand = m.tracker.domain ? extractBrand(m.tracker.domain) : null;
    for (const r of m.latestScan.results || []) {
      const platforms = (r.platforms || []).filter((p) => !p.error);
      if (platforms.length === 0) continue;
      entries.push({
        monitorName: m.tracker.name || m.tracker.domain,
        domain: m.tracker.domain,
        ownBrand,
        prompt: r.prompt || '',
        platforms,
      });
    }
  }
  if (entries.length === 0) return null;

  // ── Engines: per-platform roll-up (never a blended-only score) ──
  const byEngine = new Map();
  for (const e of entries) {
    for (const p of e.platforms) {
      if (!byEngine.has(p.platformId)) byEngine.set(p.platformId, []);
      byEngine.get(p.platformId).push(p);
    }
  }
  const engineRank = (id) => {
    const i = ENGINE_ORDER.indexOf(id);
    return i === -1 ? ENGINE_ORDER.length : i;
  };
  const engines = [...byEngine.entries()]
    .sort((a, b) => engineRank(a[0]) - engineRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([platformId, ps]) => ({
      platformId,
      prompts: ps.length,
      mentioned: ps.filter((p) => p.mentioned).length,
      cited: ps.filter((p) => p.cited).length,
      visibility: _computeScanMetrics({ results: [{ platforms: ps }], competitorResults: [] }).visibility,
    }));

  // ── Funnel: prompt-level mention → citation (named vs linked) ──
  const funnel = {
    prompts: entries.length,
    mentioned: entries.filter((e) => e.platforms.some((p) => p.mentioned)).length,
    cited: entries.filter((e) => e.platforms.some((p) => p.cited)).length,
  };

  // ── Competitors: own row + alias-deduped rivals (dashboard parity) ──
  // isOwn is persisted on new scans (Phase 3 schema fix); older scans need
  // the isSameBrand name fallback — same dual check the dashboard uses.
  const own = { name: '', mentions: 0, citations: 0, visibility: 0, isOwn: true };
  let ownFound = false;
  const rivals = [];
  for (const m of withScans) {
    const ownBrand = m.tracker.domain ? extractBrand(m.tracker.domain) : null;
    for (const cr of m.latestScan.competitorResults || []) {
      const name = cr.name || '';
      if (cr.isOwn === true || (ownBrand && isSameBrand(name, ownBrand))) {
        ownFound = true;
        if (!own.name) own.name = name || ownBrand;
        own.mentions += cr.mentions || 0;
        own.citations += cr.citations || 0;
        own.visibility = Math.max(own.visibility, cr.visibility || 0);
        continue;
      }
      const existing = rivals.find((d) => isSameBrand(d.name, name));
      if (existing) {
        existing.mentions += cr.mentions || 0;
        existing.citations += cr.citations || 0;
        existing.visibility = Math.max(existing.visibility, cr.visibility || 0);
        if (name.length > existing.name.length) existing.name = name; // keep longest alias
      } else {
        rivals.push({
          name,
          mentions: cr.mentions || 0,
          citations: cr.citations || 0,
          visibility: cr.visibility || 0,
          isOwn: false,
        });
      }
    }
  }
  if (!ownFound) {
    // Legacy scans with no identifiable own row: approximate own presence
    // from platform results — same fallback semantic as _computeScanMetrics.
    own.name = entries[0].ownBrand || 'You';
    own.mentions = entries.reduce((s, e) => s + e.platforms.filter((p) => p.mentioned).length, 0);
    own.citations = entries.reduce((s, e) => s + e.platforms.filter((p) => p.cited).length, 0);
    own.visibility = Math.round(
      (entries.filter((e) => e.platforms.some((p) => p.mentioned)).length / entries.length) * 100
    );
  }
  rivals.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
  const competitors = [own, ...rivals.slice(0, COMPETITORS_CAP)];

  // ── Citations won: the client's OWN pages the AI actually linked ──
  const citationsWon = [];
  const seenUrls = new Set();
  for (const e of entries) {
    for (const p of e.platforms) {
      for (const url of p.citedUrls || []) {
        if (seenUrls.has(url) || !urlMatchesDomain(url, e.domain)) continue;
        seenUrls.add(url);
        citationsWon.push({ url, prompt: _truncate(e.prompt, 120), platformId: p.platformId });
      }
    }
  }

  // ── Highlights: max one per kind, deterministic picks ──
  const scored = entries.map((e) => ({ e, vis: _promptVisibility(e.platforms) }));
  const highlights = [];

  // win: best-visibility prompt where an engine mentioned AND cited us
  const wins = scored
    .filter(({ e }) => e.platforms.some((p) => p.mentioned && p.cited && p.aiResponse))
    .sort((a, b) => b.vis - a.vis || a.e.prompt.localeCompare(b.e.prompt));
  for (const { e } of wins) {
    const p = e.platforms.find((pl) => pl.mentioned && pl.cited && pl.aiResponse);
    const excerpt = e.ownBrand ? _excerptAround(p.aiResponse, e.ownBrand) : null;
    if (excerpt) {
      highlights.push({ kind: 'win', prompt: _truncate(e.prompt, 160), platformId: p.platformId, excerpt });
      break;
    }
  }

  // competitor: we're absent but a rival is named — ranked by rival prominence
  let competitorEntry = null;
  const compCands = scored
    .filter(({ e }) => !e.platforms.some((p) => p.mentioned))
    .map(({ e }) => {
      for (const p of e.platforms) {
        const top = (p.brandRanking || []).find((b) => !b.isTargetBrand && b.brandName);
        if (top && p.aiResponse) {
          const excerpt = _excerptAround(p.aiResponse, top.brandName);
          if (excerpt) return { e, p, top, excerpt };
        }
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.top.mentionCount || 0) - (a.top.mentionCount || 0) || a.e.prompt.localeCompare(b.e.prompt));
  if (compCands.length > 0) {
    const c = compCands[0];
    competitorEntry = c.e;
    highlights.push({
      kind: 'competitor',
      prompt: _truncate(c.e.prompt, 160),
      platformId: c.p.platformId,
      competitor: c.top.brandName,
      excerpt: c.excerpt,
    });
  }

  // absence: nothing mentioned — show what the AI says instead (opening of
  // the longest answer). Skips the entry already used as the competitor pick.
  const absCands = scored
    .filter(({ e }) => e !== competitorEntry && !e.platforms.some((p) => p.mentioned))
    .map(({ e }) => {
      const p = [...e.platforms]
        .filter((pl) => pl.aiResponse)
        .sort((a, b) => (b.aiResponse || '').length - (a.aiResponse || '').length)[0];
      return p ? { e, p, clean: _cleanAnswerText(p.aiResponse) } : null;
    })
    .filter((c) => c && c.clean)
    .sort((a, b) => b.clean.length - a.clean.length || a.e.prompt.localeCompare(b.e.prompt));
  if (absCands.length > 0) {
    const c = absCands[0];
    highlights.push({
      kind: 'absence',
      prompt: _truncate(c.e.prompt, 160),
      platformId: c.p.platformId,
      excerpt: _truncate(c.clean, EXCERPT_RADIUS * 2),
    });
  }

  // ── Prompt detail: capped table, best-visibility first, never silent ──
  const rows = [...scored]
    .sort((a, b) => b.vis - a.vis || a.e.prompt.localeCompare(b.e.prompt))
    .slice(0, PROMPT_ROWS_CAP)
    .map(({ e, vis }) => ({
      prompt: _truncate(e.prompt, 200),
      ...(multi ? { monitor: e.monitorName } : {}),
      visibility: vis,
      engines: e.platforms.map((p) => ({
        platformId: p.platformId,
        mentioned: !!p.mentioned,
        cited: !!p.cited,
        position: p.position ?? null,
      })),
    }));

  // ── What's next: dashboard-parity suggestions for the WEAKEST prompt ──
  // (lowest visibility — where next month's work moves the needle most).
  const weakest = [...scored].sort((a, b) => a.vis - b.vis || a.e.prompt.localeCompare(b.e.prompt))[0];
  const promptSuggestions = weakest
    ? generatePromptSuggestions({ platforms: weakest.e.platforms }, null)
    : [];

  return {
    engines,
    funnel,
    competitors,
    citationsWon: citationsWon.slice(0, CITATIONS_CAP),
    highlights,
    promptsDetail: { totalTracked: entries.length, rows },
    ...(promptSuggestions.length > 0 ? { promptSuggestions } : {}),
  };
}

async function _aggregateTracker(workspaceId, { start, end }) {
  // Sorted by name so monitorsDetail ordering is deterministic across
  // regenerations (stable PDF/page ordering; find() natural order is not).
  const trackers = await AiTracker.find({ workspaceId }).select('_id name domain').sort({ name: 1 }).lean();
  if (!trackers || trackers.length === 0) return null;

  // Per-monitor aggregation. Pre-fix this was one findOne across every
  // trackerId — a multi-monitor workspace reported whichever monitor
  // happened to scan last while claiming `monitors: N` coverage.
  // completedAt < periodEnd on the latest scan keeps historical reports
  // stable: a June report must never absorb July scans.
  const perMonitor = await Promise.all(
    trackers.map(async (t) => {
      const [scansInPeriod, latestScan, baselineScan, trendScans] = await Promise.all([
        AiTrackerScan.countDocuments({
          trackerId: t._id,
          status: 'ready',
          completedAt: { $gte: start, $lt: end },
        }),
        AiTrackerScan.findOne({
          trackerId: t._id,
          status: 'ready',
          completedAt: { $lt: end },
        })
          .sort({ completedAt: -1 })
          .lean(),
        // Phase 4 baseline: the last scan BEFORE the period — the anchor
        // point trend charts and deltas compare against.
        AiTrackerScan.findOne({
          trackerId: t._id,
          status: 'ready',
          completedAt: { $lt: start },
        })
          .sort({ completedAt: -1 })
          .select(SCAN_METRICS_PROJECTION)
          .lean(),
        // Phase 4 trend: every in-period scan, slim projection (metrics
        // only — no answers). Newest-first + cap, reversed to ascending.
        AiTrackerScan.find({
          trackerId: t._id,
          status: 'ready',
          completedAt: { $gte: start, $lt: end },
        })
          .sort({ completedAt: -1 })
          .limit(TREND_POINTS_CAP)
          .select(SCAN_METRICS_PROJECTION)
          .lean(),
      ]);
      return { tracker: t, scansInPeriod, latestScan, baselineScan, trendScans };
    })
  );

  // Display-safe rows — no ObjectIds. Everything in `data` ships verbatim
  // to the logged-out public report page via resolvePublicReport.
  const monitorsDetail = perMonitor.map((m) => ({
    name: m.tracker.name || m.tracker.domain,
    domain: m.tracker.domain,
    scansInPeriod: m.scansInPeriod,
    latest: m.latestScan
      ? {
          ..._computeScanMetrics(m.latestScan),
          scannedAt: m.latestScan.completedAt || null,
        }
      : null,
  }));

  // Workspace roll-up across every monitor's latest scan (not just the
  // most recently scanned monitor). scannedAt keeps its old semantic:
  // the newest completedAt as of period end.
  const withScans = perMonitor.filter((m) => m.latestScan);
  let latest = null;
  if (withScans.length > 0) {
    const merged = _mergeLatestScans(withScans.map((m) => m.latestScan));
    const scannedAt = withScans.reduce((max, m) => {
      const c = m.latestScan.completedAt;
      return c && (!max || c > max) ? c : max;
    }, null);
    latest = { ..._computeScanMetrics(merged), scannedAt };
  }

  // Phase 3 enrichment — absent (not empty) when no monitor has a scan,
  // so legacy rendering and old-snapshot comparisons stay unchanged.
  const enrichment = _trackerEnrichment(perMonitor);

  // Phase 4 trend: flat point list, monitor-attributed when multi. Every
  // point is a real scan; the baseline (pre-period anchor) sorts first by
  // date and is flagged so charts can style it distinctly.
  const multi = trackers.length > 1;
  const trendPoints = [];
  for (const m of perMonitor) {
    const monitorName = m.tracker.name || m.tracker.domain;
    const pts = [];
    if (m.baselineScan) pts.push({ ..._scanTrendPoint(m.baselineScan), baseline: true });
    for (const s of [...(m.trendScans || [])].reverse()) pts.push(_scanTrendPoint(s));
    for (const p of pts) trendPoints.push(multi ? { monitor: monitorName, ...p } : p);
  }
  trendPoints.sort(
    (a, b) => String(a.date || '').localeCompare(String(b.date || '')) ||
      String(a.monitor || '').localeCompare(String(b.monitor || ''))
  );

  // Phase 4 baseline roll-up: merged across monitors exactly like `latest`,
  // so deltas compare like with like.
  const withBaselines = perMonitor.filter((m) => m.baselineScan);
  let baseline = null;
  if (withBaselines.length > 0) {
    const merged = _mergeLatestScans(withBaselines.map((m) => m.baselineScan));
    const scannedAt = withBaselines.reduce((max, m) => {
      const c = m.baselineScan.completedAt;
      return c && (!max || c > max) ? c : max;
    }, null);
    baseline = { ..._computeScanMetrics(merged), scannedAt };
  }

  return {
    monitors: trackers.length,
    scansInPeriod: perMonitor.reduce((s, m) => s + (m.scansInPeriod || 0), 0),
    latest,
    monitorsDetail,
    ...(baseline ? { baseline } : {}),
    ...(trendPoints.length > 0 ? { trend: trendPoints } : {}),
    ...(enrichment || {}),
  };
}

async function _aggregateGsc(workspaceId, period) {
  // Phase 2: prefer the persisted per-calendar-month rows (written by the
  // GSC sync and the daily cron sweep) — the NAMED month's real numbers,
  // stable across regenerations.
  const rows = await GscPeriodStat.find({ workspaceId, period }).lean();
  if (rows.length > 0) {
    const clicks = rows.reduce((s, r) => s + (r.clicks || 0), 0);
    const impressions = rows.reduce((s, r) => s + (r.impressions || 0), 0);
    const avgCtr = Math.round((rows.reduce((s, r) => s + (r.ctr || 0), 0) / rows.length) * 100) / 100;
    const avgPosition = Math.round((rows.reduce((s, r) => s + (r.position || 0), 0) / rows.length) * 10) / 10;
    const updatedAt = rows.reduce((latest, r) => {
      const u = r.updatedAt;
      return u && (!latest || u > latest) ? u : latest;
    }, null);
    // Coverage: the date through which EVERY site's numbers are complete
    // (min rangeEnd). Lets the UI label an in-progress month honestly —
    // "data through Aug 28" — instead of implying a full month.
    const dataThrough = rows.reduce((min, r) => {
      const e = r.rangeEnd;
      return e && (!min || e < min) ? e : min;
    }, null);
    // Merged top queries across sites, by clicks. Display-safe scalars only.
    const topQueries = rows
      .flatMap((r) => r.topQueries || [])
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      .slice(0, 10)
      .map((q) => ({
        query: q.query,
        clicks: q.clicks || 0,
        impressions: q.impressions || 0,
        ctr: q.ctr || 0,
        position: q.position || 0,
      }));
    return {
      sites: rows.length,
      clicks,
      impressions,
      avgCtr,
      avgPosition,
      updatedAt,
      ...(dataThrough ? { dataThrough } : {}),
      ...(topQueries.length > 0 ? { topQueries } : {}),
    };
  }

  // Fallback: Site.snapshotStats is a trailing-28d-at-last-sync window —
  // NOT the report period's data. Flagged approximate so the UI can label
  // it honestly instead of presenting current numbers under a past month.
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

  return { sites: withStats.length, clicks, impressions, avgCtr, avgPosition, updatedAt, approximate: true };
}

/**
 * Top 3 open opportunities for "What's next" — ai_citation_gap before
 * gsc_striking (the report's thesis is AI visibility), highest
 * potentialClicks first within a source. Two bounded per-source queries,
 * DB-sorted — a single capped list could return an arbitrary window when
 * many rows are open, silently dropping every citation-gap row whenever
 * striking rows dominate it. Display-safe rows only; null when nothing is
 * open (section omitted).
 */
async function _aggregateOpportunities(workspaceId) {
  const fetchTop = (source) =>
    Opportunity.find({ workspaceId, status: 'open', source })
      .sort({ 'metrics.potentialClicks': -1, _id: 1 }) // _id: deterministic tiebreak
      .limit(3)
      .select('source query page topQuery metrics')
      .lean();

  const [gaps, striking] = await Promise.all([
    fetchTop('ai_citation_gap'),
    fetchTop('gsc_striking'),
  ]);
  const rows = [...(gaps || []), ...(striking || [])];
  if (rows.length === 0) return null;

  return rows.slice(0, 3).map((o) => ({
    source: o.source,
    query: o.query || o.topQuery || '',
    page: o.page || '',
    potentialClicks: o.metrics?.potentialClicks ?? null,
  }));
}

/**
 * Headline deltas vs the previous period, baked at generate time so the
 * public page needs no second fetch. Each comparison exists only when BOTH
 * sides are real: tracker needs the pre-period baseline scan, GSC needs
 * period rows on both sides (the approximate fallback is never compared —
 * trailing-28d vs a real month would be a fabricated trend), content always
 * has a previous count. null when no comparison is possible at all.
 */
async function _computeDeltas(data, workspaceId, period) {
  const prevPeriod = previousPeriod(periodBounds(period).start);
  const prevBounds = periodBounds(prevPeriod);
  const d = (current, previous) => ({ current, previous, delta: current - previous });

  let tracker = null;
  const latest = data.tracker && data.tracker.latest;
  const baseline = data.tracker && data.tracker.baseline;
  if (latest && baseline) {
    tracker = {
      visibility: d(latest.visibility, baseline.visibility),
      mentionRate: d(latest.mentionRate, baseline.mentionRate),
      shareOfVoice: d(latest.shareOfVoice, baseline.shareOfVoice),
    };
  }

  let gsc = null;
  if (data.gsc && !data.gsc.approximate) {
    const prevRows = await GscPeriodStat.find({ workspaceId, period: prevPeriod }).lean();
    if (prevRows.length > 0) {
      const prevClicks = prevRows.reduce((s, r) => s + (r.clicks || 0), 0);
      const prevImpressions = prevRows.reduce((s, r) => s + (r.impressions || 0), 0);
      gsc = {
        clicks: d(data.gsc.clicks, prevClicks),
        impressions: d(data.gsc.impressions, prevImpressions),
      };
    }
  }

  let content = null;
  if (data.content) {
    const previousCreated = await Content.countDocuments({
      workspaceId,
      createdAt: { $gte: prevBounds.start, $lt: prevBounds.end },
    });
    content = { createdInPeriod: d(data.content.createdInPeriod, previousCreated) };
  }

  if (!tracker && !gsc && !content) return null;
  return { tracker, gsc, content };
}

// ─── Snapshot generation ────────────────────────────────────────

/**
 * Build (or rebuild) the report for a workspace + period. Idempotent —
 * upserts the unique {workspaceId, period} row. Never throws for a failing
 * data source; only for invalid period / missing workspace.
 */
async function generateSnapshot(workspaceId, period, { commentary } = {}) {
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

  if (commentary !== undefined) _validateCommentary(commentary);

  const bounds = periodBounds(period);
  const data = {
    workspaceName: workspace.name || 'Workspace',
    content: null,
    tracker: null,
    gsc: null,
    outcomes: null,
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
    data.gsc = await _aggregateGsc(workspaceId, period);
  } catch (err) {
    sourceErrors.push({ source: 'gsc', error: err.message });
  }
  // Rec 14: per-content before/after deltas for contents with ≥2 outcome
  // snapshots ≥14 days apart (namespace require so tests can stub it).
  try {
    const outcomeService = require('./outcomeService');
    const rows = await outcomeService.getReportDeltas(workspaceId);
    data.outcomes = rows.length > 0 ? { deltas: rows } : null;
  } catch (err) {
    sourceErrors.push({ source: 'outcomes', error: err.message });
  }
  // Phase 4: top open opportunities for "What's next" (AEO gaps first).
  try {
    data.opportunities = await _aggregateOpportunities(workspaceId);
  } catch (err) {
    data.opportunities = null;
    sourceErrors.push({ source: 'opportunities', error: err.message });
  }
  // Phase 4: headline deltas vs the previous period. Runs LAST — it reads
  // the sections above (tracker.latest/baseline, gsc, content) and only
  // queries for the previous-period counterparts.
  try {
    data.deltas = await _computeDeltas(data, workspaceId, period);
  } catch (err) {
    data.deltas = null;
    sourceErrors.push({ source: 'deltas', error: err.message });
  }

  // Phase 5: a provided commentary wins; otherwise carry the existing
  // snapshot's text forward — a full regenerate must never wipe the human
  // narrative. Empty string explicitly clears. Read JUST BEFORE the upsert
  // so a commentary edit landing during the (multi-second) aggregation
  // above isn't stomped by a stale pre-read; the residual race window is
  // one event-loop tick. Carried-forward legacy text is deliberately NOT
  // re-validated — regeneration must never brick on old data.
  const existing = await ReportSnapshot.findOne({ workspaceId, period })
    .select('data.commentary')
    .lean();
  const commentaryValue = commentary !== undefined ? commentary : existing?.data?.commentary;
  if (typeof commentaryValue === 'string' && commentaryValue.trim() !== '') {
    data.commentary = commentaryValue;
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

/**
 * Validate a PROVIDED commentary value. Lives in the service (not just the
 * controller) because these are exported seams — a future internal caller
 * must not be able to bake unbounded text into the public payload.
 */
function _validateCommentary(commentary) {
  if (typeof commentary !== 'string') {
    const err = new Error('commentary must be a string');
    err.status = 400;
    throw err;
  }
  if (commentary.length > COMMENTARY_MAX_LENGTH) {
    const err = new Error(`commentary must be at most ${COMMENTARY_MAX_LENGTH} characters`);
    err.status = 400;
    throw err;
  }
}

/**
 * Commentary-only edit (Phase 5). NEVER re-aggregates: outcomes and the
 * GSC fallback are current-state reads, so a full regenerate of a PAST
 * period would silently rewrite its history under the old heading — the
 * exact defect period-scoping exists to prevent. generatedAt is untouched
 * (it means "when the numbers were computed", not "when text was edited").
 * Returns the updated snapshot, or null when none exists for the period.
 */
async function updateCommentary(workspaceId, period, commentary) {
  if (!isValidPeriod(period)) {
    const err = new Error('Invalid period — expected YYYY-MM');
    err.status = 400;
    throw err;
  }
  _validateCommentary(commentary);
  return ReportSnapshot.findOneAndUpdate(
    { workspaceId, period },
    { $set: { 'data.commentary': commentary } },
    { new: true }
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

  // Phase 5: deny-by-default. Only keys the public page is designed to
  // render cross the auth boundary — a future baked field must be added
  // HERE deliberately (spread-by-default is how internals leak). Keys keep
  // their stored value (including null: the UI renders "not included"
  // cards from null sections).
  const PUBLIC_REPORT_KEYS = ['content', 'tracker', 'gsc', 'outcomes', 'opportunities', 'deltas'];

  const data = snapshot.data || {};
  const report = {
    workspaceName: data.workspaceName || 'Workspace',
    period: snapshot.period,
    generatedAt: snapshot.generatedAt,
  };
  for (const key of PUBLIC_REPORT_KEYS) {
    if (key in data) report[key] = data[key];
  }
  if (typeof data.commentary === 'string' && data.commentary.trim() !== '') {
    report.commentary = data.commentary;
  }

  // sourceErrors carries raw err.message text (stack-adjacent internals) —
  // the public page only needs to know WHICH sources were unavailable.
  const sourcesUnavailable = Array.isArray(data.sourceErrors)
    ? data.sourceErrors
        .map((e) => (typeof e === 'string' ? e : e && e.source))
        .filter(Boolean)
    : [];
  if (sourcesUnavailable.length > 0) report.sourcesUnavailable = sourcesUnavailable;

  return { report, brand };
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
  updateCommentary,
  COMMENTARY_MAX_LENGTH,
  getSnapshots,
  createShare,
  rotateShare,
  resolvePublicReport,
  revokeShares,
  findSharedReportIds,
  DEFAULT_SHARE_TTL_DAYS,
};
