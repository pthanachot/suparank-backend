const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const ReportSnapshot = require('../src/models/ReportSnapshot');
const ReportShare = require('../src/models/ReportShare');
const Workspace = require('../src/models/Workspace');
const Content = require('../src/models/Content');
const AiTracker = require('../src/models/AiTracker');
const AiTrackerScan = require('../src/models/AiTrackerScan');
const Site = require('../src/models/Site');
const GscPeriodStat = require('../src/models/GscPeriodStat');
const Opportunity = require('../src/models/Opportunity');
const brandService = require('../src/services/brandService');
const outcomeService = require('../src/services/outcomeService');
const reportService = require('../src/services/reportService');

const { ObjectId } = mongoose.Types;

// ─── Period helpers ──────────────────────────────────────────────

describe('reportService period validation', () => {
  it('accepts YYYY-MM', () => {
    assert.equal(reportService.isValidPeriod('2026-06'), true);
    assert.equal(reportService.isValidPeriod('1999-01'), true);
    assert.equal(reportService.isValidPeriod('2026-12'), true);
  });

  it('rejects malformed periods', () => {
    for (const bad of ['2026-13', '2026-00', '2026-6', '202606', '2026-06-01', 'garbage', '', null, undefined, 202606]) {
      assert.equal(reportService.isValidPeriod(bad), false, `expected invalid: ${bad}`);
    }
  });

  it('periodBounds returns UTC month [start, end)', () => {
    const { start, end } = reportService.periodBounds('2026-06');
    assert.equal(start.toISOString(), '2026-06-01T00:00:00.000Z');
    assert.equal(end.toISOString(), '2026-07-01T00:00:00.000Z');
  });

  it('previousPeriod handles the January wrap', () => {
    assert.equal(reportService.previousPeriod(new Date(Date.UTC(2026, 0, 15))), '2025-12');
    assert.equal(reportService.previousPeriod(new Date(Date.UTC(2026, 6, 1))), '2026-06');
    assert.equal(reportService.currentPeriod(new Date(Date.UTC(2026, 6, 3))), '2026-07');
  });

  it('formatPeriodLabel renders a human-readable month for client emails', () => {
    assert.equal(reportService.formatPeriodLabel('2026-06'), 'June 2026');
    assert.equal(reportService.formatPeriodLabel('2025-12'), 'December 2025');
    // malformed input falls back to the raw string, never throws
    assert.equal(reportService.formatPeriodLabel('nonsense'), 'nonsense');
    assert.equal(reportService.formatPeriodLabel(''), '');
    assert.equal(reportService.formatPeriodLabel(null), '');
  });
});

// ─── Token hashing (mirrors Invite semantics) ────────────────────

describe('ReportShare.hashToken', () => {
  it('is deterministic and does not store the raw token', () => {
    const raw = 'b'.repeat(64);
    assert.equal(ReportShare.hashToken(raw), ReportShare.hashToken(raw));
    assert.equal(ReportShare.hashToken(raw).length, 64); // sha256 hex
    assert.notEqual(ReportShare.hashToken(raw), raw);
    assert.notEqual(ReportShare.hashToken('a'), ReportShare.hashToken('b'));
  });
});

// ─── Stubbed-model harness ───────────────────────────────────────

const originals = {
  wsFindById: Workspace.findById,
  contentCount: Content.countDocuments,
  contentAggregate: Content.aggregate,
  contentFind: Content.find,
  trackerFind: AiTracker.find,
  scanCount: AiTrackerScan.countDocuments,
  scanFindOne: AiTrackerScan.findOne,
  scanFind: AiTrackerScan.find,
  siteFind: Site.find,
  gscPeriodFind: GscPeriodStat.find,
  oppFind: Opportunity.find,
  snapFindOneAndUpdate: ReportSnapshot.findOneAndUpdate,
  snapFindById: ReportSnapshot.findById,
  snapFindOne: ReportSnapshot.findOne,
  shareCreate: ReportShare.create,
  shareFindOne: ReportShare.findOne,
  shareDeleteMany: ReportShare.deleteMany,
  getBrandForOrg: brandService.getBrandForOrg,
  getReportDeltas: outcomeService.getReportDeltas,
};

let state;

beforeEach(() => {
  state = {
    workspace: { _id: new ObjectId(), name: 'Acme SEO', organizationId: new ObjectId() },
    contentTotal: 0,
    contentInPeriod: 0,
    scoredAgg: [],
    topContent: [],
    trackers: [],
    scansInPeriod: 0,
    latestScan: null,
    // Per-tracker overrides (Phase 1 per-monitor aggregation). Keys are
    // String(trackerId); when a key is present it wins over the scalar
    // fallbacks above.
    scansByTracker: null,
    latestScanByTracker: null,
    // Phase 4 per-tracker fixtures
    baselineScanByTracker: null,
    trendScansByTracker: null, // newest-first arrays (code reverses)
    opportunityRows: [],
    contentPrevInPeriod: 0,
    gscPeriodRowsByPeriod: null, // { 'YYYY-MM': rows } — wins over gscPeriodRows
    sites: [],
    trackerFindError: null,
    upserts: [],
    snapshotById: null,
    createdShares: [],
    shares: [], // emulated ReportShare store for findValidByToken
    deletedShareFilters: [],
    // query capture (F1/F2 period-bound assertions)
    contentCountQueries: [],
    contentAggregateMatch: null,
    contentFindQuery: null,
    scanFindOneQuery: null,
    scanFindOneQueries: [],
    scanCountQueries: [],
    scanTrendQueries: [],
    scanTrendLimits: [],
    scanTrendProjections: [],
    opportunityQueries: [],
  };

  Workspace.findById = () => ({ select: () => ({ lean: async () => state.workspace }) });

  // The createdInPeriod query is the only one with a $gte lower bound; the
  // total / scored / top queries are bounded by createdAt.$lt only (F1).
  // Phase 4 deltas add a PREVIOUS-period $gte query (2026-05 for the
  // fixtures' 2026-06) — disambiguate on the lower bound's month.
  Content.countDocuments = async (query) => {
    state.contentCountQueries.push(query);
    const gte = query.createdAt && query.createdAt.$gte;
    if (!gte) return state.contentTotal;
    return gte.toISOString().startsWith('2026-05')
      ? state.contentPrevInPeriod
      : state.contentInPeriod;
  };
  Content.aggregate = async (pipeline) => {
    state.contentAggregateMatch = pipeline?.[0]?.$match || null;
    return state.scoredAgg;
  };
  Content.find = (query) => {
    state.contentFindQuery = query;
    return {
      select: () => ({ sort: () => ({ limit: () => ({ lean: async () => state.topContent }) }) }),
    };
  };

  AiTracker.find = () => {
    const resolve = async () => {
      if (state.trackerFindError) throw state.trackerFindError;
      return state.trackers;
    };
    // Supports .select().lean() and .select().sort().lean() (Phase 1 adds
    // a deterministic name sort). The stub returns fixtures in state order.
    const chain = { select: () => chain, sort: () => chain, lean: resolve };
    return chain;
  };
  // Phase 1: _aggregateTracker queries per trackerId (bare id, not $in).
  // Per-tracker maps drive multi-monitor fixtures; scalar state remains the
  // fallback for single-monitor tests.
  AiTrackerScan.countDocuments = async (query) => {
    state.scanCountQueries.push(query);
    const key = String(query?.trackerId);
    if (state.scansByTracker && key in state.scansByTracker) return state.scansByTracker[key];
    return state.scansInPeriod;
  };
  // Phase 4: findOne serves BOTH the latest-scan query (completedAt < period
  // end) and the baseline query (completedAt < period START). All fixtures
  // use period 2026-06 — disambiguate on the $lt bound.
  const PERIOD_START_ISO = '2026-06-01T00:00:00.000Z';
  AiTrackerScan.findOne = (query) => {
    state.scanFindOneQuery = query;
    state.scanFindOneQueries.push(query);
    const resolve = async () => {
      const key = String(query?.trackerId);
      const isBaseline = query?.completedAt?.$lt?.toISOString?.() === PERIOD_START_ISO;
      if (isBaseline) {
        return (state.baselineScanByTracker && state.baselineScanByTracker[key]) || null;
      }
      if (state.latestScanByTracker && key in state.latestScanByTracker) {
        return state.latestScanByTracker[key];
      }
      return state.latestScan;
    };
    const chain = { sort: () => chain, select: () => chain, lean: resolve };
    return chain;
  };
  // Phase 4 trend list: newest-first, slim projection. Fixtures store
  // newest-first arrays (the code reverses to ascending).
  AiTrackerScan.find = (query) => {
    state.scanTrendQueries.push(query);
    const chain = {
      sort: () => chain,
      limit: (n) => {
        state.scanTrendLimits.push(n);
        return chain;
      },
      select: (proj) => {
        state.scanTrendProjections.push(proj);
        return chain;
      },
      lean: async () => {
        const key = String(query?.trackerId);
        return (state.trendScansByTracker && state.trendScansByTracker[key]) || [];
      },
    };
    return chain;
  };
  // Phase 4 opportunities: the service issues one DB-sorted query per
  // source — emulate the sort + limit so ranking tests reflect real reads.
  Opportunity.find = (query) => {
    state.opportunityQueries.push(query);
    let limit = Infinity;
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: (n) => {
        limit = n;
        return chain;
      },
      lean: async () =>
        state.opportunityRows
          .filter((r) => r.source === query.source)
          .sort((a, b) => (b.metrics?.potentialClicks ?? -1) - (a.metrics?.potentialClicks ?? -1))
          .slice(0, limit),
    };
    return chain;
  };

  Site.find = () => ({ select: () => ({ lean: async () => state.sites }) });

  // Phase 2: period-scoped GSC rows. Default [] → snapshotStats fallback.
  // Phase 4 deltas query the PREVIOUS period too — rows are period-keyed
  // via gscPeriodRowsByPeriod; the first-call capture stays the current-
  // period query (aggregation runs before deltas).
  state.gscPeriodRows = [];
  state.gscPeriodFindQuery = null;
  GscPeriodStat.find = (query) => {
    if (!state.gscPeriodFindQuery) state.gscPeriodFindQuery = query;
    return {
      lean: async () => {
        if (state.gscPeriodRowsByPeriod) return state.gscPeriodRowsByPeriod[query.period] || [];
        return query.period === '2026-06' ? state.gscPeriodRows : [];
      },
    };
  };

  ReportSnapshot.findOneAndUpdate = async (filter, update) => {
    state.upserts.push({ filter, update });
    return {
      _id: new ObjectId(),
      workspaceId: filter.workspaceId,
      period: filter.period,
      generatedAt: update.$set.generatedAt,
      organizationId: update.$set.organizationId,
      data: update.$set.data,
    };
  };
  ReportSnapshot.findById = (id) => {
    const doc = state.snapshotById;
    return {
      select: () => ({ lean: async () => doc }),
      lean: async () => doc,
    };
  };
  // Phase 5: generateSnapshot reads the existing snapshot's commentary to
  // carry it forward through full regenerates.
  state.existingSnapshot = null;
  ReportSnapshot.findOne = () => ({
    select: () => ({ lean: async () => state.existingSnapshot }),
    lean: async () => state.existingSnapshot,
  });

  ReportShare.create = async (doc) => {
    const created = { _id: new ObjectId(), ...doc };
    state.createdShares.push(created);
    state.shares.push(created);
    return created;
  };
  // findValidByToken calls this.findOne({ tokenHash, expiresAt: { $gt: now } })
  ReportShare.findOne = (query) => {
    const now = query.expiresAt?.$gt || new Date();
    const match =
      state.shares.find((s) => s.tokenHash === query.tokenHash && s.expiresAt > now) || null;
    return Promise.resolve(match);
  };
  ReportShare.deleteMany = async (filter) => {
    state.deletedShareFilters.push(filter);
    return { deletedCount: 1 };
  };

  brandService.getBrandForOrg = async () => ({
    brand: {
      productName: 'AgencyBrand',
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#123456',
      hideAttribution: true,
      supportEmail: 'secret-internal@agency.com',
    },
  });

  // Rec 14: outcomes source — stubbed (its own queries are covered in
  // outcomeService.test.js). state.outcomeDeltas drives the fixture.
  state.outcomeDeltas = [];
  outcomeService.getReportDeltas = async () => {
    if (state.outcomeDeltasError) throw state.outcomeDeltasError;
    return state.outcomeDeltas;
  };
});

