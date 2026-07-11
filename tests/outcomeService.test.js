/**
 * Rec 14 — outcome snapshots + deltas. Models/services monkey-patched; no
 * DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const ContentOutcome = require('../src/models/ContentOutcome');
const Workspace = require('../src/models/Workspace');
const Site = require('../src/models/Site');
const GscConnection = require('../src/models/GscConnection');
const gscService = require('../src/services/gscService');
const trackerSeries = require('../src/services/trackerSeriesService');
const {
  snapshotContent, runOutcomeSweep, computeDelta, getReportDeltas, utcDay,
} = require('../src/services/outcomeService');

const originals = {
  cFind: Content.find,
  cFindByNumber: Content.findByNumber,
  coFindOneAndUpdate: ContentOutcome.findOneAndUpdate,
  coFind: ContentOutcome.find,
  coDistinct: ContentOutcome.distinct,
  wFindById: Workspace.findById,
  sFindOne: Site.findOne,
  gFindOne: GscConnection.findOne,
  kwStats: gscService.getKeywordStats,
  series: trackerSeries.getScanSeriesForPrompts,
};
after(() => {
  Content.find = originals.cFind;
  Content.findByNumber = originals.cFindByNumber;
  ContentOutcome.findOneAndUpdate = originals.coFindOneAndUpdate;
  ContentOutcome.find = originals.coFind;
  ContentOutcome.distinct = originals.coDistinct;
  Workspace.findById = originals.wFindById;
  Site.findOne = originals.sFindOne;
  GscConnection.findOne = originals.gFindOne;
  gscService.getKeywordStats = originals.kwStats;
  trackerSeries.getScanSeriesForPrompts = originals.series;
});

const NOW = new Date('2026-07-09T15:30:00Z');

describe('snapshotContent', () => {
  let upserts;

  beforeEach(() => {
    upserts = [];
    ContentOutcome.findOneAndUpdate = async (filter, update) => {
      upserts.push({ filter, update });
      return { _id: 'o1' };
    };
    Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) });
    GscConnection.findOne = () => ({ select: () => ({ lean: async () => ({ refreshToken: 'tok' }) }) });
    Site.findOne = () => ({ lean: async () => ({ gscPropertyId: 'sc-domain:x' }) });
    gscService.getKeywordStats = async () => ({ position: 12.5, clicks: 40, impressions: 900 });
    trackerSeries.getScanSeriesForPrompts = async () => ({
      series: [
        { date: '2026-07-01', mentioned: false, cited: false, position: null },
        { date: '2026-07-08', mentioned: true, cited: true, position: 3 },
      ],
      lastScanAt: new Date(),
    });
  });

  const content = () => ({
    _id: 'c1', workspaceId: 'ws1', score: 78,
    targetKeywords: ['best crm software'], trackedPrompts: ['best crm software'],
  });

  it('full-data path: score + GSC stats + latest AI visibility, day-truncated key', async () => {
    await snapshotContent(content(), { source: 'reanalyze', now: NOW });
    assert.equal(upserts.length, 1);
    const { filter, update } = upserts[0];
    assert.equal(filter.contentId, 'c1');
    assert.equal(filter.date.toISOString(), '2026-07-09T00:00:00.000Z');
    assert.equal(update.$set.overallScore, 78);
    assert.equal(update.$set.gscPosition, 12.5);
    assert.equal(update.$set.gscClicks, 40);
    assert.equal(update.$set.gscImpressions, 900);
    assert.equal(update.$set.aiCited, true, 'latest series point wins');
    assert.equal(update.$set.aiMentioned, true);
    assert.equal(update.$set.source, 'reanalyze');
  });

  it('GSC disconnected → null GSC fields, score still snapshotted', async () => {
    GscConnection.findOne = () => ({ select: () => ({ lean: async () => null }) });
    await snapshotContent(content(), { now: NOW });
    const f = upserts[0].update.$set;
    assert.equal(f.gscPosition, null);
    assert.equal(f.gscClicks, null);
    assert.equal(f.overallScore, 78);
  });

  it('keyword not found in GSC → null position, no throw', async () => {
    gscService.getKeywordStats = async () => ({ position: null, clicks: null, impressions: null });
    await snapshotContent(content(), { now: NOW });
    assert.equal(upserts[0].update.$set.gscPosition, null);
  });

  it('GSC error → nulls, snapshot still written', async () => {
    gscService.getKeywordStats = async () => { throw new Error('quota'); };
    await snapshotContent(content(), { now: NOW });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].update.$set.gscPosition, null);
  });

  it('no tracked prompts → null AI fields (no tracker query)', async () => {
    let queried = false;
    trackerSeries.getScanSeriesForPrompts = async () => { queried = true; return { series: [] }; };
    await snapshotContent({ ...content(), trackedPrompts: [] }, { now: NOW });
    assert.equal(queried, false);
    assert.equal(upserts[0].update.$set.aiCited, null);
  });

  it('same-day double call → same upsert key both times (single row via unique index)', async () => {
    await snapshotContent(content(), { source: 'cron', now: NOW });
    await snapshotContent(content(), { source: 'reanalyze', now: new Date('2026-07-09T23:59:00Z') });
    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].filter.date.getTime(), upserts[1].filter.date.getTime());
    assert.equal(upserts[1].update.$set.source, 'reanalyze', 'last trigger wins within the day');
  });
});

describe('computeDelta', () => {
  const pt = (over = {}) => ({
    overallScore: null, gscPosition: null, gscClicks: null, aiCited: null, ...over,
  });

  it('2-point improving series — NEGATIVE positionDelta = improved (sign convention)', () => {
    const d = computeDelta([
      pt({ gscPosition: 14, gscClicks: 10, overallScore: 60 }),
      pt({ gscPosition: 8, gscClicks: 25, overallScore: 75, aiCited: true }),
    ]);
    assert.equal(d.positionDelta, -6, 'position 14 → 8 must be -6 (negative = improved)');
    assert.equal(d.positionFirst, 14);
    assert.equal(d.positionLast, 8);
    assert.equal(d.clicksDelta, 15);
    assert.equal(d.scoreDelta, 15);
    assert.equal(d.aiCitedNow, true);
  });

  it('declining series — positive positionDelta', () => {
    const d = computeDelta([pt({ gscPosition: 5 }), pt({ gscPosition: 11 })]);
    assert.equal(d.positionDelta, 6);
  });

  it('10-point series uses first/last NON-NULL per metric (mid-series disconnect tolerated)', () => {
    const series = [
      pt({ overallScore: 50 }),
      pt({ gscPosition: 20 }),
      ...Array.from({ length: 6 }, () => pt()), // GSC disconnected stretch
      pt({ gscPosition: 9 }),
      pt({ overallScore: 80 }),
    ];
    const d = computeDelta(series);
    assert.equal(d.positionDelta, -11);
    assert.equal(d.scoreDelta, 30);
    assert.equal(d.clicksDelta, null, 'no non-null clicks pair');
  });

  it('single point / empty → null deltas', () => {
    assert.equal(computeDelta([pt({ gscPosition: 5 })]).positionDelta, null);
    assert.equal(computeDelta([]).positionDelta, null);
    assert.equal(computeDelta([]).aiCitedNow, false);
  });
});

describe('runOutcomeSweep', () => {
  let capturedFilters; let capturedLimit; let snapshots; let sweepDocs;

  beforeEach(() => {
    snapshots = [];
    capturedFilters = [];
    sweepDocs = [
      { _id: 'c1', workspaceId: 'ws1', score: 70, targetKeywords: ['k'], trackedPrompts: [] },
      { _id: 'c2', workspaceId: 'ws1', score: 80, targetKeywords: ['k2'], trackedPrompts: [] },
    ];
    // Mock ignores $nin — the sweep's in-memory attempted-set must terminate
    // the loop anyway (belt-and-suspenders contract).
    Content.find = (filter) => {
      capturedFilters.push(filter);
      return {
        sort: () => ({
          limit: (n) => {
            capturedLimit = n;
            return { select: () => Promise.resolve(sweepDocs) };
          },
        }),
      };
    };
    ContentOutcome.distinct = async () => [];
    ContentOutcome.findOneAndUpdate = async (filter, update) => { snapshots.push({ filter, update }); return {}; };
    Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) });
    GscConnection.findOne = () => ({ select: () => ({ lean: async () => ({ refreshToken: 'tok' }) }) });
    Site.findOne = () => ({ lean: async () => ({ gscPropertyId: 'sc-domain:x' }) });
    gscService.getKeywordStats = async () => ({ position: 10, clicks: 5, impressions: 100 });
  });

  it('eligibility filter: ready + (published OR recently edited), excludes done/attempted, capped', async () => {
    const r = await runOutcomeSweep({ batchSize: 25, now: NOW });
    const f = capturedFilters[0];
    assert.equal(f.analysisStatus, 'ready');
    assert.ok(Array.isArray(f._id.$nin), 'done-today + attempted exclusion present');
    assert.ok(Array.isArray(f.$or) && f.$or.length === 2);
    const idleDays = (NOW - f.$or[1].updatedAt.$gte) / 86400000;
    assert.ok(Math.abs(idleDays - 120) < 0.1, `idle cutoff ~120d, got ${idleDays}`);
    assert.equal(capturedLimit, 25);
    assert.equal(r.snapshotted, 2);
    assert.equal(snapshots.length, 2);
  });

  it('terminates when the store keeps returning already-attempted docs', async () => {
    const r = await runOutcomeSweep({ now: NOW });
    // Mock returns the same 2 docs forever; the attempted-set must stop the loop.
    assert.equal(r.candidates, 2);
    assert.equal(snapshots.length, 2);
  });

  it('drains multiple batches until the eligible set is exhausted (no starvation)', async () => {
    // Fresh docs on calls 1 and 2, repeats on call 3 → loop ends after draining 4.
    const pages = [
      [{ _id: 'c1', workspaceId: 'ws1', score: 1, targetKeywords: [], trackedPrompts: [] },
       { _id: 'c2', workspaceId: 'ws1', score: 2, targetKeywords: [], trackedPrompts: [] }],
      [{ _id: 'c3', workspaceId: 'ws1', score: 3, targetKeywords: [], trackedPrompts: [] },
       { _id: 'c4', workspaceId: 'ws1', score: 4, targetKeywords: [], trackedPrompts: [] }],
      [{ _id: 'c4', workspaceId: 'ws1', score: 4, targetKeywords: [], trackedPrompts: [] }],
    ];
    let call = 0;
    Content.find = () => ({
      sort: () => ({
        limit: () => ({ select: () => Promise.resolve(pages[Math.min(call++, pages.length - 1)]) }),
      }),
    });
    const r = await runOutcomeSweep({ batchSize: 2, now: NOW });
    assert.equal(r.snapshotted, 4, 'all four contents drained across batches');
    assert.ok(call >= 3, 'looped past the first batch');
  });

  it('maxTotal ceiling bounds the sweep (per-batch limit shrinks to fit)', async () => {
    // Endless supply of fresh docs; only the ceiling can stop the loop.
    let page = 0;
    Content.find = () => {
      const p = page++;
      return {
        sort: () => ({
          limit: (n) => ({
            select: () => Promise.resolve(
              Array.from({ length: n }, (_, i) => ({
                _id: `c${p}-${i}`, workspaceId: 'ws1', score: 1, targetKeywords: [], trackedPrompts: [],
              })),
            ),
          }),
        }),
      };
    };
    const r = await runOutcomeSweep({ batchSize: 2, maxTotal: 5, now: NOW });
    assert.equal(r.candidates, 5, 'stops exactly at the ceiling');
    assert.equal(snapshots.length, 5); // batches of 2 + 2 + 1
  });

  it('GSC context resolved once per workspace (per-sweep cache)', async () => {
    let resolutions = 0;
    Workspace.findById = () => { resolutions += 1; return { select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) }; };
    await runOutcomeSweep({ now: NOW });
    assert.equal(resolutions, 1, 'both contents share ws1 → one resolution');
  });

  it('per-doc failure counted, sweep continues, failed doc not re-selected', async () => {
    let call = 0;
    ContentOutcome.findOneAndUpdate = async (filter, update) => {
      call += 1;
      // First doc fails BOTH the initial attempt and the E11000 retry path.
      if (call === 1) { const e = new Error('io error'); throw e; }
      snapshots.push({ filter, update });
      return {};
    };
    const r = await runOutcomeSweep({ now: NOW });
    assert.equal(r.errors, 1);
    assert.equal(r.snapshotted, 1);
  });
});

describe('snapshotContent E11000 retry', () => {
  it('retries once as an update after a concurrent insert wins the race', async () => {
    let calls = 0;
    ContentOutcome.findOneAndUpdate = async (filter, update) => {
      calls += 1;
      if (calls === 1) { const e = new Error('dup'); e.code = 11000; throw e; }
      return { _id: 'row', update };
    };
    Workspace.findById = () => ({ select: () => ({ lean: async () => null }) });
    const row = await snapshotContent(
      { _id: 'c1', workspaceId: 'ws1', score: 50, targetKeywords: [], trackedPrompts: [] },
      { now: NOW },
    );
    assert.equal(calls, 2, 'retried exactly once');
    assert.ok(row);
  });
});

describe('getOutcomes endpoint', () => {
  const { getOutcomes } = require('../src/controllers/analysisController');
  const outcomeService = require('../src/services/outcomeService');

  function res() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  }

  it('404 when the content does not exist', async () => {
    Content.findByNumber = async () => null;
    const r = res();
    await getOutcomes({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' } }, r);
    assert.equal(r.statusCode, 404);
  });

  it('happy path: {series, delta} with the series passed through in date order', async () => {
    Content.findByNumber = async () => ({ _id: 'c1' });
    const realSeries = outcomeService.getOutcomeSeries;
    outcomeService.getOutcomeSeries = async () => [
      { date: '2026-06-01', overallScore: 60, gscPosition: 14, gscClicks: 10, aiCited: null },
      { date: '2026-07-01', overallScore: 80, gscPosition: 8, gscClicks: 30, aiCited: true },
    ];
    const r = res();
    await getOutcomes({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' } }, r);
    outcomeService.getOutcomeSeries = realSeries;

    assert.equal(r.body.series.length, 2);
    assert.ok(r.body.series[0].date < r.body.series[1].date, 'date-ordered');
    assert.equal(r.body.delta.positionDelta, -6);
    assert.equal(r.body.delta.aiCitedNow, true);
  });

  it('empty series → {series: [], delta with nulls}', async () => {
    Content.findByNumber = async () => ({ _id: 'c1' });
    const realSeries = outcomeService.getOutcomeSeries;
    outcomeService.getOutcomeSeries = async () => [];
    const r = res();
    await getOutcomes({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' } }, r);
    outcomeService.getOutcomeSeries = realSeries;

    assert.deepEqual(r.body.series, []);
    assert.equal(r.body.delta.positionDelta, null);
    assert.equal(r.body.delta.aiCitedNow, false);
  });
});

describe('getReportDeltas', () => {
  beforeEach(() => {
    Content.find = () => ({
      select: () => ({
        lean: async () => [
          { _id: 'cA', title: 'Improved article', contentNumber: 1 },
          { _id: 'cB', title: 'Too fresh', contentNumber: 2 },
          { _id: 'cC', title: 'One point only', contentNumber: 3 },
        ],
      }),
    });
    ContentOutcome.find = (filter) => ({
      sort: () => ({
        select: () => ({
          lean: async () => {
            if (filter.contentId === 'cA') {
              return [
                { date: new Date('2026-06-01'), gscPosition: 14, gscClicks: 10, overallScore: 60 },
                { date: new Date('2026-07-01'), gscPosition: 8, gscClicks: 30, overallScore: 80 },
              ];
            }
            if (filter.contentId === 'cB') {
              return [
                { date: new Date('2026-07-01'), gscPosition: 10, gscClicks: 5, overallScore: 60 },
                { date: new Date('2026-07-05'), gscPosition: 9, gscClicks: 6, overallScore: 61 }, // 4 days apart
              ];
            }
            return [{ date: new Date('2026-07-01'), gscPosition: 10 }];
          },
        }),
      }),
    });
  });

  it('includes only contents with ≥2 snapshots ≥14 days apart', async () => {
    const rows = await getReportDeltas('ws1');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      title: 'Improved article', contentNumber: 1,
      positionDelta: -6, clicksDelta: 20, scoreDelta: 20,
    });
  });
});

describe('utcDay', () => {
  it('truncates to UTC midnight', () => {
    assert.equal(utcDay(new Date('2026-07-09T23:59:59Z')).toISOString(), '2026-07-09T00:00:00.000Z');
    assert.equal(utcDay(new Date('2026-07-09T00:00:00Z')).toISOString(), '2026-07-09T00:00:00.000Z');
  });
});
