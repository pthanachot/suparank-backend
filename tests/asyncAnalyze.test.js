/**
 * Phase E — the async analyze client (analyzeViaEngine, exercised through
 * runAnalysis). Pins the submit → poll protocol against the engine's
 * /api/analyze/jobs API:
 *   - submit 202 → poll until done → result consumed like a sync response
 *   - submit 404 (old engine) → synchronous /api/analyze fallback
 *   - poll 404 (engine restarted, job lost) → analysis fails, not hangs
 *   - job failed → analysis fails with the job's error
 *   - opts.refresh → body refresh: true (re-analysis bypasses the engine cache)
 *   - result cache_hit: true → cost ledger records NOTHING (the original run
 *     already paid; re-recording would double-count COGS)
 *
 * ENGINE_JOB_POLL_MS is read at module load, so it is set before requiring
 * the controller (each test file runs in its own process under node --test).
 */

process.env.ENGINE_JOB_POLL_MS = '5';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const tierService = require('../src/services/tierService');
const costLedger = require('../src/services/costLedgerService');
const { runAnalysis } = require('../src/controllers/analysisController');

const originals = {
  cFindById: Content.findById,
  cFindByIdAndUpdate: Content.findByIdAndUpdate,
  wFindById: Workspace.findById,
  tierCfg: tierService.getOrgTierConfig,
  ledger: costLedger.record,
  fetch: global.fetch,
};
after(() => {
  Content.findById = originals.cFindById;
  Content.findByIdAndUpdate = originals.cFindByIdAndUpdate;
  Workspace.findById = originals.wFindById;
  tierService.getOrgTierConfig = originals.tierCfg;
  costLedger.record = originals.ledger;
  global.fetch = originals.fetch;
});

describe('runAnalysis async job protocol', () => {
  let statusWrites; // captured Content.findByIdAndUpdate $set payloads
  let ledgerRows;

  beforeEach(() => {
    statusWrites = [];
    ledgerRows = [];
    Content.findById = async () => ({
      _id: 'c1', workspaceId: 'ws1', targetKeywords: ['crm software'], contentNumber: 5,
    });
    Content.findByIdAndUpdate = async (_id, u) => { statusWrites.push(u && u.$set); return {}; };
    Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) });
    tierService.getOrgTierConfig = async () => ({ tier: 'professional', config: {} });
    costLedger.record = (row) => { ledgerRows.push(row); };
  });

  function lastStatus() {
    for (let i = statusWrites.length - 1; i >= 0; i--) {
      if (statusWrites[i] && statusWrites[i].analysisStatus) return statusWrites[i];
    }
    return {};
  }

  const jobResult = (extra = {}) => ({
    content_brief: { pipeline_cost: 0.02 },
    competitor_pages: [],
    conversations: [],
    pipeline_steps: [{ step: 's1', model: 'm', prompt_tokens: 10, completion_tokens: 5, cost: 0.02 }],
    ...extra,
  });

  // Builds a fetch stub: submitStatus/pollSequence drive the job endpoints;
  // everything else fails fast (runAnalysis tolerates those).
  function stubFetch({ submit, polls, onSync }) {
    let pollIdx = 0;
    const calls = { submits: [], syncBodies: [], pollCount: 0 };
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.endsWith('/api/analyze/jobs')) {
        calls.submits.push(JSON.parse(opts.body));
        return submit;
      }
      if (u.includes('/api/analyze/jobs/')) {
        calls.pollCount++;
        const p = polls[Math.min(pollIdx, polls.length - 1)];
        pollIdx++;
        return p;
      }
      if (u.endsWith('/api/analyze')) {
        calls.syncBodies.push(JSON.parse(opts.body));
        return onSync || { ok: false, status: 502, text: async () => 'down', json: async () => ({}) };
      }
      return { ok: false, status: 502, text: async () => 'down', json: async () => ({}) };
    };
    return calls;
  }

  const okJSON = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

  it('submit 202 → polls until done → analysis succeeds', async () => {
    const calls = stubFetch({
      submit: okJSON({ job_id: 'j1', status: 'queued' }),
      polls: [
        okJSON({ job_id: 'j1', status: 'running' }),
        okJSON({ job_id: 'j1', status: 'done', result: jobResult() }),
      ],
    });
    // The 202 body is delivered via json(); status code 202 vs 200 is not
    // material to the client — .ok is.
    await runAnalysis('c1');
    assert.equal(calls.submits.length, 1);
    assert.ok(calls.pollCount >= 2, 'should have polled through running to done');
    assert.equal(calls.syncBodies.length, 0, 'no sync fallback on a healthy engine');
    // Analysis proceeded past analyze (benchmark persisted → status ready at the end)
    assert.equal(lastStatus().analysisStatus, 'ready');
    assert.equal(ledgerRows.length, 1, 'fresh run records its pipeline step');
  });

  it('submit 404 (old engine) → falls back to synchronous /api/analyze', async () => {
    const calls = stubFetch({
      submit: { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' },
      polls: [],
      onSync: okJSON(jobResult()),
    });
    await runAnalysis('c1');
    assert.equal(calls.syncBodies.length, 1, 'must fall back to the sync endpoint');
    assert.equal(lastStatus().analysisStatus, 'ready');
  });

  it('poll 404 (job lost to an engine restart) → analysis fails, never hangs', async () => {
    stubFetch({
      submit: okJSON({ job_id: 'j1', status: 'queued' }),
      polls: [{ ok: false, status: 404, json: async () => ({}), text: async () => 'unknown job' }],
    });
    await runAnalysis('c1');
    const s = lastStatus();
    assert.equal(s.analysisStatus, 'failed');
    assert.match(s.analysisError || '', /job lost/);
  });

  it('job failed → analysis fails with the job error', async () => {
    stubFetch({
      submit: okJSON({ job_id: 'j1', status: 'queued' }),
      polls: [okJSON({ job_id: 'j1', status: 'failed', error: 'could not crawl any competitor pages' })],
    });
    await runAnalysis('c1');
    const s = lastStatus();
    assert.equal(s.analysisStatus, 'failed');
    assert.match(s.analysisError || '', /could not crawl/);
  });

  it('opts.refresh → submit body carries refresh: true', async () => {
    const calls = stubFetch({
      submit: okJSON({ job_id: 'j1', status: 'done' }),
      polls: [okJSON({ job_id: 'j1', status: 'done', result: jobResult() })],
    });
    await runAnalysis('c1', { refresh: true });
    assert.equal(calls.submits[0].refresh, true);
  });

  it('no refresh by default (first analysis may use the engine cache)', async () => {
    const calls = stubFetch({
      submit: okJSON({ job_id: 'j1', status: 'done' }),
      polls: [okJSON({ job_id: 'j1', status: 'done', result: jobResult() })],
    });
    await runAnalysis('c1');
    assert.equal('refresh' in calls.submits[0], false);
  });

  it('cache_hit result → cost ledger records nothing (no double-counted COGS)', async () => {
    stubFetch({
      submit: okJSON({ job_id: 'j1', status: 'done' }),
      polls: [okJSON({ job_id: 'j1', status: 'done', result: jobResult({ cache_hit: true }) })],
    });
    await runAnalysis('c1');
    assert.equal(lastStatus().analysisStatus, 'ready', 'cache hit is still a successful analysis');
    assert.equal(ledgerRows.length, 0, 'cached pipeline_steps must not be re-recorded');
  });
});