afterEach(() => {
  Workspace.findById = originals.wsFindById;
  Content.countDocuments = originals.contentCount;
  Content.aggregate = originals.contentAggregate;
  Content.find = originals.contentFind;
  AiTracker.find = originals.trackerFind;
  AiTrackerScan.countDocuments = originals.scanCount;
  AiTrackerScan.findOne = originals.scanFindOne;
  AiTrackerScan.find = originals.scanFind;
  Site.find = originals.siteFind;
  GscPeriodStat.find = originals.gscPeriodFind;
  Opportunity.find = originals.oppFind;
  ReportSnapshot.findOneAndUpdate = originals.snapFindOneAndUpdate;
  ReportSnapshot.findById = originals.snapFindById;
  ReportSnapshot.findOne = originals.snapFindOne;
  ReportShare.create = originals.shareCreate;
  ReportShare.findOne = originals.shareFindOne;
  ReportShare.deleteMany = originals.shareDeleteMany;
  brandService.getBrandForOrg = originals.getBrandForOrg;
  outcomeService.getReportDeltas = originals.getReportDeltas;
});

// ─── generateSnapshot ────────────────────────────────────────────

describe('reportService.generateSnapshot', () => {
  it('rejects an invalid period with status 400 (no workspace lookup)', async () => {
    await assert.rejects(
      () => reportService.generateSnapshot(state.workspace._id, '2026-13'),
      (err) => err.status === 400
    );
    await assert.rejects(
      () => reportService.generateSnapshot(state.workspace._id, 'June 2026'),
      (err) => err.status === 400
    );
    assert.equal(state.upserts.length, 0);
  });

  it('404s when the workspace is missing', async () => {
    state.workspace = null;
    await assert.rejects(
      () => reportService.generateSnapshot(new ObjectId(), '2026-06'),
      (err) => err.status === 404
    );
  });

  it('aggregates content, tracker and gsc into an idempotent upsert', async () => {
    state.contentTotal = 12;
    state.contentInPeriod = 4;
    state.scoredAgg = [{ _id: null, avgScore: 71.4, count: 9 }];
    state.topContent = [
      { contentNumber: 11111111, title: 'Best article', score: 92, wordCount: 1800, _id: new ObjectId() },
      { contentNumber: 22222222, title: 'Second', score: 85, wordCount: 1200, _id: new ObjectId() },
    ];
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'Main site', domain: 'acme.com' },
      { _id: t2, name: 'Shop', domain: 'shop.acme.com' },
    ];
    // Per-monitor fixtures: t1 carries the period's scans, t2 is idle —
    // pre-Phase-1 this workspace reported t2 as covered ("monitors: 2")
    // while its numbers came from a single cross-tracker findOne.
    state.scansByTracker = { [String(t1)]: 3, [String(t2)]: 0 };
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-28T00:00:00Z'),
        results: [
          {
            promptId: new ObjectId(),
            prompt: 'best seo tool',
            platforms: [
              { platformId: 'chatgpt', mentioned: true, cited: true, position: 1, error: false },
              { platformId: 'gemini', mentioned: false, cited: false, error: false },
              { platformId: 'claude', mentioned: true, cited: false, position: 10, error: false },
              { platformId: 'perplexity', mentioned: false, cited: false, error: true }, // errored — excluded
            ],
          },
        ],
        competitorResults: [
          { name: 'Us', mentions: 2, isOwn: true },
          { name: 'Rival', mentions: 6 },
        ],
      },
      [String(t2)]: null,
    };
    state.sites = [
      { url: 'https://acme.com', snapshotStats: { clicks: 100, impressions: 4000, ctr: 2.5, position: 12.4, updatedAt: new Date('2026-06-30') } },
      { url: 'https://acme.dev', snapshotStats: null }, // never synced — excluded
    ];

    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const { data } = snapshot;

    assert.equal(data.workspaceName, 'Acme SEO');

    // content
    assert.equal(data.content.total, 12);
    assert.equal(data.content.createdInPeriod, 4);
    assert.equal(data.content.avgScore, 71);
    assert.equal(data.content.scoredCount, 9);
    assert.equal(data.content.topContent.length, 2);
    assert.deepEqual(Object.keys(data.content.topContent[0]).sort(), ['contentNumber', 'score', 'title', 'wordCount']);

    // tracker: 3 valid platforms, 2 mentioned → 67% mention rate;
    // positions 1 & 10 → positionScore 50; citationRate 50 →
    // visibility = 66.7*0.4 + 50*0.3 + 50*0.3 = 56.7 → 57
    assert.equal(data.tracker.monitors, 2);
    assert.equal(data.tracker.scansInPeriod, 3); // summed per monitor: 3 + 0
    assert.equal(data.tracker.latest.mentionRate, 67);
    assert.equal(data.tracker.latest.visibility, 57);
    assert.equal(data.tracker.latest.shareOfVoice, 25); // 2 own / 8 total
    assert.ok(data.tracker.latest.scannedAt);

    // Phase 1: per-monitor rows — the idle monitor is visibly unscanned
    // instead of silently borrowing the other monitor's numbers.
    assert.equal(data.tracker.monitorsDetail.length, 2);
    assert.deepEqual(
      data.tracker.monitorsDetail.map((m) => m.name),
      ['Main site', 'Shop']
    );
    assert.equal(data.tracker.monitorsDetail[0].scansInPeriod, 3);
    assert.equal(data.tracker.monitorsDetail[0].latest.visibility, 57);
    assert.equal(data.tracker.monitorsDetail[1].scansInPeriod, 0);
    assert.equal(data.tracker.monitorsDetail[1].latest, null);

    // gsc: only the site with local snapshotStats counts. No period rows in
    // this fixture → snapshotStats fallback, which must self-identify as
    // approximate (trailing-28d data under a named month).
    assert.equal(data.gsc.sites, 1);
    assert.equal(data.gsc.clicks, 100);
    assert.equal(data.gsc.impressions, 4000);
    assert.equal(data.gsc.avgPosition, 12.4);
    assert.equal(data.gsc.approximate, true);

    assert.equal(data.sourceErrors, undefined);

    // Idempotent upsert keyed by {workspaceId, period}
    assert.equal(state.upserts.length, 1);
    assert.deepEqual(state.upserts[0].filter, { workspaceId: state.workspace._id, period: '2026-06' });
    assert.equal(state.upserts[0].update.$set.organizationId, state.workspace.organizationId);
  });

  it('bounds content queries by createdAt < periodEnd (library as of period end)', async () => {
    await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const end = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01
    const start = new Date(Date.UTC(2026, 5, 1));

    // total: as-of-period-end, upper bound only
    const totalQuery = state.contentCountQueries.find((q) => q.createdAt && !q.createdAt.$gte);
    assert.ok(totalQuery, 'total count must be bounded by createdAt');
    assert.equal(totalQuery.createdAt.$lt.toISOString(), end.toISOString());

    // createdInPeriod: [start, end)
    const periodQuery = state.contentCountQueries.find((q) => q.createdAt && q.createdAt.$gte);
    assert.ok(periodQuery);
    assert.equal(periodQuery.createdAt.$gte.toISOString(), start.toISOString());
    assert.equal(periodQuery.createdAt.$lt.toISOString(), end.toISOString());

    // avgScore/scoredCount aggregate: bounded + score $gt 0 (default-0 = unscored)
    assert.ok(state.contentAggregateMatch);
    assert.equal(state.contentAggregateMatch.createdAt.$lt.toISOString(), end.toISOString());
    assert.deepEqual(state.contentAggregateMatch.score, { $gt: 0 });

    // topContent find: bounded + score $gt 0
    assert.ok(state.contentFindQuery);
    assert.equal(state.contentFindQuery.createdAt.$lt.toISOString(), end.toISOString());
    assert.deepEqual(state.contentFindQuery.score, { $gt: 0 });
  });

  it('bounds the latest tracker scan by completedAt < periodEnd, per tracker', async () => {
    const trackerId = new ObjectId();
    state.trackers = [{ _id: trackerId, name: 'Main', domain: 'acme.com' }];
    await reportService.generateSnapshot(state.workspace._id, '2026-06');

    const end = new Date(Date.UTC(2026, 6, 1));
    // Phase 4 also fires a baseline findOne ($lt = period START) — pick the
    // latest-scan query ($lt = period end) out of the capture list.
    const latestQuery = state.scanFindOneQueries.find(
      (q) => q.completedAt && q.completedAt.$lt.toISOString() === end.toISOString()
    );
    assert.ok(latestQuery, 'latest scan findOne must run');
    assert.equal(latestQuery.status, 'ready');
    // Phase 1: queried by bare trackerId (one query per monitor), not $in
    assert.equal(String(latestQuery.trackerId), String(trackerId));
    assert.equal(latestQuery.trackerId.$in, undefined);
  });

  it('empty workspace → zeroed content, tracker null, gsc null', async () => {
    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const { data } = snapshot;

    assert.deepEqual(data.content, {
      total: 0,
      createdInPeriod: 0,
      avgScore: 0,
      scoredCount: 0,
      topContent: [],
    });
    assert.equal(data.tracker, null); // no monitors
    assert.equal(data.gsc, null); // no local GSC stats
  });

  it('Rec 14: outcome deltas land under data.outcomes when qualifying rows exist', async () => {
    state.outcomeDeltas = [
      { title: 'Improved article', contentNumber: 1, positionDelta: -6, clicksDelta: 20, scoreDelta: 15 },
    ];
    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(snapshot.data.outcomes.deltas.length, 1);
    assert.equal(snapshot.data.outcomes.deltas[0].positionDelta, -6);
    assert.equal(snapshot.data.sourceErrors, undefined);
  });

  it('Rec 14: no qualifying contents → outcomes null (key present, no fake table)', async () => {
    state.outcomeDeltas = [];
    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(snapshot.data.outcomes, null);
  });

  it('Rec 14: outcome source failure isolated to sourceErrors', async () => {
    state.outcomeDeltasError = new Error('outcome db down');
    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(snapshot.data.outcomes, null);
    assert.ok(snapshot.data.sourceErrors.some((e) => e.source === 'outcomes'));
    // Other sources unaffected.
    assert.ok(snapshot.data.content);
  });

  it('a failing source lands as null + sourceErrors, others survive', async () => {
    state.contentTotal = 5;
    state.trackerFindError = new Error('tracker collection unavailable');
    state.sites = [
      { url: 'https://acme.com', snapshotStats: { clicks: 10, impressions: 200, ctr: 5, position: 3, updatedAt: new Date() } },
    ];

    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const { data } = snapshot;

    assert.equal(data.content.total, 5); // content still aggregated
    assert.equal(data.tracker, null); // failed source → null
    assert.equal(data.gsc.clicks, 10); // later source still aggregated
    assert.equal(data.sourceErrors.length, 1);
    assert.equal(data.sourceErrors[0].source, 'tracker');
    assert.match(data.sourceErrors[0].error, /unavailable/);
    assert.equal(state.upserts.length, 1); // still persisted — never throws partial
  });
});

