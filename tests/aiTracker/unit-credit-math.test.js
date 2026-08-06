/**
 * Phase 2 — tracker credit math + live scan-cost estimator.
 *
 * Targets:
 *   - resolveCredits for the three tracker actions (trackerRefreshAll 5×n
 *     uncapped, trackerRefreshSingle flat 5, promptResearch flat 10) plus
 *     the inactive-action and prototype-key guards scoped to tracker use.
 *   - estimateScanCredits (aiTrackerRoutes.__test): the F4-14 live estimator
 *     — happy path 5×active-prompts, and every fallback-to-5 branch.
 *
 * Models monkey-patched; no DB, no network.
 * Run: node --test tests/aiTracker/unit-credit-math.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { resolveCredits } = require('../../src/config/creditRules');
const routes = require('../../src/routes/aiTrackerRoutes');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');

const { estimateScanCredits } = routes.__test;

describe('resolveCredits — tracker actions', () => {
  it('trackerRefreshAll: 5 × activePrompts, uncapped', () => {
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 0 }), 0);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 1 }), 5);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 12 }), 60);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 500 }), 2500, 'no cap on this action');
  });

  it('trackerRefreshAll: missing count defaults to 1 unit; NaN/negative coerce to 0', () => {
    assert.equal(resolveCredits('trackerRefreshAll', {}), 5);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: NaN }), 0);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: -3 }), 0);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 'lots' }), 0);
  });

  it('trackerRefreshSingle: flat 5 regardless of counts', () => {
    assert.equal(resolveCredits('trackerRefreshSingle'), 5);
    assert.equal(resolveCredits('trackerRefreshSingle', { activePrompts: 40 }), 5);
  });

  it('promptResearch: flat 10 — no free-tier Option B (Free draws from the sample pool elsewhere)', () => {
    assert.equal(resolveCredits('promptResearch', {}), 10);
    assert.equal(resolveCredits('promptResearch', { tier: 'free' }), 10);
  });

  it('zeroCredit context always yields 0 (in-allowance scheduled scans)', () => {
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 9, zeroCredit: true }), 0);
    assert.equal(resolveCredits('trackerRefreshSingle', { zeroCredit: true }), 0);
  });

  it('inactive keyword-side actions THROW (never billed until built)', () => {
    for (const action of ['serpDeepDive', 'relatedIdeasReport', 'clusteringRun']) {
      assert.throws(() => resolveCredits(action, {}), /not active/);
    }
  });

  it('unknown and prototype-key actions THROW (own-property guard)', () => {
    assert.throws(() => resolveCredits('nonexistentAction', {}), /Unknown credit action/);
    assert.throws(() => resolveCredits('constructor', {}), /Unknown credit action/);
    assert.throws(() => resolveCredits('__proto__', {}), /Unknown credit action/);
  });
});

// ── estimateScanCredits (the F4-14 live estimator) ──────────────────────────

const VALID_MONITOR_ID = 'cccccccccccccccccccccccc';

const origFindById = AiTracker.findById;
const origFindOne = AiTracker.findOne;
const origCount = AiTrackerPrompt.countDocuments;

// Chainable .select().lean() stub matching the estimator's query shape.
function chainable(doc) {
  return { select: () => ({ lean: async () => doc }) };
}

let countFilter;

beforeEach(() => {
  countFilter = null;
  AiTracker.findById = () => chainable({ _id: VALID_MONITOR_ID, workspaceId: 'ws1', defaultModels: ['chatgpt'] });
  AiTracker.findOne = () => chainable({ _id: 'tracker1', workspaceId: 'ws1', defaultModels: ['chatgpt'] });
  AiTrackerPrompt.countDocuments = async (filter) => {
    countFilter = filter;
    return 3;
  };
});

afterEach(() => {
  AiTracker.findById = origFindById;
  AiTracker.findOne = origFindOne;
  AiTrackerPrompt.countDocuments = origCount;
});

describe('estimateScanCredits', () => {
  it('legacy single-monitor path: resolves the workspace tracker and returns 5 × active prompts', async () => {
    const req = { params: { workspaceNumber: '123456' }, workspace: { _id: 'ws1' } };
    assert.equal(await estimateScanCredits(req), 15, '3 active prompts × 5');
    assert.equal(countFilter.trackerId, 'tracker1');
    assert.deepEqual(countFilter.active, { $ne: false }, 'counts only active prompts (F4-21)');
    assert.deepEqual(countFilter.locked, { $ne: true }, 'excludes downgrade-locked prompts (F4-21)');
  });

  it('monitor-scoped path: resolves by monitorId', async () => {
    const req = { params: { workspaceNumber: '123456', monitorId: VALID_MONITOR_ID } };
    assert.equal(await estimateScanCredits(req), 15);
  });

  it('floors at 1 even when zero prompts are active (Math.max guard)', async () => {
    AiTrackerPrompt.countDocuments = async () => 0;
    const req = { params: { workspaceNumber: '123456' }, workspace: { _id: 'ws1' } };
    assert.equal(await estimateScanCredits(req), 1);
  });

  it('falls back to 5 on: invalid workspaceNumber', async () => {
    assert.equal(await estimateScanCredits({ params: { workspaceNumber: 'abc' } }), 5);
  });

  it('falls back to 5 on: missing req.workspace (legacy path)', async () => {
    assert.equal(await estimateScanCredits({ params: { workspaceNumber: '123456' } }), 5);
  });

  it('falls back to 5 on: tracker not found', async () => {
    AiTracker.findOne = () => chainable(null);
    const req = { params: { workspaceNumber: '123456' }, workspace: { _id: 'ws1' } };
    assert.equal(await estimateScanCredits(req), 5);
  });

  it('falls back to 5 on: a thrown lookup (transient Mongo error must not let a scan through free)', async () => {
    AiTrackerPrompt.countDocuments = async () => {
      throw new Error('mongo down');
    };
    const req = { params: { workspaceNumber: '123456' }, workspace: { _id: 'ws1' } };
    assert.equal(await estimateScanCredits(req), 5);
  });

  it('malformed monitorId falls through to the workspace path (regex guard)', async () => {
    let findByIdCalled = false;
    AiTracker.findById = () => {
      findByIdCalled = true;
      return chainable(null);
    };
    const req = { params: { workspaceNumber: '123456', monitorId: 'not-hex!' }, workspace: { _id: 'ws1' } };
    assert.equal(await estimateScanCredits(req), 15, 'uses the workspace tracker instead');
    assert.equal(findByIdCalled, false, 'never queries by a malformed id');
  });
});
