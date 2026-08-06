/**
 * Phase 4 — Mongo write-failure rows: an injected DB error at each critical
 * write must land in Phase H with the tracker failed, a scheduled retry,
 * credits refunded (ledger conservation 0), and — when a scan doc exists —
 * that doc marked failed (the F4-07 fix).
 *
 * Injection style: one-shot monkey-patches on model statics, restored in
 * finally. The progress-write test targets the update shape (scanProgress
 * without scanStatus) so only the mid-scan write fails, not the claim or
 * the terminal write.
 *
 * Run: node --test tests/aiTracker/failures-mongo.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');
const ledger = require('./helpers/ledger');

const chatgptFixture = require('./fixtures/chatgpt-responses-clean.json');
const kimiFixture = require('./fixtures/kimi-analyzer-clean.json');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PERPLEXITY_API_KEY;

const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../../src/models/AiTrackerScan');
const creditService = require('../../src/services/creditService');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

let wsCounter = 994000;

async function seedWorld() {
  const orgId = new mongoose.Types.ObjectId();
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    name: `Mongo WS ${wsCounter}`,
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id,
    domain: 'suparank.com',
    name: `Mongo Monitor ${wsCounter}`,
    defaultModels: ['chatgpt'],
    scanStatus: 'pending',
  });
  await AiTrackerPrompt.create({
    trackerId: tracker._id,
    prompt: `mongo scenario prompt ${wsCounter}`,
    models: ['chatgpt'],
    frequency: 'Weekly',
    active: true,
  });
  await creditService.grantGeneralCredits(orgId.toString(), 100, 'phase4 seed');
  return { orgId: orgId.toString(), tracker };
}

function happyVendors() {
  vendorMock.script({
    chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
    kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
  });
}

async function assertPhaseH(orgId, trackerId, beforeBal, { errContains, label, settled = 0 }) {
  await ledger.assertConservation(beforeBal, orgId, { settled, label: `${label} (money)` });
  await ledger.assertNoPendingTx({ organizationId: orgId }, label);
  const trackerAfter = await AiTracker.findById(trackerId).lean();
  assert.equal(trackerAfter.scanStatus, 'failed');
  assert.ok(trackerAfter.scanError.includes(errContains), `scanError carries the cause: ${trackerAfter.scanError}`);
  assert.equal(trackerAfter.currentScanId, null);
  const retryDelta = trackerAfter.nextScanAt.getTime() - Date.now();
  assert.ok(retryDelta > 50 * 60 * 1000 && retryDelta <= 60 * 60 * 1000, `retry ≈ 1h out (got ${Math.round(retryDelta / 60000)}min)`);
  return trackerAfter;
}

before(async () => {
  // Precondition: retry-window assertions assume real time. A persisted
  // backend/src/.dev-time-scale (from manual dev testing) would shrink
  // Phase-H retry delays and fail those asserts mysteriously — fail loudly
  // here instead.
  assert.equal(
    aiTrackerController.getDevTimeScale?.() ?? 1,
    1,
    'dev time scale must be 1 for this suite — delete backend/src/.dev-time-scale',
  );
  await db.connect();
  await db.clear();
  vendorMock.install();
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

beforeEach(() => vendorMock.script({}));

describe('Mongo write failures land in Phase H', () => {
  it('scan-doc create fails → Phase H before any vendor call: refund, failed, retry ≈1h', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld();
    const beforeBal = await ledger.snapshot(orgId);

    const origCreate = AiTrackerScan.create;
    AiTrackerScan.create = async () => { throw new Error('injected scan-create outage'); };
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    } finally {
      AiTrackerScan.create = origCreate;
    }

    await assertPhaseH(orgId, tracker._id, beforeBal, { errContains: 'injected scan-create outage', label: 'scan-create' });
    assert.equal(vendorMock.calls.length, 0, 'failed before spending a single vendor call');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0);
  });

  it('results write (B10) fails → Phase H marks the EXISTING scan doc failed (F4-07 fix), refunds, schedules retry', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld();
    happyVendors();
    const beforeBal = await ledger.snapshot(orgId);

    // One-shot: only the FIRST AiTrackerScan.findByIdAndUpdate (the B10
    // results write) throws; Phase H's mark-failed call then succeeds.
    const origUpdate = AiTrackerScan.findByIdAndUpdate;
    let fired = false;
    AiTrackerScan.findByIdAndUpdate = function (...args) {
      if (!fired) {
        fired = true;
        throw new Error('injected results-write outage');
      }
      return origUpdate.apply(this, args);
    };
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    } finally {
      AiTrackerScan.findByIdAndUpdate = origUpdate;
    }

    // ── P4-01 FIXED (Phase A) ── Settle runs BEFORE the results write (the
    // S74 ordering). When the results write throws, refund() cannot reverse
    // an already-'settled' group, so Phase H issues a COMPENSATING credit
    // for exactly the settled amount. Net movement must therefore be ZERO:
    // the user is not charged for results that were never saved.
    await assertPhaseH(orgId, tracker._id, beforeBal, {
      errContains: 'injected results-write outage', label: 'results-write', settled: 0,
    });
    assert.ok(vendorMock.calls.length >= 2, 'vendor work was done, charged, then compensated back');
    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.equal(scan.status, 'failed', 'F4-07: no orphaned running scan doc');
    assert.ok(scan.completedAt instanceof Date);
  });

  it('P4-01 boundary: a failure AFTER the results write does NOT compensate (results were delivered)', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld();
    happyVendors();
    const beforeBal = await ledger.snapshot(orgId);

    // Let the results write succeed, then blow up the NEXT tracker write
    // (step 10, "mark ready"). The user has their scan; Phase H must not
    // hand the credits back — an earlier version of the fix did exactly
    // that, giving away the scan for free.
    const origUpdate = AiTracker.findByIdAndUpdate;
    let fired = false;
    AiTracker.findByIdAndUpdate = function (id, update, ...rest) {
      if (!fired && update?.$set?.scanStatus === 'ready' && update.$set.scanProgress === 100) {
        fired = true;
        throw new Error('injected mark-ready outage');
      }
      return origUpdate.call(this, id, update, ...rest);
    };
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    } finally {
      AiTracker.findByIdAndUpdate = origUpdate;
    }

    assert.equal(fired, true, 'the injection must have hit the mark-ready write');
    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.ok(Array.isArray(scan.results) && scan.results.length > 0, 'results WERE saved before the failure');
    // Charge stands: 5 settled, no compensation.
    await ledger.assertConservation(beforeBal, orgId, { settled: 5, label: 'P4-01 boundary (delivered → keep charge)' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'P4-01 boundary');
  });

  it('mid-scan progress write fails → pins the real behavior end-to-end', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld();
    happyVendors();
    const beforeBal = await ledger.snapshot(orgId);

    // Target ONLY progress updates: $set carries scanProgress but no scanStatus
    // (claim and terminal writes both set scanStatus).
    const origUpdate = AiTracker.findByIdAndUpdate;
    let fired = false;
    AiTracker.findByIdAndUpdate = function (id, update, ...rest) {
      const set = update && update.$set;
      if (!fired && set && set.scanProgress !== undefined && set.scanStatus === undefined) {
        fired = true;
        throw new Error('injected progress-write outage');
      }
      return origUpdate.call(this, id, update, ...rest);
    };
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    } finally {
      AiTracker.findByIdAndUpdate = origUpdate;
    }

    assert.equal(fired, true, 'the injection actually hit a progress write');
    // Pinned reality: a progress-write failure aborts the run via Phase H —
    // the engine does not tolerate onProgress errors. Refund + failed + retry.
    await assertPhaseH(orgId, tracker._id, beforeBal, { errContains: 'injected progress-write outage', label: 'progress-write' });
    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.equal(scan.status, 'failed', 'scan doc reached a terminal state');
  });
});