// ─── Phase 2: period-scoped GSC ──────────────────────────────────

describe('reportService period-scoped GSC', () => {
  it('prefers GscPeriodStat rows: period numbers, merged topQueries, no approximate flag', async () => {
    // snapshotStats deliberately carries DIFFERENT numbers — if any of them
    // surface, the aggregation read the wrong source.
    state.sites = [
      { url: 'https://acme.com', snapshotStats: { clicks: 99999, impressions: 99999, ctr: 9, position: 1, updatedAt: new Date() } },
    ];
    state.gscPeriodRows = [
      {
        clicks: 120,
        impressions: 3000,
        ctr: 4,
        position: 8,
        updatedAt: new Date('2026-07-02T00:00:00Z'),
        rangeEnd: '2026-06-30', // this site's month is complete
        topQueries: [
          { query: 'alpha', clicks: 50, impressions: 500, ctr: 10, position: 2 },
          { query: 'beta', clicks: 10, impressions: 300, ctr: 3.33, position: 9 },
        ],
      },
      {
        clicks: 30,
        impressions: 1000,
        ctr: 3,
        position: 12,
        updatedAt: new Date('2026-07-03T00:00:00Z'),
        rangeEnd: '2026-06-27', // synced earlier — 3 days short
        topQueries: [{ query: 'gamma', clicks: 40, impressions: 400, ctr: 10, position: 4 }],
      },
    ];

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    // Read path keyed by {workspaceId, period}
    assert.deepEqual(state.gscPeriodFindQuery, {
      workspaceId: state.workspace._id,
      period: '2026-06',
    });

    assert.equal(data.gsc.sites, 2);
    assert.equal(data.gsc.clicks, 150);
    assert.equal(data.gsc.impressions, 4000);
    assert.equal(data.gsc.avgCtr, 3.5);
    assert.equal(data.gsc.avgPosition, 10);
    assert.equal(data.gsc.updatedAt.toISOString(), '2026-07-03T00:00:00.000Z');
    // Coverage = MIN rangeEnd — the date through which every site is complete
    assert.equal(data.gsc.dataThrough, '2026-06-27');
    // Real period data — never flagged approximate
    assert.equal(data.gsc.approximate, undefined);
    // topQueries merged across sites, sorted by clicks
    assert.deepEqual(
      data.gsc.topQueries.map((q) => q.query),
      ['alpha', 'gamma', 'beta']
    );
    // Display-safe scalar rows only
    assert.deepEqual(Object.keys(data.gsc.topQueries[0]).sort(), [
      'clicks',
      'ctr',
      'impressions',
      'position',
      'query',
    ]);
  });

  it('falls back to snapshotStats flagged approximate when no period rows exist', async () => {
    state.gscPeriodRows = [];
    state.sites = [
      { url: 'https://acme.com', snapshotStats: { clicks: 10, impressions: 200, ctr: 5, position: 3, updatedAt: new Date() } },
    ];

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.equal(data.gsc.clicks, 10);
    assert.equal(data.gsc.approximate, true);
    assert.equal(data.gsc.topQueries, undefined); // snapshotStats has none
    assert.equal(data.gsc.dataThrough, undefined); // coverage is a period-row concept
  });

  it('still returns gsc: null when neither period rows nor snapshotStats exist', async () => {
    state.gscPeriodRows = [];
    state.sites = [{ url: 'https://acme.dev', snapshotStats: null }];

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(data.gsc, null);
  });
});

// ─── Phase 1: per-monitor tracker aggregation ────────────────────

