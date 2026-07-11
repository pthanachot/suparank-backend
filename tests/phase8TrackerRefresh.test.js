/**
 * Phase 8 — AI Tracker entitlements.
 *  - single on-demand refresh endpoint (refreshPrompt): validation, credit
 *    pre-check, RBAC-adjacent behavior, 5-credit flat cost.
 *  - per-tier engine clamp (clampEnginesToTier): 2 Free / 4 paid at scan time.
 *  - RBAC policy pins for the four Phase-8 tracker actions.
 *  - credit costs: single = flat 5, refresh-all = 5 × n.
 * Models + creditService monkey-patched; no DB/network. The handler's
 * fire-and-forget executeScan no-ops because the mocked scan-claim returns null.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const aiTrackerController = require('../src/controllers/aiTrackerController');
const AiTracker = require('../src/models/AiTracker');
const AiTrackerPrompt = require('../src/models/AiTrackerPrompt');
const creditService = require('../src/services/creditService');
const { can } = require('../src/middleware/permissions.policy');
const { resolveCredits } = require('../src/config/creditRules');

const { clampEnginesToTier, scanProducedResults } = aiTrackerController.__test;

// ─── clampEnginesToTier (engine cap 2/4 enforced at scan time) ──────────────
describe('clampEnginesToTier', () => {
  const four = ['chatgpt', 'gemini', 'claude', 'perplexity'];
  it('Free (2) clamps a 4-engine monitor to 2', () => {
    assert.deepEqual(clampEnginesToTier(four, 2), ['chatgpt', 'gemini']);
  });
  it('paid (4) leaves a 4-engine monitor untouched', () => {
    assert.deepEqual(clampEnginesToTier(four, 4), four);
  });
  it('already within cap → unchanged', () => {
    assert.deepEqual(clampEnginesToTier(['chatgpt'], 2), ['chatgpt']);
  });
  it('null/absent cap (Agency ∞ / lookup miss) → unchanged', () => {
    assert.deepEqual(clampEnginesToTier(four, null), four);
    assert.deepEqual(clampEnginesToTier(four, undefined), four);
    assert.deepEqual(clampEnginesToTier(four, 0), four);
  });
});

// ─── scanProducedResults (single-refresh charge-on-no-work guard, review fix #1) ──
describe('scanProducedResults — single refresh bills only real work', () => {
  it('true when a prompt produced platform rows → billable 5', () => {
    assert.equal(scanProducedResults([{ promptId: 'p1', platforms: [{ platformId: 'chatgpt' }] }]), true);
  });
  it('false for empty results (locked mid-scan → prompts=[]) → refund 0', () => {
    assert.equal(scanProducedResults([]), false);
  });
  it('false when every prompt ran no platforms (no engine overlap) → refund 0', () => {
    assert.equal(scanProducedResults([{ promptId: 'p1', platforms: [] }]), false);
  });
  it('false for non-array (defensive)', () => {
    assert.equal(scanProducedResults(undefined), false);
    assert.equal(scanProducedResults(null), false);
  });
});

// ─── credit costs ───────────────────────────────────────────────────────────
describe('tracker refresh costs', () => {
  it('single on-demand refresh is a flat 5', () => {
    assert.equal(resolveCredits('trackerRefreshSingle'), 5);
    assert.equal(resolveCredits('trackerRefreshSingle', { tier: 'professional', activePrompts: 99 }), 5);
  });
  it('refresh-all is 5 × active prompts', () => {
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 1 }), 5);
    assert.equal(resolveCredits('trackerRefreshAll', { activePrompts: 12 }), 60);
  });
});

// ─── RBAC policy pins (v4 Table 3) ──────────────────────────────────────────
describe('Phase 8 tracker RBAC', () => {
  it('managePrompts = Editor+ (owner/admin/editor; not viewer/client)', () => {
    for (const rr of ['owner', 'admin', 'editor']) assert.equal(can(rr, 'tracker.managePrompts'), true, rr);
    for (const rr of ['viewer', 'client']) assert.equal(can(rr, 'tracker.managePrompts'), false, rr);
  });
  it('refreshOne = Editor+ (on-demand single, 5 cr)', () => {
    assert.equal(can('editor', 'tracker.refreshOne'), true);
    assert.equal(can('viewer', 'tracker.refreshOne'), false);
  });
  it('refreshAll = Admin+ (editor DENIED)', () => {
    assert.equal(can('admin', 'tracker.refreshAll'), true);
    assert.equal(can('editor', 'tracker.refreshAll'), false);
  });
  it('manageMonitor = Admin+ (editor DENIED)', () => {
    assert.equal(can('admin', 'tracker.manageMonitor'), true);
    assert.equal(can('editor', 'tracker.manageMonitor'), false);
  });
});

// ─── refreshPrompt handler ──────────────────────────────────────────────────
const real = {
  promptFindById: AiTrackerPrompt.findById,
  trackerFindById: AiTracker.findById,
  updateMany: AiTracker.updateMany,
  findByIdAndUpdate: AiTracker.findByIdAndUpdate,
  findOneAndUpdate: AiTracker.findOneAndUpdate,
  canAfford: creditService.canAfford,
};
after(() => {
  AiTrackerPrompt.findById = real.promptFindById;
  AiTracker.findById = real.trackerFindById;
  AiTracker.updateMany = real.updateMany;
  AiTracker.findByIdAndUpdate = real.findByIdAndUpdate;
  AiTracker.findOneAndUpdate = real.findOneAndUpdate;
  creditService.canAfford = real.canAfford;
});

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const reqFor = (over = {}) => ({
  workspace: { _id: 'ws1' },
  params: { promptId: 'p1', ...(over.params || {}) },
  user: { userId: 'u1' },
  creditContext: over.creditContext !== undefined ? over.creditContext : { deductionEnabled: true, orgId: 'org1' },
});

let prompt, tracker, affordable;
beforeEach(() => {
  prompt = { _id: 'p1', trackerId: 't1', locked: false, active: true };
  tracker = { _id: 't1', workspaceId: 'ws1', scanStatus: 'ready' };
  affordable = true;
  AiTrackerPrompt.findById = async () => prompt;
  AiTracker.findById = async () => tracker;
  AiTracker.updateMany = async () => ({ modifiedCount: 0 });         // recoverStuckScans
  AiTracker.findByIdAndUpdate = async () => ({});                    // set pending
  AiTracker.findOneAndUpdate = async () => null;                    // executeScan claim → no-op
  creditService.canAfford = async () => affordable;
});

describe('refreshPrompt', () => {
  it('valid active prompt, affordable, idle → 200 pending', async () => {
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.scanStatus, 'pending');
    assert.equal(r.body.refreshing, 'p1');
  });

  it('prompt not found → 404', async () => {
    AiTrackerPrompt.findById = async () => null;
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 404);
  });

  it('prompt in a DIFFERENT workspace → 404 (no cross-workspace refresh)', async () => {
    tracker = { _id: 't1', workspaceId: 'wsOTHER', scanStatus: 'ready' };
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 404);
  });

  it('monitorId in path that does not match the prompt tracker → 404', async () => {
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor({ params: { promptId: 'p1', monitorId: 'tXXX' } }), r);
    assert.equal(r.statusCode, 404);
  });

  it('locked (downgrade) prompt → 403', async () => {
    prompt = { _id: 'p1', trackerId: 't1', locked: true, active: true };
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 403);
  });

  it('paused (inactive) prompt → 400', async () => {
    prompt = { _id: 'p1', trackerId: 't1', locked: false, active: false };
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 400);
  });

  it('scan already in progress → 409', async () => {
    tracker = { _id: 't1', workspaceId: 'ws1', scanStatus: 'scanning' };
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 409);
  });

  it('insufficient credits → 402', async () => {
    affordable = false;
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor(), r);
    assert.equal(r.statusCode, 402);
    assert.equal(r.body.code, 'INSUFFICIENT_CREDITS');
  });

  it('deductions disabled (BYOK/unmetered) → skips credit check, still 200', async () => {
    affordable = false; // would 402 if checked
    const r = res();
    await aiTrackerController.refreshPrompt(reqFor({ creditContext: { deductionEnabled: false } }), r);
    assert.equal(r.statusCode, 200);
  });
});
