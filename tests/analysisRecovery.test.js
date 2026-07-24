/**
 * Startup recovery for analyses interrupted by a restart.
 *
 * runAnalysis is in-process fire-and-forget: no queue, no job row, no lease. A
 * content doc sits at 'analyzing' for the several minutes the engine pipeline
 * takes, so any process death in that window strands it there forever. That is
 * not cosmetic — triggerAnalysis, reanalyze and retryAnalysis ALL 409 while the
 * status reads 'analyzing', so a stranded article can never be analyzed again
 * without a direct DB edit.
 *
 * These tests pin the two properties that make the sweep actually fix that:
 *   1. it targets both stuck states ('pending' and 'analyzing') and nothing else
 *   2. it tags the failure `transient:`, which is the exact predicate
 *      retryAnalysis uses to offer the FREE retry — an interruption is our
 *      fault, so it must not push the user to a paid re-run.
 *
 * No DB / no network: Content is monkey-patched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const analysisController = require('../src/controllers/analysisController');

function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Capture the (filter, update) the sweep issues, without touching a database.
async function captureSweep(modifiedCount = 0) {
  const saved = Content.updateMany;
  let call = null;
  Content.updateMany = async (filter, update) => {
    call = { filter, update };
    return { modifiedCount };
  };
  try {
    const recovered = await analysisController.recoverInterruptedAnalyses();
    return { call, recovered };
  } finally {
    Content.updateMany = saved;
  }
}

test('sweep targets exactly the two states a restart can strand', async () => {
  const { call } = await captureSweep();
  assert.deepEqual(call.filter, { analysisStatus: { $in: ['pending', 'analyzing'] } });
});

test('sweep moves stranded rows to failed', async () => {
  const { call } = await captureSweep();
  assert.equal(call.update.$set.analysisStatus, 'failed');
});

test('sweep returns how many rows it recovered', async () => {
  const { recovered } = await captureSweep(3);
  assert.equal(recovered, 3);
});

test('sweep tolerates a driver result without modifiedCount', async () => {
  const saved = Content.updateMany;
  Content.updateMany = async () => undefined;
  try {
    assert.equal(await analysisController.recoverInterruptedAnalyses(), 0);
  } finally {
    Content.updateMany = saved;
  }
});

// The contract that matters: whatever the sweep writes must be something
// retryAnalysis will accept for a FREE retry. Asserting the literal prefix would
// pass even if retryAnalysis's predicate changed, so drive the real route with
// the real swept value instead.
test('a swept row is eligible for the free retry, not a paid re-run', async () => {
  const { call } = await captureSweep();
  const sweptError = call.update.$set.analysisError;

  const saved = {
    findByNumber: Content.findByNumber,
    upd: Content.findByIdAndUpdate,
    findById: Content.findById,
  };
  const updates = [];
  Content.findByNumber = async () => ({
    _id: 'c1',
    contentNumber: 5,
    locked: false,
    analysisStatus: 'failed',
    analysisError: sweptError,
    targetKeywords: ['chicken farming'],
  });
  Content.findByIdAndUpdate = async (_id, u) => { updates.push(u); return {}; };
  Content.findById = async () => null; // fire-and-forget runAnalysis early-returns

  const res = mkRes();
  try {
    await analysisController.retryAnalysis(
      { params: { contentNumber: 5 }, workspace: { _id: 'w1' }, user: { userId: 'u1' } },
      res,
    );
  } finally {
    Content.findByNumber = saved.findByNumber;
    Content.findByIdAndUpdate = saved.upd;
    Content.findById = saved.findById;
  }

  assert.equal(res.statusCode, 200, 'free retry must accept a restart-interrupted analysis');
  assert.ok(
    updates.some((u) => u && u.$set && u.$set.analysisStatus === 'pending'),
    'retry should re-queue the analysis',
  );
});

// Guards the inverse: a genuine engine failure stays paid-only, so the sweep's
// tag can't be mistaken for "every failure is free".
test('a non-transient failure is still refused by the free retry', async () => {
  const saved = Content.findByNumber;
  Content.findByNumber = async () => ({
    _id: 'c1',
    contentNumber: 5,
    locked: false,
    analysisStatus: 'failed',
    analysisError: 'engine returned 500',
    targetKeywords: ['chicken farming'],
  });
  const res = mkRes();
  try {
    await analysisController.retryAnalysis(
      { params: { contentNumber: 5 }, workspace: { _id: 'w1' }, user: { userId: 'u1' } },
      res,
    );
  } finally {
    Content.findByNumber = saved;
  }
  assert.equal(res.statusCode, 409);
});