describe('reportService per-monitor tracker aggregation', () => {
  /** One-prompt scan fixture: chatgpt-only, parameterized outcome. */
  function scanFixture({ completedAt, mentioned, cited, position, competitorResults }) {
    return {
      completedAt,
      results: [
        {
          promptId: new ObjectId(),
          prompt: 'q',
          platforms: [
            { platformId: 'chatgpt', mentioned, cited, position, error: false },
          ],
        },
      ],
      competitorResults,
    };
  }

  it('each monitor aggregates its own scans; roll-up merges across monitors', async () => {
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'Main site', domain: 'acme.com' },
      { _id: t2, name: 'Docs', domain: 'docs.acme.com' },
    ];
    state.scansByTracker = { [String(t1)]: 2, [String(t2)]: 1 };
    state.latestScanByTracker = {
      // t1: mentioned + cited at position 1 → visibility 100
      [String(t1)]: scanFixture({
        completedAt: new Date('2026-06-20T00:00:00Z'),
        mentioned: true,
        cited: true,
        position: 1,
        competitorResults: [
          { name: 'Us', mentions: 3, isOwn: true },
          { name: 'RivalA', mentions: 3 },
        ],
      }),
      // t2: not mentioned → visibility 0
      [String(t2)]: scanFixture({
        completedAt: new Date('2026-06-25T00:00:00Z'),
        mentioned: false,
        cited: false,
        position: null,
        competitorResults: [
          { name: 'Us', mentions: 1, isOwn: true },
          { name: 'RivalA', mentions: 1 },
          { name: 'RivalB', mentions: 2 },
        ],
      }),
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    // Per-monitor rows keep their own metrics
    assert.equal(tracker.monitorsDetail.length, 2);
    const [m1, m2] = tracker.monitorsDetail;
    assert.equal(m1.latest.visibility, 100);
    assert.equal(m1.latest.mentionRate, 100);
    assert.equal(m1.latest.shareOfVoice, 50); // 3 own / 6 total
    assert.equal(m2.latest.visibility, 0);
    assert.equal(m2.latest.mentionRate, 0);
    assert.equal(m2.latest.shareOfVoice, 25); // 1 own / 4 total

    // Roll-up merges the union: 2 valid platform results, 1 mentioned
    assert.equal(tracker.scansInPeriod, 3); // 2 + 1
    assert.equal(tracker.latest.mentionRate, 50);
    // Own rows summed (3+1), competitors merged by name: RivalA 4, RivalB 2
    assert.equal(tracker.latest.shareOfVoice, 40); // 4 own / 10 total
    // Defect regression: the roll-up equals NEITHER monitor alone
    assert.notEqual(tracker.latest.visibility, m1.latest.visibility);
    assert.notEqual(tracker.latest.visibility, m2.latest.visibility);
    // scannedAt keeps its old semantic: newest completedAt as of period end
    assert.equal(tracker.latest.scannedAt.toISOString(), '2026-06-25T00:00:00.000Z');
  });

  it('merges persisted-shape scans (no isOwn — the schema strips it) via the name fallback', async () => {
    // Real persisted scans NEVER carry isOwn: competitorResultSchema has no
    // such path, so Mongoose strict casting drops the engine's flag at save
    // time. _computeScanMetrics then takes its fallback branch (ownMentions =
    // mentioned platform count; denominator = competitor mentions + own).
    // This pins the roll-up through _mergeLatestScans on that real shape.
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'Main', domain: 'acme.com' },
      { _id: t2, name: 'Shop', domain: 'shop.acme.com' },
    ];
    state.scansByTracker = { [String(t1)]: 1, [String(t2)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: scanFixture({
        completedAt: new Date('2026-06-20T00:00:00Z'),
        mentioned: true,
        cited: false,
        position: 1,
        // own-brand row persists as a plain named row, isOwn stripped
        competitorResults: [
          { name: 'Acme', mentions: 2 },
          { name: 'RivalA', mentions: 3 },
        ],
      }),
      [String(t2)]: scanFixture({
        completedAt: new Date('2026-06-22T00:00:00Z'),
        mentioned: false,
        cited: false,
        position: null,
        competitorResults: [
          { name: 'Acme', mentions: 1 },
          { name: 'RivalA', mentions: 1 },
        ],
      }),
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    // Fallback SoV: ownMentions = 1 (merged mentioned count), denominator =
    // all competitor mentions (2+3+1+1 = 7, name-grouping preserves sums) + 1
    // → 1/8 = 12.5 → 13. A lost row (bad merge) would shift this number.
    assert.equal(tracker.latest.shareOfVoice, 13);
    assert.equal(tracker.latest.mentionRate, 50); // 1 of 2 valid results

    // Per-monitor rows use the same fallback independently
    assert.equal(tracker.monitorsDetail[0].latest.shareOfVoice, 17); // 1/(5+1)
    assert.equal(tracker.monitorsDetail[1].latest.shareOfVoice, 0); // 0 mentioned
  });

  it('single-monitor roll-up is bit-identical to the monitor row (pass-through)', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: scanFixture({
        completedAt: new Date('2026-06-10T00:00:00Z'),
        mentioned: true,
        cited: false,
        position: 5,
        competitorResults: [
          { name: 'Us', mentions: 2, isOwn: true },
          { name: 'Rival', mentions: 2 },
        ],
      }),
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.deepEqual(data.tracker.latest, data.tracker.monitorsDetail[0].latest);
  });

  it('a monitor with no scans yields latest: null without poisoning the roll-up', async () => {
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'Main', domain: 'acme.com' },
      { _id: t2, name: 'New client site', domain: 'new.acme.com' },
    ];
    state.scansByTracker = { [String(t1)]: 1, [String(t2)]: 0 };
    state.latestScanByTracker = {
      [String(t1)]: scanFixture({
        completedAt: new Date('2026-06-15T00:00:00Z'),
        mentioned: true,
        cited: true,
        position: 1,
        competitorResults: [{ name: 'Us', mentions: 1, isOwn: true }],
      }),
      [String(t2)]: null,
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    assert.equal(tracker.monitors, 2);
    assert.equal(tracker.monitorsDetail[1].latest, null);
    assert.equal(tracker.monitorsDetail[1].scansInPeriod, 0);
    // Roll-up is exactly the scanned monitor's metrics (single-scan merge)
    assert.deepEqual(tracker.latest, tracker.monitorsDetail[0].latest);
  });

  it('every monitor gets its own period-bounded queries', async () => {
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'A', domain: 'a.com' },
      { _id: t2, name: 'B', domain: 'b.com' },
    ];

    await reportService.generateSnapshot(state.workspace._id, '2026-06');

    const end = new Date(Date.UTC(2026, 6, 1));
    const start = new Date(Date.UTC(2026, 5, 1));

    // Phase 4: each monitor now fires TWO findOnes — latest (< period end)
    // and baseline (< period START). Both per-id, both status-bounded.
    assert.equal(state.scanFindOneQueries.length, 4);
    const latestQueries = state.scanFindOneQueries.filter(
      (q) => q.completedAt.$lt.toISOString() === end.toISOString()
    );
    const baselineQueries = state.scanFindOneQueries.filter(
      (q) => q.completedAt.$lt.toISOString() === start.toISOString()
    );
    assert.equal(latestQueries.length, 2);
    assert.equal(baselineQueries.length, 2);
    for (const group of [latestQueries, baselineQueries]) {
      assert.deepEqual(
        group.map((q) => String(q.trackerId)).sort(),
        [String(t1), String(t2)].sort()
      );
      for (const q of group) assert.equal(q.status, 'ready');
    }

    // One count per monitor, each [start, end) bounded
    assert.equal(state.scanCountQueries.length, 2);
    for (const q of state.scanCountQueries) {
      assert.equal(q.status, 'ready');
      assert.equal(q.completedAt.$gte.toISOString(), start.toISOString());
      assert.equal(q.completedAt.$lt.toISOString(), end.toISOString());
    }

    // One trend list per monitor: [start, end) bounded, slim projection —
    // answer text must never be pulled for trend math.
    assert.equal(state.scanTrendQueries.length, 2);
    for (const q of state.scanTrendQueries) {
      assert.equal(q.status, 'ready');
      assert.equal(q.completedAt.$gte.toISOString(), start.toISOString());
      assert.equal(q.completedAt.$lt.toISOString(), end.toISOString());
    }
    for (const proj of state.scanTrendProjections) {
      assert.ok(proj.includes('results.platforms.mentioned'));
      assert.ok(!proj.includes('aiResponse'));
    }
    assert.ok(state.scanTrendLimits.every((n) => n === 31));
  });

  it('monitorsDetail is display-safe: no tracker ObjectIds in data.tracker', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 0 };
    state.latestScanByTracker = { [String(t1)]: null };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.ok(data.tracker);
    const json = JSON.stringify(data.tracker);
    assert.ok(!json.includes(String(t1)), 'tracker ObjectId must not reach snapshot data');
    assert.deepEqual(Object.keys(data.tracker.monitorsDetail[0]).sort(), [
      'domain',
      'latest',
      'name',
      'scansInPeriod',
    ]);
  });
});

// ─── Phase 3: tracker enrichment ─────────────────────────────────

