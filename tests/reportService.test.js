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
  siteFind: Site.find,
  snapFindOneAndUpdate: ReportSnapshot.findOneAndUpdate,
  snapFindById: ReportSnapshot.findById,
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
  };

  Workspace.findById = () => ({ select: () => ({ lean: async () => state.workspace }) });

  // The createdInPeriod query is the only one with a $gte lower bound; the
  // total / scored / top queries are bounded by createdAt.$lt only (F1).
  Content.countDocuments = async (query) => {
    state.contentCountQueries.push(query);
    return query.createdAt && query.createdAt.$gte ? state.contentInPeriod : state.contentTotal;
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

  AiTracker.find = () => ({
    select: () => ({
      lean: async () => {
        if (state.trackerFindError) throw state.trackerFindError;
        return state.trackers;
      },
    }),
  });
  AiTrackerScan.countDocuments = async () => state.scansInPeriod;
  AiTrackerScan.findOne = (query) => {
    state.scanFindOneQuery = query;
    return { sort: () => ({ lean: async () => state.latestScan }) };
  };

  Site.find = () => ({ select: () => ({ lean: async () => state.sites }) });

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
  Site.find = originals.siteFind;
  ReportSnapshot.findOneAndUpdate = originals.snapFindOneAndUpdate;
  ReportSnapshot.findById = originals.snapFindById;
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
    state.trackers = [{ _id: new ObjectId() }, { _id: new ObjectId() }];
    state.scansInPeriod = 3;
    state.latestScan = {
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
    assert.equal(data.tracker.scansInPeriod, 3);
    assert.equal(data.tracker.latest.mentionRate, 67);
    assert.equal(data.tracker.latest.visibility, 57);
    assert.equal(data.tracker.latest.shareOfVoice, 25); // 2 own / 8 total
    assert.ok(data.tracker.latest.scannedAt);

    // gsc: only the site with local snapshotStats counts
    assert.equal(data.gsc.sites, 1);
    assert.equal(data.gsc.clicks, 100);
    assert.equal(data.gsc.impressions, 4000);
    assert.equal(data.gsc.avgPosition, 12.4);

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

  it('bounds the latest tracker scan by completedAt < periodEnd', async () => {
    state.trackers = [{ _id: new ObjectId() }];
    await reportService.generateSnapshot(state.workspace._id, '2026-06');

    const end = new Date(Date.UTC(2026, 6, 1));
    assert.ok(state.scanFindOneQuery, 'latest scan findOne must run');
    assert.equal(state.scanFindOneQuery.status, 'ready');
    assert.ok(state.scanFindOneQuery.completedAt, 'latest scan must be period-bounded');
    assert.equal(state.scanFindOneQuery.completedAt.$lt.toISOString(), end.toISOString());
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
