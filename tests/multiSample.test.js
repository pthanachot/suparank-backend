/**
 * Rec 12 (DELETED) — sampling_runs must never be sent to the engine.
 * The multiSample→sampling_runs passthrough was removed in the dead-code
 * cleanup (2026-07-09): the engine never implemented sampling_runs, so the
 * field was a silent no-op. These tests pin the DELETION — the flag must not
 * resurrect the field regardless of tier config. If Rec 12 is ever built for
 * real, rewrite these assertions alongside the engine implementation.
 * Everything runAnalysis touches up to the /api/analyze fetch is mocked; the
 * analyze call returns ok:false so the run fails fast after body capture.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const tierService = require('../src/services/tierService');
const { runAnalysis } = require('../src/controllers/analysisController');

const originals = {
  cFindById: Content.findById,
  cFindByIdAndUpdate: Content.findByIdAndUpdate,
  wFindById: Workspace.findById,
  tierCfg: tierService.getOrgTierConfig,
  fetch: global.fetch,
};
after(() => {
  Content.findById = originals.cFindById;
  Content.findByIdAndUpdate = originals.cFindByIdAndUpdate;
  Workspace.findById = originals.wFindById;
  tierService.getOrgTierConfig = originals.tierCfg;
  global.fetch = originals.fetch;
});

describe('runAnalysis multiSample passthrough', () => {
  let analyzeBodies;

  beforeEach(() => {
    analyzeBodies = [];
    Content.findById = async () => ({
      _id: 'c1', workspaceId: 'ws1', targetKeywords: ['crm software'], contentNumber: 5,
    });
    Content.findByIdAndUpdate = async () => ({});
    Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) });
    global.fetch = async (url, opts) => {
      // Phase E: runAnalysis submits to /api/analyze/jobs first (and would
      // fall back to /api/analyze only on 404). Capture the analyze body from
      // either endpoint; a 502 fails the run fast right after capture.
      const u = String(url);
      if (u.endsWith('/api/analyze') || u.endsWith('/api/analyze/jobs')) {
        analyzeBodies.push(JSON.parse(opts.body));
        return { ok: false, status: 502, text: async () => 'down', json: async () => ({}) };
      }
      // discover and everything else: fail fast, runAnalysis tolerates it
      return { ok: false, status: 502, text: async () => 'down', json: async () => ({}) };
    };
  });

  it('flag ON → sampling_runs STILL absent (Rec 12 deleted, engine never implemented it)', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'agency', config: { multiSample: true } });
    await runAnalysis('c1');
    assert.equal(analyzeBodies.length, 1);
    assert.ok(!('sampling_runs' in analyzeBodies[0]), 'deleted field must not resurrect');
  });

  it('flag OFF → analyze body omits sampling_runs entirely', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'pro', config: { multiSample: false } });
    await runAnalysis('c1');
    assert.equal(analyzeBodies.length, 1);
    assert.ok(!('sampling_runs' in analyzeBodies[0]), 'field must be absent, not 0/null');
  });

  it('tier lookup failure → omitted (fail-safe: never sample by accident)', async () => {
    tierService.getOrgTierConfig = async () => { throw new Error('db down'); };
    await runAnalysis('c1');
    assert.equal(analyzeBodies.length, 1);
    assert.ok(!('sampling_runs' in analyzeBodies[0]));
  });
});