describe('reportService tracker enrichment (Phase 3)', () => {
  it('bakes engines, funnel, competitors, citations and highlights from the latest scan', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-28T00:00:00Z'),
        results: [
          {
            promptId: new ObjectId(),
            prompt: 'best crm software',
            platforms: [
              {
                platformId: 'chatgpt', mentioned: true, cited: true, position: 1,
                citedUrls: ['https://acme.com/blog/crm', 'https://other.com/review'],
                brandRanking: [
                  { brandName: 'Acme', isTargetBrand: true, mentionCount: 2 },
                  { brandName: 'RivalCo', isTargetBrand: false, mentionCount: 1 },
                ],
                aiResponse: 'Many teams choose <b>Acme</b> for CRM work. See the [Acme guide](https://acme.com/blog/crm) for setup steps.',
                error: false,
              },
              { platformId: 'gemini', mentioned: false, cited: false, position: null, citedUrls: [], brandRanking: [], aiResponse: '', error: false },
            ],
          },
          {
            promptId: new ObjectId(),
            prompt: 'top marketing tools',
            platforms: [
              {
                platformId: 'chatgpt', mentioned: false, cited: false, position: null,
                citedUrls: ['https://rivalco.com/tools'],
                brandRanking: [{ brandName: 'RivalCo', isTargetBrand: false, mentionCount: 5 }],
                aiResponse: 'RivalCo leads the market for automation. <script>alert(1)</script> Most reviewers rank RivalCo first.',
                error: false,
              },
            ],
          },
          {
            promptId: new ObjectId(),
            prompt: 'how to run an seo audit',
            platforms: [
              {
                platformId: 'chatgpt', mentioned: false, cited: false, position: null,
                citedUrls: [], brandRanking: [],
                aiResponse: 'Start with a crawl of the site, then check indexation, then review titles and internal links in detail across templates.',
                error: false,
              },
            ],
          },
        ],
        competitorResults: [
          { name: 'Acme', mentions: 2, citations: 1, visibility: 33, isOwn: true },
          { name: 'RivalCo', mentions: 6, citations: 0, visibility: 66 },
        ],
      },
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    // Engines: per-platform, never blended-only. chatgpt saw all 3 prompts.
    assert.deepEqual(
      tracker.engines.map((e) => e.platformId),
      ['chatgpt', 'gemini']
    );
    const [chatgpt, gemini] = tracker.engines;
    assert.equal(chatgpt.prompts, 3);
    assert.equal(chatgpt.mentioned, 1);
    assert.equal(chatgpt.cited, 1);
    assert.equal(gemini.prompts, 1);
    assert.equal(gemini.mentioned, 0);

    // Funnel: prompt-level named vs linked
    assert.deepEqual(tracker.funnel, { prompts: 3, mentioned: 1, cited: 1 });

    // Competitors: own row first (persisted isOwn), rivals after
    assert.equal(tracker.competitors[0].isOwn, true);
    assert.equal(tracker.competitors[0].name, 'Acme');
    assert.equal(tracker.competitors[0].mentions, 2);
    assert.deepEqual(tracker.competitors[1], {
      name: 'RivalCo', mentions: 6, citations: 0, visibility: 66, isOwn: false,
    });

    // Citations won: ONLY own-domain URLs
    assert.deepEqual(tracker.citationsWon, [
      { url: 'https://acme.com/blog/crm', prompt: 'best crm software', platformId: 'chatgpt' },
    ]);

    // Highlights: one per kind, sanitized excerpts
    assert.equal(tracker.highlights.length, 3);
    const byKind = Object.fromEntries(tracker.highlights.map((h) => [h.kind, h]));
    assert.ok(byKind.win.excerpt.includes('Acme'));
    assert.ok(byKind.win.excerpt.includes('Acme guide'), 'markdown link text survives');
    assert.ok(!byKind.win.excerpt.includes('<b>'), 'HTML stripped');
    assert.ok(!byKind.win.excerpt.includes('](http'), 'markdown link syntax stripped');
    assert.equal(byKind.competitor.competitor, 'RivalCo');
    assert.ok(byKind.competitor.excerpt.includes('RivalCo'));
    assert.ok(!byKind.competitor.excerpt.includes('<'), 'tags stripped');
    assert.equal(byKind.absence.prompt, 'how to run an seo audit');
    assert.ok(byKind.absence.excerpt.startsWith('Start with a crawl'));

    // Prompt detail: best visibility first, display-safe rows
    assert.equal(tracker.promptsDetail.totalTracked, 3);
    assert.equal(tracker.promptsDetail.rows.length, 3);
    assert.equal(tracker.promptsDetail.rows[0].prompt, 'best crm software');
    assert.equal(tracker.promptsDetail.rows[0].monitor, undefined); // single monitor
    assert.deepEqual(Object.keys(tracker.promptsDetail.rows[0].engines[0]).sort(), [
      'cited', 'mentioned', 'platformId', 'position',
    ]);

    // Nothing internal leaks: no promptIds anywhere in the baked tracker
    assert.ok(!JSON.stringify(tracker).includes('promptId'));
  });

  it('legacy scans: own rows fold by brand name, rivals merge across monitors', async () => {
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'Main', domain: 'acme.com' },
      { _id: t2, name: 'Shop', domain: 'shop.acme.com' },
    ];
    state.scansByTracker = { [String(t1)]: 1, [String(t2)]: 1 };
    const promptFor = (prompt, mentioned) => ({
      promptId: new ObjectId(),
      prompt,
      platforms: [{ platformId: 'chatgpt', mentioned, cited: false, position: null, citedUrls: [], brandRanking: [], aiResponse: '', error: false }],
    });
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-20T00:00:00Z'),
        results: [promptFor('crm tools', true)],
        // No isOwn anywhere — the pre-Phase-3 persisted shape
        competitorResults: [
          { name: 'Acme', mentions: 2 },
          { name: 'RivalCo', mentions: 3 },
        ],
      },
      [String(t2)]: {
        completedAt: new Date('2026-06-21T00:00:00Z'),
        results: [promptFor('shop software', false)],
        competitorResults: [
          { name: 'acme', mentions: 1 }, // shop.acme.com → own brand 'acme'
          { name: 'RivalCo', mentions: 2 },
        ],
      },
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    // Own rows folded across monitors by isSameBrand(name, extractBrand(domain))
    assert.equal(tracker.competitors[0].isOwn, true);
    assert.equal(tracker.competitors[0].mentions, 3); // 2 + 1
    // Rivals alias-merged and summed
    assert.equal(tracker.competitors[1].name, 'RivalCo');
    assert.equal(tracker.competitors[1].mentions, 5); // 3 + 2
    assert.equal(tracker.competitors.length, 2);

    // Multi-monitor prompt rows carry their monitor name
    assert.deepEqual(
      tracker.promptsDetail.rows.map((r) => r.monitor).sort(),
      ['Main', 'Shop']
    );
  });

  it('synthesizes the own row when no competitor row identifies us', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-20T00:00:00Z'),
        results: [
          {
            promptId: new ObjectId(),
            prompt: 'crm tools',
            platforms: [
              { platformId: 'chatgpt', mentioned: true, cited: true, position: 2, citedUrls: [], brandRanking: [], aiResponse: '', error: false },
              { platformId: 'gemini', mentioned: false, cited: false, position: null, citedUrls: [], brandRanking: [], aiResponse: '', error: false },
            ],
          },
        ],
        competitorResults: [{ name: 'RivalCo', mentions: 4 }],
      },
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const own = data.tracker.competitors[0];

    assert.equal(own.isOwn, true);
    assert.equal(own.name, 'acme'); // extractBrand fallback
    assert.equal(own.mentions, 1); // mentioned platform-results
    assert.equal(own.citations, 1);
    assert.equal(own.visibility, 100); // 1 of 1 prompts mentioned somewhere
  });

  it('caps prompt rows and citations; full answers never reach the payload', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    const filler = 'filler '.repeat(300); // ~2100 chars between brand and sentinel
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-20T00:00:00Z'),
        results: Array.from({ length: 30 }, (_, i) => ({
          promptId: new ObjectId(),
          prompt: `keyword research question number ${i} with some extra words`,
          platforms: [
            {
              platformId: 'chatgpt', mentioned: true, cited: true, position: 1,
              citedUrls: [`https://acme.com/page-${i}`],
              brandRanking: [{ brandName: 'Acme', isTargetBrand: true, mentionCount: 1 }],
              aiResponse: `Acme is a solid choice for this. ${filler} ZZUNIQUEZZ`,
              error: false,
            },
          ],
        })),
        competitorResults: [{ name: 'Acme', mentions: 30, citations: 30, visibility: 100, isOwn: true }],
      },
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    assert.equal(tracker.promptsDetail.totalTracked, 30); // cap is never silent
    assert.equal(tracker.promptsDetail.rows.length, 20);
    assert.equal(tracker.citationsWon.length, 10);
    assert.equal(tracker.highlights.length, 1); // win only — nothing absent

    const json = JSON.stringify(tracker);
    assert.ok(!json.includes('ZZUNIQUEZZ'), 'answer tails must never be baked');
    assert.ok(json.length < 64000, `payload budget exceeded: ${json.length}`);
  });

  it('drops prompts whose every engine errored — outages are not "absence"', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-20T00:00:00Z'),
        results: [
          {
            promptId: new ObjectId(),
            prompt: 'healthy prompt',
            platforms: [
              { platformId: 'chatgpt', mentioned: true, cited: false, position: 3, citedUrls: [], brandRanking: [], aiResponse: '', error: false },
            ],
          },
          {
            promptId: new ObjectId(),
            prompt: 'vendor outage prompt',
            platforms: [
              { platformId: 'chatgpt', mentioned: false, cited: false, position: null, citedUrls: [], brandRanking: [], aiResponse: '', error: true },
              { platformId: 'gemini', mentioned: false, cited: false, position: null, citedUrls: [], brandRanking: [], aiResponse: '', error: true },
            ],
          },
        ],
        competitorResults: [{ name: 'Acme', mentions: 1, isOwn: true }],
      },
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const tracker = data.tracker;

    // The all-errored prompt is fully absent: not a "not mentioned" data
    // point, not a ghost row, not part of the tracked total.
    assert.deepEqual(tracker.funnel, { prompts: 1, mentioned: 1, cited: 0 });
    assert.equal(tracker.promptsDetail.totalTracked, 1);
    assert.equal(tracker.promptsDetail.rows.length, 1);
    assert.equal(tracker.promptsDetail.rows[0].prompt, 'healthy prompt');
    assert.ok(!JSON.stringify(tracker.promptsDetail).includes('vendor outage prompt'));
  });

  it('adds no enrichment keys when no monitor has scanned', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 0 };
    state.latestScanByTracker = { [String(t1)]: null };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.equal(data.tracker.engines, undefined);
    assert.equal(data.tracker.funnel, undefined);
    assert.equal(data.tracker.promptsDetail, undefined);
    assert.equal(data.tracker.highlights, undefined);
  });
});

// ─── Phase 4: trend, deltas, recommendations ─────────────────────

