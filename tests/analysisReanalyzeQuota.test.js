/**
 * Batch 2 backend coverage:
 *  - Rec 5: POST /reanalyze now consumes the monthly audit pool. The controller
 *    increments the quota once (mirroring triggerAnalysis) and must NOT charge
 *    when a run is already in progress. The 429 gate itself lives in the
 *    requireQuota middleware and is covered by workspaceQuota.test.js.
 *  - Rec 3: curateCitationAppearance maps the engine's snake_case appearance
 *    stats to camelCase for the frontend, tolerating old/absent data.
 *
 * Models/services monkey-patched; no DB/network. runAnalysis is neutralized by
 * pointing Content.findById at null (it returns immediately).
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const tierService = require('../src/services/tierService');
const creditService = require('../src/services/creditService');
const analysisController = require('../src/controllers/analysisController');

const real = {
  findByNumber: Content.findByNumber,
  findById: Content.findById,
  findByIdAndUpdate: Content.findByIdAndUpdate,
  incrementQuota: tierService.incrementQuota,
  deductForRequest: creditService.deductForRequest,
  chargeAction: creditService.chargeAction,
};
after(() => {
  Content.findByNumber = real.findByNumber;
  Content.findById = real.findById;
  Content.findByIdAndUpdate = real.findByIdAndUpdate;
  tierService.incrementQuota = real.incrementQuota;
  creditService.deductForRequest = real.deductForRequest;
  creditService.chargeAction = real.chargeAction;
});

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

let incCalls, content, deductCalls, chargeCalls;
beforeEach(() => {
  incCalls = [];
  deductCalls = [];
  chargeCalls = [];
  // A real re-analysis needs a target keyword (the controller now 400s without
  // one) — these tests exercise the quota/charge path of a VALID re-analysis.
  content = { _id: 'c1', analysisStatus: 'ready', targetKeywords: ['crm software'] };
  Content.findByNumber = async () => content;
  Content.findById = async () => null; // neutralize the fire-and-forget runAnalysis
  Content.findByIdAndUpdate = async () => ({});
  tierService.incrementQuota = async (q) => { incCalls.push(q); };
  creditService.deductForRequest = async (...a) => { deductCalls.push(a); return { deducted: 0 }; };
  creditService.chargeAction = async (...a) => { chargeCalls.push(a); return { charged: true, deducted: 10 }; };
});

describe('reanalyze — quota increment (Rec 5)', () => {
  const tierQuota = { orgId: 'o1', counterKey: 'auditsRun', period: '2026-07' };

  it('increments the audit counter exactly once when tierQuota is attached', async () => {
    const req = { params: { contentNumber: '1' }, workspace: { _id: 'ws1' }, tierQuota };
    const r = res();
    await analysisController.reanalyze(req, r);
    assert.equal(r.body.analysisStatus, 'pending');
    assert.equal(incCalls.length, 1);
    assert.equal(incCalls[0].counterKey, 'auditsRun');
  });

  it('does not increment when no tierQuota is present (quota-less path)', async () => {
    const req = { params: { contentNumber: '1' }, workspace: { _id: 'ws1' } };
    const r = res();
    await analysisController.reanalyze(req, r);
    assert.equal(r.body.analysisStatus, 'pending');
    assert.equal(incCalls.length, 0);
  });

  it('409s and does NOT consume quota when a run is already in progress', async () => {
    content = { _id: 'c1', analysisStatus: 'analyzing' };
    const req = { params: { contentNumber: '1' }, workspace: { _id: 'ws1' }, tierQuota };
    const r = res();
    await analysisController.reanalyze(req, r);
    assert.equal(r.statusCode, 409);
    assert.equal(incCalls.length, 0, 'must not double-charge an in-flight run');
  });

  // Phase 6 review MAJOR: re-score must NOT be charged at trigger time — the
  // charge moved INTO runAnalysis's success hook so an engine outage or a
  // zero-keyword run never bills. At the reanalyze level, no charge fires.
  it('does NOT charge re-score at trigger (charge deferred to runAnalysis success)', async () => {
    const req = { params: { contentNumber: '1' }, workspace: { _id: 'ws1' }, user: { userId: 'u1' }, tierQuota };
    const r = res();
    await analysisController.reanalyze(req, r);
    assert.equal(r.body.analysisStatus, 'pending');
    assert.equal(deductCalls.length, 0, 'no deductForRequest at trigger');
    // runAnalysis is neutralized (findById → null returns before the success hook),
    // so the deferred chargeAction never runs here either — proving trigger-time
    // billing is gone. (The on-success charge is exercised via chargeAction tests.)
    assert.equal(chargeCalls.length, 0, 'no charge until runAnalysis succeeds');
  });
});

describe('curateCitationAppearance — mapping (Rec 3)', () => {
  it('maps snake_case engine output to camelCase', () => {
    const out = analysisController.curateCitationAppearance([
      { domain: 'x.com', appearances: 3, samples: 4, rate: 0.75, example_urls: ['https://x.com/1'] },
    ]);
    assert.deepEqual(out, [
      { domain: 'x.com', appearances: 3, samples: 4, rate: 0.75, exampleUrls: ['https://x.com/1'] },
    ]);
  });

  it('returns [] for null / undefined / non-array (old briefs)', () => {
    assert.deepEqual(analysisController.curateCitationAppearance(undefined), []);
    assert.deepEqual(analysisController.curateCitationAppearance(null), []);
    assert.deepEqual(analysisController.curateCitationAppearance({}), []);
  });

  it('defaults missing example_urls to []', () => {
    const out = analysisController.curateCitationAppearance([
      { domain: 'y.com', appearances: 1, samples: 2, rate: 0.5 },
    ]);
    assert.deepEqual(out[0].exampleUrls, []);
  });
});
