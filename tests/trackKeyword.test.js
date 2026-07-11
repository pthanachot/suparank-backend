/**
 * Rec 11 — "Track this keyword" + scan-series aggregation. Models
 * monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const Site = require('../src/models/Site');
const AiTracker = require('../src/models/AiTracker');
const AiTrackerPrompt = require('../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../src/models/AiTrackerScan');
const tierService = require('../src/services/tierService');
const { trackContentKeyword } = require('../src/controllers/aiTrackerController');
const { getScanSeriesForPrompts } = require('../src/services/trackerSeriesService');

const originals = {
  cFindByNumber: Content.findByNumber,
  sFindOne: Site.findOne,
  tFindOne: AiTracker.findOne,
  tCreate: AiTracker.create,
  tUpdateOne: AiTracker.updateOne,
  tFind: AiTracker.find,
  pFind: AiTrackerPrompt.find,
  pCreate: AiTrackerPrompt.create,
  pCount: AiTrackerPrompt.countDocuments,
  scanFind: AiTrackerScan.find,
  tierCfg: tierService.getOrgTierConfig,
  incQuota: tierService.incrementQuota,
};
after(() => {
  Content.findByNumber = originals.cFindByNumber;
  Site.findOne = originals.sFindOne;
  AiTracker.findOne = originals.tFindOne;
  AiTracker.create = originals.tCreate;
  AiTracker.updateOne = originals.tUpdateOne;
  AiTracker.find = originals.tFind;
  AiTrackerPrompt.find = originals.pFind;
  AiTrackerPrompt.create = originals.pCreate;
  AiTrackerPrompt.countDocuments = originals.pCount;
  AiTrackerScan.find = originals.scanFind;
  tierService.getOrgTierConfig = originals.tierCfg;
  tierService.incrementQuota = originals.incQuota;
});

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

describe('trackContentKeyword', () => {
  let content; let createdPrompts; let trackerKick; let quotaBumps; let createdTrackers;

  beforeEach(() => {
    createdPrompts = [];
    trackerKick = null;
    quotaBumps = 0;
    createdTrackers = [];
    content = {
      _id: 'c1',
      targetKeywords: ['best crm software'],
      aiConversations: [
        { fanout_queries: [{ query: 'crm pricing comparison' }, { query: 'BEST CRM SOFTWARE' }, { query: 'crm for small business' }, { query: 'fourth query' }] },
      ],
      trackedPrompts: [],
      saved: false,
      async save() { this.saved = true; },
    };
    Content.findByNumber = async () => content;
    AiTracker.findOne = async () => ({ _id: 't1', scanStatus: 'idle' });
    AiTracker.updateOne = async (filter, update) => { trackerKick = update.$set; return {}; };
    AiTrackerPrompt.find = () => ({ select: () => ({ lean: async () => [] }) });
    AiTrackerPrompt.create = async (doc) => { createdPrompts.push(doc); return doc; };
    AiTrackerPrompt.countDocuments = async () => 0;
    tierService.getOrgTierConfig = async () => ({ tier: 'pro', config: { maxAiTrackerPromptsPerMonitor: 100 } });
    tierService.incrementQuota = async () => { quotaBumps += 1; };
  });

  const req = (extra = {}) => ({
    workspace: { _id: 'ws1', organizationId: 'org1' },
    params: { contentNumber: '5' },
    tierQuota: { some: 'quota' },
    ...extra,
  });

  it('creates capped prompt set (primary + 2 fanouts, deduped case-insensitively)', async () => {
    const r = res();
    await trackContentKeyword(req(), r);
    // 'BEST CRM SOFTWARE' dedups against primary; cap 3 → drops 'fourth query'.
    assert.deepEqual(r.body.prompts, ['best crm software', 'crm pricing comparison', 'crm for small business']);
    assert.equal(createdPrompts.length, 3);
    assert.equal(r.body.created, 3);
    assert.equal(quotaBumps, 3, 'one quota bump per created prompt');
    assert.deepEqual(content.trackedPrompts, r.body.prompts);
    assert.equal(content.saved, true);
    assert.equal(typeof r.body.estimatedCreditsPerScan, 'number');
  });

  it('kicks an idle tracker so the cron picks it up', async () => {
    await trackContentKeyword(req(), res());
    assert.ok(trackerKick.nextScanAt instanceof Date);
    assert.equal(trackerKick.scanStatus, 'ready');
  });

  it('does not touch scanStatus of a non-idle tracker', async () => {
    AiTracker.findOne = async () => ({ _id: 't1', scanStatus: 'ready' });
    await trackContentKeyword(req(), res());
    assert.ok(trackerKick.nextScanAt instanceof Date);
    assert.equal(trackerKick.scanStatus, undefined);
  });

  it('idempotent: second call mutates nothing and bumps no quota', async () => {
    content.trackedPrompts = ['best crm software'];
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(r.body.alreadyTracking, true);
    assert.equal(r.body.created, 0);
    assert.equal(createdPrompts.length, 0);
    assert.equal(quotaBumps, 0);
    assert.equal(content.saved, false);
  });

  it('set semantics: prompts already on the tracker are not recreated', async () => {
    AiTrackerPrompt.find = () => ({ select: () => ({ lean: async () => [{ prompt: 'Best CRM Software' }] }) });
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(r.body.created, 2, 'primary already exists on tracker');
    assert.deepEqual(createdPrompts.map((p) => p.prompt), ['crm pricing comparison', 'crm for small business']);
    // Content still links all 3 (including the pre-existing one).
    assert.equal(r.body.prompts.length, 3);
  });

  it('no tracker + site with URL → creates a minimal tracker from the site domain', async () => {
    AiTracker.findOne = async () => null;
    Site.findOne = () => ({ lean: async () => ({ url: 'https://www.example.com/blog' }) });
    AiTracker.create = async (doc) => { createdTrackers.push(doc); return { _id: 'tNew', scanStatus: 'idle' }; };
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(createdTrackers.length, 1);
    assert.equal(createdTrackers[0].domain, 'example.com', 'www stripped');
    assert.equal(r.body.created, 3);
  });

  it('no tracker + no site → 409 TRACKER_SETUP_REQUIRED', async () => {
    AiTracker.findOne = async () => null;
    Site.findOne = () => ({ lean: async () => null });
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.code, 'TRACKER_SETUP_REQUIRED');
    assert.equal(createdPrompts.length, 0);
  });

  it('monthly quota guard: batch would exceed limit → 429, nothing created', async () => {
    // rq validated room for ONE creation (used < limit), but the batch of 3
    // would overshoot: used=9, limit=10 → 9+3 > 10.
    const r = res();
    await trackContentKeyword(req({ tierQuota: { limit: 10, used: 9 } }), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.code, 'QUOTA_EXCEEDED');
    assert.equal(createdPrompts.length, 0);
    assert.equal(quotaBumps, 0);
  });

  it('monthly quota guard: batch exactly reaches limit → allowed', async () => {
    const r = res();
    await trackContentKeyword(req({ tierQuota: { limit: 10, used: 7 } }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(createdPrompts.length, 3);
  });

  it('per-monitor cap → 429 PROMPT_CAP_REACHED, nothing created', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'starter', config: { maxAiTrackerPromptsPerMonitor: 2 } });
    AiTrackerPrompt.countDocuments = async () => 1; // 1 active + 3 new > 2
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.code, 'PROMPT_CAP_REACHED');
    assert.equal(createdPrompts.length, 0);
    assert.equal(quotaBumps, 0);
  });

  it('no target keyword → 400', async () => {
    content.targetKeywords = [];
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(r.statusCode, 400);
  });

  it('content not found → 404', async () => {
    Content.findByNumber = async () => null;
    const r = res();
    await trackContentKeyword(req(), r);
    assert.equal(r.statusCode, 404);
  });
});

describe('getBenchmark tracking key (additive)', () => {
  const { getBenchmark } = require('../src/controllers/analysisController');
  const trackerSeries = require('../src/services/trackerSeriesService');
  const realSeries = originals.realSeriesFn = trackerSeries.getScanSeriesForPrompts;

  const baseContent = {
    analysisStatus: 'ready', analysisError: '', analyzedAt: new Date(),
    benchmark: {}, competitors: [], relatedSearches: [], peopleAlsoAsk: [],
    keywordVolumes: [], competitorPages: [], aiConversations: [], analysisWarnings: [],
  };

  it('untracked content → NO tracking key (byte-identical response shape)', async () => {
    Content.findByNumber = async () => ({ ...baseContent, trackedPrompts: [] });
    const r = res();
    await getBenchmark({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' } }, r);
    assert.ok(!('tracking' in r.body), 'tracking key must be absent when not tracking');
  });

  it('tracked content → tracking {enabled, prompts, lastScanAt, series}', async () => {
    Content.findByNumber = async () => ({ ...baseContent, trackedPrompts: ['best crm'] });
    trackerSeries.getScanSeriesForPrompts = async () => ({
      series: [{ date: '2026-07-01', mentioned: true, cited: false, position: 5 }],
      lastScanAt: new Date('2026-07-01T12:00:00Z'),
    });
    const r = res();
    await getBenchmark({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' } }, r);
    assert.equal(r.body.tracking.enabled, true);
    assert.deepEqual(r.body.tracking.prompts, ['best crm']);
    assert.equal(r.body.tracking.series.length, 1);
    trackerSeries.getScanSeriesForPrompts = realSeries;
  });

  it('series failure degrades to empty series, never breaks the benchmark', async () => {
    Content.findByNumber = async () => ({ ...baseContent, trackedPrompts: ['best crm'] });
    trackerSeries.getScanSeriesForPrompts = async () => { throw new Error('scan db down'); };
    const r = res();
    await getBenchmark({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' } }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.tracking.enabled, true);
    assert.deepEqual(r.body.tracking.series, []);
    trackerSeries.getScanSeriesForPrompts = realSeries;
  });
});

describe('getScanSeriesForPrompts', () => {
  const day = (n) => new Date(Date.UTC(2026, 6, n, 12)); // July n, 2026

  beforeEach(() => {
    AiTracker.find = () => ({ select: () => ({ lean: async () => [{ _id: 't1' }] }) });
  });

  function mockScans(scans) {
    AiTrackerScan.find = () => ({
      select: () => ({ sort: () => ({ lean: async () => scans }) }),
    });
  }

  it('aggregates per day: any-mentioned, any-cited, min-position', async () => {
    mockScans([
      {
        completedAt: day(1),
        results: [
          { prompt: 'best crm software', platforms: [{ platform: 'chatgpt', mentioned: true, cited: false, position: 4 }] },
          { prompt: 'crm pricing', platforms: [{ platform: 'gemini', mentioned: false, cited: true, position: 2 }] },
          { prompt: 'unrelated prompt', platforms: [{ platform: 'chatgpt', mentioned: true, cited: true, position: 1 }] },
        ],
      },
      {
        completedAt: day(3),
        results: [
          { prompt: 'Best CRM Software', platforms: [{ platform: 'chatgpt', mentioned: false, cited: false, position: null }] },
        ],
      },
    ]);
    const { series, lastScanAt } = await getScanSeriesForPrompts('ws1', ['best crm software', 'crm pricing'], 30);
    assert.equal(series.length, 2);
    assert.deepEqual(series[0], { date: '2026-07-01', mentioned: true, cited: true, position: 2 });
    assert.deepEqual(series[1], { date: '2026-07-03', mentioned: false, cited: false, position: null });
    assert.equal(lastScanAt.getTime(), day(3).getTime());
  });

  it('two scans same day merge into one point', async () => {
    mockScans([
      { completedAt: day(2), results: [{ prompt: 'k', platforms: [{ mentioned: true, cited: false, position: 7 }] }] },
      { completedAt: new Date(Date.UTC(2026, 6, 2, 18)), results: [{ prompt: 'k', platforms: [{ mentioned: false, cited: true, position: 3 }] }] },
    ]);
    const { series } = await getScanSeriesForPrompts('ws1', ['k'], 30);
    assert.equal(series.length, 1);
    assert.deepEqual(series[0], { date: '2026-07-02', mentioned: true, cited: true, position: 3 });
  });

  it('empty scans → empty series; no trackers → empty series', async () => {
    mockScans([]);
    assert.deepEqual(await getScanSeriesForPrompts('ws1', ['k'], 30), { series: [], lastScanAt: null });
    AiTracker.find = () => ({ select: () => ({ lean: async () => [] }) });
    assert.deepEqual(await getScanSeriesForPrompts('ws1', ['k'], 30), { series: [], lastScanAt: null });
    assert.deepEqual(await getScanSeriesForPrompts('ws1', [], 30), { series: [], lastScanAt: null });
  });
});