describe('reportService trend + deltas + recommendations (Phase 4)', () => {
  /** Single-prompt scan with one chatgpt result. */
  function trendScan(dateIso, { mentioned, cited, position = null, sentimentScore = null }) {
    return {
      completedAt: new Date(dateIso),
      results: [
        {
          platforms: [
            { platformId: 'chatgpt', mentioned, cited, position, sentimentScore, brandRanking: [], error: false },
          ],
        },
      ],
      competitorResults: [],
    };
  }

  it('builds the trend from real scans only, baseline first, ascending dates', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 2 };
    const scanB = trendScan('2026-06-15T00:00:00Z', { mentioned: true, cited: true, position: 1, sentimentScore: 80 });
    state.latestScanByTracker = { [String(t1)]: scanB };
    state.baselineScanByTracker = {
      [String(t1)]: trendScan('2026-05-20T00:00:00Z', { mentioned: false, cited: false }),
    };
    // Newest-first, as the DB sort returns them
    state.trendScansByTracker = {
      [String(t1)]: [scanB, trendScan('2026-06-08T00:00:00Z', { mentioned: true, cited: false })],
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const trend = data.tracker.trend;

    assert.equal(trend.length, 3); // baseline + 2 real scans — NO synthetic points
    assert.equal(trend[0].baseline, true);
    assert.equal(trend[0].date, '2026-05-20T00:00:00.000Z');
    assert.equal(trend[0].visibility, 0);
    assert.equal(trend[1].date, '2026-06-08T00:00:00.000Z');
    assert.equal(trend[1].visibility, 55); // mentioned, uncited, null position
    assert.equal(trend[1].sentiment, null);
    assert.equal(trend[1].baseline, undefined);
    assert.equal(trend[2].date, '2026-06-15T00:00:00.000Z');
    assert.equal(trend[2].visibility, 100);
    assert.equal(trend[2].citationRate, 100);
    assert.equal(trend[2].sentiment, 80);
    // Single monitor → no attribution key
    assert.ok(trend.every((p) => p.monitor === undefined));

    // Baseline roll-up attached for deltas
    assert.equal(data.tracker.baseline.visibility, 0);
    assert.equal(data.tracker.baseline.scannedAt.toISOString(), '2026-05-20T00:00:00.000Z');
  });

  it('attributes trend points per monitor and interleaves by date', async () => {
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    state.trackers = [
      { _id: t1, name: 'Main', domain: 'acme.com' },
      { _id: t2, name: 'Shop', domain: 'shop.acme.com' },
    ];
    state.scansByTracker = { [String(t1)]: 1, [String(t2)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: trendScan('2026-06-10T00:00:00Z', { mentioned: true, cited: false }),
      [String(t2)]: trendScan('2026-06-12T00:00:00Z', { mentioned: false, cited: false }),
    };
    state.trendScansByTracker = {
      [String(t1)]: [trendScan('2026-06-10T00:00:00Z', { mentioned: true, cited: false })],
      [String(t2)]: [trendScan('2026-06-12T00:00:00Z', { mentioned: false, cited: false })],
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const trend = data.tracker.trend;

    assert.deepEqual(
      trend.map((p) => [p.monitor, p.date]),
      [
        ['Main', '2026-06-10T00:00:00.000Z'],
        ['Shop', '2026-06-12T00:00:00.000Z'],
      ]
    );
  });

  it('bakes headline deltas vs the previous period across tracker, gsc and content', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: trendScan('2026-06-15T00:00:00Z', { mentioned: true, cited: true, position: 1 }),
    };
    state.baselineScanByTracker = {
      [String(t1)]: trendScan('2026-05-20T00:00:00Z', { mentioned: false, cited: false }),
    };
    state.gscPeriodRowsByPeriod = {
      '2026-06': [{ clicks: 150, impressions: 4000, ctr: 3, position: 10, updatedAt: new Date(), rangeEnd: '2026-06-30', topQueries: [] }],
      '2026-05': [{ clicks: 100, impressions: 3000, ctr: 3, position: 11, updatedAt: new Date(), rangeEnd: '2026-05-31', topQueries: [] }],
    };
    state.contentInPeriod = 4;
    state.contentPrevInPeriod = 1;
    state.contentTotal = 12;

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.deepEqual(data.deltas.tracker.visibility, { current: 100, previous: 0, delta: 100 });
    assert.deepEqual(data.deltas.tracker.mentionRate, { current: 100, previous: 0, delta: 100 });
    assert.deepEqual(data.deltas.gsc.clicks, { current: 150, previous: 100, delta: 50 });
    assert.deepEqual(data.deltas.gsc.impressions, { current: 4000, previous: 3000, delta: 1000 });
    assert.deepEqual(data.deltas.content.createdInPeriod, { current: 4, previous: 1, delta: 3 });
  });

  it('never compares approximate GSC against a real month', async () => {
    // Current month falls back to snapshotStats (approximate) while a real
    // previous-month row exists — comparing them would fabricate a trend.
    state.sites = [
      { url: 'https://acme.com', snapshotStats: { clicks: 10, impressions: 200, ctr: 5, position: 3, updatedAt: new Date() } },
    ];
    state.gscPeriodRowsByPeriod = {
      '2026-06': [],
      '2026-05': [{ clicks: 100, impressions: 3000, ctr: 3, position: 11, updatedAt: new Date(), rangeEnd: '2026-05-31', topQueries: [] }],
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.equal(data.gsc.approximate, true);
    assert.equal(data.deltas.gsc, null);
  });

  it('deltas.tracker is null without a pre-period baseline; trend still builds', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: trendScan('2026-06-15T00:00:00Z', { mentioned: true, cited: true, position: 1 }),
    };
    state.trendScansByTracker = {
      [String(t1)]: [trendScan('2026-06-15T00:00:00Z', { mentioned: true, cited: true, position: 1 })],
    };
    // No baselineScanByTracker — brand-new tracker

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.equal(data.tracker.baseline, undefined);
    assert.equal(data.tracker.trend.length, 1);
    assert.equal(data.deltas.tracker, null);
    // content delta still present, so deltas itself is not null
    assert.ok(data.deltas.content);
  });

  it('ranks opportunities AEO-gaps-first, potentialClicks within source, cap 3', async () => {
    state.opportunityRows = [
      { source: 'gsc_striking', query: 'striking big', page: '/a', metrics: { potentialClicks: 900 } },
      { source: 'ai_citation_gap', query: 'gap small', page: '/b', metrics: { potentialClicks: 100 } },
      { source: 'ai_citation_gap', topQuery: 'gap big', page: '/c', metrics: { potentialClicks: 300 } },
      { source: 'gsc_striking', query: 'striking small', page: '/d', metrics: { potentialClicks: 5 } },
    ];

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.deepEqual(data.opportunities, [
      { source: 'ai_citation_gap', query: 'gap big', page: '/c', potentialClicks: 300 },
      { source: 'ai_citation_gap', query: 'gap small', page: '/b', potentialClicks: 100 },
      { source: 'gsc_striking', query: 'striking big', page: '/a', potentialClicks: 900 },
    ]);

    // One open-status query PER source (bounded windows — a shared cap
    // could let striking rows crowd out every citation-gap row)
    assert.equal(state.opportunityQueries.length, 2);
    assert.deepEqual(
      state.opportunityQueries.map((q) => q.source).sort(),
      ['ai_citation_gap', 'gsc_striking']
    );
    for (const q of state.opportunityQueries) assert.equal(q.status, 'open');
  });

  it('citation-gap rows survive even when striking rows dominate (crowd-out regression)', async () => {
    // Many high-click striking rows + one modest citation-gap row. A single
    // capped/unsorted window could return only striking rows; the per-source
    // queries guarantee the AEO-first slot.
    state.opportunityRows = [
      ...Array.from({ length: 8 }, (_, i) => ({
        source: 'gsc_striking',
        query: `striking ${i}`,
        page: `/s${i}`,
        metrics: { potentialClicks: 1000 + i },
      })),
      { source: 'ai_citation_gap', query: 'the one gap', page: '/gap', metrics: { potentialClicks: 2 } },
    ];

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');

    assert.equal(data.opportunities.length, 3);
    assert.equal(data.opportunities[0].source, 'ai_citation_gap');
    assert.equal(data.opportunities[0].query, 'the one gap');
    assert.equal(data.opportunities[1].source, 'gsc_striking');
  });

  it('promptSuggestions come from the weakest prompt (dashboard parity)', async () => {
    const t1 = new ObjectId();
    state.trackers = [{ _id: t1, name: 'Main', domain: 'acme.com' }];
    state.scansByTracker = { [String(t1)]: 1 };
    state.latestScanByTracker = {
      [String(t1)]: {
        completedAt: new Date('2026-06-15T00:00:00Z'),
        results: [
          {
            prompt: 'strong prompt',
            platforms: [{ platformId: 'chatgpt', mentioned: true, cited: true, position: 1, brandRanking: [], citedUrls: [], aiResponse: '', error: false }],
          },
          {
            prompt: 'weak prompt',
            platforms: [
              { platformId: 'chatgpt', mentioned: false, cited: false, position: null, brandRanking: [], citedUrls: [], aiResponse: '', error: false },
              { platformId: 'gemini', mentioned: false, cited: false, position: null, brandRanking: [], citedUrls: [], aiResponse: '', error: false },
            ],
          },
        ],
        competitorResults: [{ name: 'Acme', mentions: 1, isOwn: true }],
      },
    };

    const { data } = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const suggestions = data.tracker.promptSuggestions;

    // The zero-mention branch fires only if the WEAKEST prompt was picked
    assert.ok(suggestions.includes('Create comprehensive content targeting this exact query'));
    assert.ok(suggestions.length <= 6);
    assert.ok(suggestions.every((s) => typeof s === 'string'));
  });
});

// ─── Phase 3: isOwn now persists on scan competitor rows ─────────

describe('AiTrackerScan competitorResults.isOwn (Phase 3 schema fix)', () => {
  it('survives the schema cast (was silently stripped pre-Phase-3)', () => {
    const doc = new AiTrackerScan({
      trackerId: new ObjectId(),
      competitorResults: [
        { competitorId: new ObjectId(), name: 'Us', mentions: 1, isOwn: true },
        { competitorId: new ObjectId(), name: 'Rival', mentions: 2 },
      ],
    });
    const obj = doc.toObject();
    assert.equal(obj.competitorResults[0].isOwn, true);
    assert.equal(obj.competitorResults[1].isOwn, false); // default, not undefined
  });
});

// ─── Shares: create / resolve / expiry ───────────────────────────

describe('reportService shares', () => {
  const reportId = new ObjectId();
  const orgId = new ObjectId();
  const wsId = new ObjectId();

  function seedSnapshot() {
    state.snapshotById = {
      _id: reportId,
      workspaceId: wsId,
      organizationId: orgId,
      period: '2026-06',
      generatedAt: new Date('2026-07-01T03:30:00Z'),
      data: {
        workspaceName: 'Acme SEO',
        content: { total: 3, createdInPeriod: 1, avgScore: 80, scoredCount: 2, topContent: [] },
        tracker: null,
        gsc: null,
      },
    };
  }

  it('createShare stores only the hash and returns the raw token', async () => {
    seedSnapshot();
    const { share, rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });

    assert.equal(rawToken.length, 64);
    assert.equal(share.tokenHash, ReportShare.hashToken(rawToken));
    assert.notEqual(share.tokenHash, rawToken);
    assert.equal(share.internal, false);
    assert.equal(String(share.workspaceId), String(wsId));
    // ~90 days out
    const ttlMs = share.expiresAt.getTime() - Date.now();
    assert.ok(Math.abs(ttlMs - 90 * 24 * 60 * 60 * 1000) < 5000);
  });

  it('createShare 404s for a missing report', async () => {
    state.snapshotById = null;
    await assert.rejects(
      () => reportService.createShare(new ObjectId()),
      (err) => err.status === 404
    );
  });

  it('resolvePublicReport round-trips a valid token with a display-safe payload', async () => {
    seedSnapshot();
    const { rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });

    const resolved = await reportService.resolvePublicReport(rawToken);

    assert.ok(resolved);
    assert.equal(resolved.report.workspaceName, 'Acme SEO');
    assert.equal(resolved.report.period, '2026-06');
    assert.equal(resolved.report.content.total, 3);
    assert.equal(resolved.brand.productName, 'AgencyBrand');
    assert.equal(resolved.brand.primaryColor, '#123456');
    assert.equal(resolved.brand.hideAttribution, true);

    // No internal fields leak to the public payload
    const payloadJson = JSON.stringify(resolved);
    assert.equal(resolved.report._id, undefined);
    assert.equal(resolved.report.workspaceId, undefined);
    assert.equal(resolved.report.organizationId, undefined);
    assert.equal(resolved.brand.supportEmail, undefined);
    assert.ok(!payloadJson.includes(String(orgId)));
    assert.ok(!payloadJson.includes(String(wsId)));
    assert.ok(!payloadJson.includes(ReportShare.hashToken(rawToken)));
  });

  it('resolvePublicReport returns null for a wrong or expired token', async () => {
    seedSnapshot();
    const { share, rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });

    assert.equal(await reportService.resolvePublicReport('nope'), null);
    assert.equal(await reportService.resolvePublicReport(null), null);

    // Expire it — findValidByToken's expiresAt > now filter must reject it
    share.expiresAt = new Date(Date.now() - 1000);
    assert.equal(await reportService.resolvePublicReport(rawToken), null);
  });

  it('fractional ttlDays supports 15-minute internal PDF tokens', async () => {
    seedSnapshot();
    const { share } = await reportService.createShare(reportId, {
      ttlDays: 15 / (24 * 60),
      internal: true,
    });
    assert.equal(share.internal, true);
    const ttlMs = share.expiresAt.getTime() - Date.now();
    assert.ok(ttlMs > 14 * 60 * 1000 && ttlMs < 16 * 60 * 1000);
  });

  it('revokeShares deletes only user-facing (non-internal) shares', async () => {
    await reportService.revokeShares(reportId);
    assert.equal(state.deletedShareFilters.length, 1);
    assert.deepEqual(state.deletedShareFilters[0], {
      reportId,
      internal: { $ne: true },
    });
  });

  it('rotateShare revokes non-internal shares BEFORE minting the new one', async () => {
    seedSnapshot();
    const events = [];
    const origDeleteMany = ReportShare.deleteMany;
    const origCreate = ReportShare.create;
    ReportShare.deleteMany = async (filter) => {
      events.push('revoke');
      state.deletedShareFilters.push(filter);
      return { deletedCount: 1 };
    };
    ReportShare.create = async (doc) => {
      events.push('create');
      const created = { _id: new ObjectId(), ...doc };
      state.createdShares.push(created);
      state.shares.push(created);
      return created;
    };
    try {
      const { share, rawToken } = await reportService.rotateShare(reportId, { ttlDays: 90 });

      assert.deepEqual(events, ['revoke', 'create']); // one-live-link invariant
      assert.deepEqual(state.deletedShareFilters[0], { reportId, internal: { $ne: true } });
      assert.equal(rawToken.length, 64);
      assert.equal(share.internal, false);
    } finally {
      ReportShare.deleteMany = origDeleteMany;
      ReportShare.create = origCreate;
    }
  });

  it('public payload strips sourceErrors — names only, no internal error text', async () => {
    seedSnapshot();
    state.snapshotById.data.sourceErrors = [
      { source: 'tracker', error: 'MongoServerError: connection refused at 10.0.0.5:27017' },
      { source: 'gsc', error: 'ECONNRESET reading Site.snapshotStats' },
    ];
    const { rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });

    const resolved = await reportService.resolvePublicReport(rawToken);

    assert.ok(resolved);
    assert.equal(resolved.report.sourceErrors, undefined);
    assert.deepEqual(resolved.report.sourcesUnavailable, ['tracker', 'gsc']);

    // No err.message text crosses the public boundary
    const payloadJson = JSON.stringify(resolved);
    assert.ok(!payloadJson.includes('MongoServerError'));
    assert.ok(!payloadJson.includes('connection refused'));
    assert.ok(!payloadJson.includes('10.0.0.5'));
    assert.ok(!payloadJson.includes('ECONNRESET'));
  });

  it('public payload omits sourcesUnavailable entirely when no source failed', async () => {
    seedSnapshot();
    const { rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });
    const resolved = await reportService.resolvePublicReport(rawToken);
    assert.ok(resolved);
    assert.equal(resolved.report.sourceErrors, undefined);
    assert.equal(resolved.report.sourcesUnavailable, undefined);
  });
});

// ─── Phase 9: worst-case payload budget + bounded query counts ───

describe('reportService worst case (Phase 9 hardening)', () => {
  it('agency worst case stays under the payload budget; queries scale with monitors, never prompts', async () => {
    // 10 monitors × 100 prompts × 2 engines with heavy answers, 31 trend
    // scans per monitor + baselines — the fixture the Phase 4 review
    // required before calling the payload budget proven.
    const MONITORS = 10;
    const PROMPTS = 100;
    const TREND_SCANS = 31;
    const filler = 'filler '.repeat(250); // ~1.7KB tail per answer

    const trackerIds = Array.from({ length: MONITORS }, () => new ObjectId());
    state.trackers = trackerIds.map((id, i) => ({
      _id: id,
      name: `Monitor ${String(i).padStart(2, '0')}`,
      domain: `client${i}.example.com`,
    }));
    state.scansByTracker = {};
    state.latestScanByTracker = {};
    state.baselineScanByTracker = {};
    state.trendScansByTracker = {};

    const slimScan = (dateIso, mentioned) => ({
      completedAt: new Date(dateIso),
      results: [
        { platforms: [{ platformId: 'chatgpt', mentioned, cited: mentioned, position: mentioned ? 2 : null, brandRanking: [], error: false }] },
      ],
      competitorResults: [],
    });

    for (let i = 0; i < MONITORS; i++) {
      const key = String(trackerIds[i]);
      state.scansByTracker[key] = TREND_SCANS;
      state.latestScanByTracker[key] = {
        completedAt: new Date('2026-06-28T00:00:00Z'),
        results: Array.from({ length: PROMPTS }, (_, p) => ({
          promptId: new ObjectId(),
          prompt: `monitor ${i} question ${p} about ai visibility and rankings`,
          platforms: [
            {
              platformId: 'chatgpt', mentioned: true, cited: true, position: 1,
              citedUrls: [`https://client${i}.example.com/page-${p}`],
              brandRanking: [{ brandName: `Client${i}`, isTargetBrand: true, mentionCount: 1 }],
              aiResponse: `Client${i} is a solid option. ${filler}`,
              error: false,
            },
            {
              platformId: 'gemini', mentioned: false, cited: false, position: null,
              citedUrls: [], brandRanking: [],
              aiResponse: `Some other answer entirely. ${filler}`,
              error: false,
            },
          ],
        })),
        competitorResults: [
          { name: `Client${i}`, mentions: 40, citations: 20, visibility: 70, isOwn: true },
          { name: 'RivalCo', mentions: 55, citations: 5, visibility: 80 },
        ],
      };
      state.baselineScanByTracker[key] = slimScan('2026-05-20T00:00:00Z', false);
      // Newest-first, ALL dates valid June days (June has 30 — day 31 would
      // roll over to July 1 under Node's lenient parse and silently place a
      // point outside the period). Two scans share June 1: legal, real
      // trackers can scan twice a day under dev time-scale.
      state.trendScansByTracker[key] = Array.from({ length: TREND_SCANS }, (_, s) =>
        slimScan(`2026-06-${String(Math.max(1, 30 - s)).padStart(2, '0')}T03:00:00Z`, s % 2 === 0)
      );
    }
    state.gscPeriodRowsByPeriod = {
      '2026-06': [{ clicks: 1500, impressions: 40000, ctr: 3.75, position: 9, updatedAt: new Date(), rangeEnd: '2026-06-30', topQueries: [] }],
      '2026-05': [{ clicks: 1200, impressions: 35000, ctr: 3.4, position: 10, updatedAt: new Date(), rangeEnd: '2026-05-31', topQueries: [] }],
    };
    state.contentTotal = 200;
    state.contentInPeriod = 12;
    state.contentPrevInPeriod = 9;

    const snapshot = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    const { data } = snapshot;

    // ── Payload budget: the WHOLE baked document ──
    const bytes = JSON.stringify(data).length;
    assert.ok(bytes < 131072, `data payload budget exceeded: ${bytes} bytes (budget 128KB)`);
    // Answer text never leaks whole (excerpts only)
    assert.ok(!JSON.stringify(data).includes(filler));

    // ── Caps hold globally across monitors, disclosed ──
    assert.equal(data.tracker.promptsDetail.rows.length, 20);
    assert.equal(data.tracker.promptsDetail.totalTracked, MONITORS * PROMPTS);
    assert.equal(data.tracker.citationsWon.length, 10);
    assert.equal(data.tracker.monitorsDetail.length, MONITORS);
    // Trend: (baseline + 31 real scans) per monitor, all real points
    assert.equal(data.tracker.trend.length, MONITORS * (TREND_SCANS + 1));

    // ── N+1 pin: query counts derive from MONITOR count, never prompt count ──
    assert.equal(state.scanCountQueries.length, MONITORS);
    assert.equal(state.scanFindOneQueries.length, MONITORS * 2); // latest + baseline
    assert.equal(state.scanTrendQueries.length, MONITORS);
    // Slim projection on every trend/baseline read — answers never fetched
    for (const proj of state.scanTrendProjections) {
      assert.ok(!proj.includes('aiResponse'));
    }
  });
});

// ─── Phase 5: commentary + public allowlist ──────────────────────

describe('reportService commentary (Phase 5)', () => {
  it('updateCommentary sets ONLY data.commentary — no re-aggregation, no generatedAt bump', async () => {
    const captured = [];
    const orig = ReportSnapshot.findOneAndUpdate;
    ReportSnapshot.findOneAndUpdate = async (filter, update, opts) => {
      captured.push({ filter, update, opts });
      return { _id: new ObjectId(), period: filter.period, data: { commentary: update.$set['data.commentary'] } };
    };
    try {
      const updated = await reportService.updateCommentary(state.workspace._id, '2026-06', 'Great month!');
      assert.ok(updated);
      assert.equal(captured.length, 1);
      assert.deepEqual(captured[0].filter, { workspaceId: state.workspace._id, period: '2026-06' });
      // The WHOLE update — nothing but the commentary path may be touched
      assert.deepEqual(captured[0].update, { $set: { 'data.commentary': 'Great month!' } });
      assert.deepEqual(captured[0].opts, { new: true });
      // No aggregation queries fired (the history-mutation regression)
      assert.equal(state.scanFindOneQueries.length, 0);
      assert.equal(state.contentCountQueries.length, 0);
    } finally {
      ReportSnapshot.findOneAndUpdate = orig;
    }
  });

  it('updateCommentary rejects invalid periods and returns null for missing snapshots', async () => {
    await assert.rejects(
      () => reportService.updateCommentary(state.workspace._id, '2026-13', 'x'),
      (err) => err.status === 400
    );
    const orig = ReportSnapshot.findOneAndUpdate;
    ReportSnapshot.findOneAndUpdate = async () => null;
    try {
      assert.equal(await reportService.updateCommentary(state.workspace._id, '2026-06', 'x'), null);
    } finally {
      ReportSnapshot.findOneAndUpdate = orig;
    }
  });

  it('service-level guards: exported seams reject invalid commentary themselves', async () => {
    // Defense-in-depth — the controller validates too, but these are
    // exported functions and the public payload is downstream of them.
    await assert.rejects(
      () => reportService.updateCommentary(state.workspace._id, '2026-06', 42),
      (err) => err.status === 400 && /string/.test(err.message)
    );
    await assert.rejects(
      () => reportService.updateCommentary(state.workspace._id, '2026-06', 'x'.repeat(1501)),
      (err) => err.status === 400 && /1500/.test(err.message)
    );
    await assert.rejects(
      () => reportService.generateSnapshot(state.workspace._id, '2026-06', { commentary: 'x'.repeat(1501) }),
      (err) => err.status === 400
    );
    assert.equal(state.upserts.length, 0, 'invalid commentary must never reach the upsert');
  });

  it('carried-forward legacy commentary is NOT re-validated (regeneration never bricks)', async () => {
    state.existingSnapshot = { data: { commentary: 'y'.repeat(2000) } }; // over today's cap
    const snap = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(snap.data.commentary, 'y'.repeat(2000));
  });

  it('full regenerate carries existing commentary forward; provided value wins; empty clears', async () => {
    // Existing text, no new value → preserved
    state.existingSnapshot = { data: { commentary: 'keep me' } };
    let snap = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(snap.data.commentary, 'keep me');

    // Provided value wins
    snap = await reportService.generateSnapshot(state.workspace._id, '2026-06', { commentary: 'fresh take' });
    assert.equal(snap.data.commentary, 'fresh take');

    // Empty string explicitly clears
    snap = await reportService.generateSnapshot(state.workspace._id, '2026-06', { commentary: '' });
    assert.equal(snap.data.commentary, undefined);

    // No existing, none provided → absent
    state.existingSnapshot = null;
    snap = await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(snap.data.commentary, undefined);
  });
});

describe('resolvePublicReport allowlist (Phase 5)', () => {
  const reportId = new ObjectId();

  function seedWith(data) {
    state.snapshotById = {
      _id: reportId,
      workspaceId: new ObjectId(),
      organizationId: new ObjectId(),
      period: '2026-06',
      generatedAt: new Date('2026-07-01T03:30:00Z'),
      data,
    };
  }

  it('unknown baked keys never cross the auth boundary', async () => {
    seedWith({
      workspaceName: 'Acme SEO',
      content: { total: 3 },
      tracker: null,
      gsc: null,
      commentary: 'A good month for citations.',
      // Simulated future mistakes — a bake this allowlist must contain
      _secret: 'internal-token',
      debugInternals: { mongoUri: 'mongodb://10.0.0.5' },
    });
    const { rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });

    const resolved = await reportService.resolvePublicReport(rawToken);

    assert.equal(resolved.report._secret, undefined);
    assert.equal(resolved.report.debugInternals, undefined);
    assert.ok(!JSON.stringify(resolved).includes('internal-token'));
    assert.ok(!JSON.stringify(resolved).includes('10.0.0.5'));
    // Known keys still flow — including null sections (UI renders
    // "not included" cards from null) and the commentary
    assert.equal(resolved.report.content.total, 3);
    assert.equal(resolved.report.tracker, null);
    assert.equal(resolved.report.commentary, 'A good month for citations.');
  });

  it('empty commentary stays off the public payload', async () => {
    seedWith({ workspaceName: 'Acme SEO', content: null, tracker: null, gsc: null, commentary: '' });
    const { rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });
    const resolved = await reportService.resolvePublicReport(rawToken);
    assert.equal(resolved.report.commentary, undefined);
  });

  it('opportunities and deltas are allowlisted through', async () => {
    seedWith({
      workspaceName: 'Acme SEO',
      content: null,
      tracker: null,
      gsc: null,
      opportunities: [{ source: 'ai_citation_gap', query: 'q', page: '/p', potentialClicks: 3 }],
      deltas: { tracker: null, gsc: null, content: { createdInPeriod: { current: 2, previous: 1, delta: 1 } } },
    });
    const { rawToken } = await reportService.createShare(reportId, { ttlDays: 90 });
    const resolved = await reportService.resolvePublicReport(rawToken);
    assert.equal(resolved.report.opportunities[0].query, 'q');
    assert.equal(resolved.report.deltas.content.createdInPeriod.delta, 1);
  });
});

// ─── Monthly email dedupe marker (cron reads/writes reportEmailedAt) ─

describe('ReportSnapshot.reportEmailedAt', () => {
  it('exists on the schema with default null (cron dedupe marker)', () => {
    const path = ReportSnapshot.schema.path('reportEmailedAt');
    assert.ok(path, 'reportEmailedAt must be a schema path');
    assert.equal(path.instance, 'Date');
    assert.equal(path.defaultValue, null);
  });

  it('newly generated snapshots do not set reportEmailedAt (email owed)', async () => {
    await reportService.generateSnapshot(state.workspace._id, '2026-06');
    assert.equal(state.upserts.length, 1);
    const { update } = state.upserts[0];
    // generateSnapshot must never touch the marker — only the cron sets it
    assert.equal(update.$set.reportEmailedAt, undefined);
    assert.equal(update.$setOnInsert.reportEmailedAt, undefined);
  });
});
