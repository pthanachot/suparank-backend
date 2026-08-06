/**
 * Phase 3 — money invariants & credit lifecycle (scenarios 1-5, 7-9).
 *
 * Every scan outcome is checked against the ledger-conservation invariant:
 * balance moves by EXACTLY the credits settled, and every pre-deduction
 * transaction terminates (settled/refunded). Runs the REAL stack — memory
 * replset Mongo, real creditService transactions, real executeScan — with
 * vendors mocked at global fetch (Phase 1 harness).
 *
 * Scenario 6 (orphan sweep) and the reconciliation checks live in
 * credits-sweep.test.js.
 *
 * Run: node --test tests/aiTracker/credits-lifecycle.test.js
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
const Subscription = require('../../src/models/Subscription');
const UsageTracker = require('../../src/models/UsageTracker');
const creditService = require('../../src/services/creditService');
const tierService = require('../../src/services/tierService');
const { reconcile } = require('../../scripts/reconcileTrackerCredits');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

let wsCounter = 991000;

/** Seed one isolated world: org (fresh id → no tier-cache hits), workspace,
 *  tracker (chatgpt only), N prompts, and a credit balance. */
async function seedWorld({ prompts = 1, credits = 100, paid = false, orgless = false, promptOverrides = [] } = {}) {
  const orgId = orgless ? null : new mongoose.Types.ObjectId();
  if (paid && orgId) {
    await Subscription.create({ organizationId: orgId, planId: 'standard-monthly', status: 'active' });
  }
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: new mongoose.Types.ObjectId(), // no User doc → scan email skipped
    organizationId: orgId,
    name: `Credits WS ${wsCounter}`,
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id,
    domain: 'suparank.com',
    name: `Credits Monitor ${wsCounter}`,
    defaultModels: ['chatgpt'],
    scanStatus: 'pending',
  });
  const promptDocs = [];
  for (let i = 0; i < prompts; i++) {
    promptDocs.push(await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: `credits scenario prompt ${i} ${wsCounter}`,
      models: ['chatgpt'],
      frequency: 'Weekly',
      active: true,
      ...(promptOverrides[i] || {}),
    }));
  }
  if (credits > 0 && orgId) {
    await creditService.grantGeneralCredits(orgId.toString(), credits, 'phase3 seed');
  }
  return { orgId: orgId ? orgId.toString() : null, ws, tracker, promptDocs };
}

function happyVendors() {
  vendorMock.script({
    chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
    kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
  });
}

before(async () => {
  await db.connect();
  await db.clear();
  vendorMock.install();
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

beforeEach(() => {
  vendorMock.script({}); // default: ANY vendor call throws unless a test scripts it
});

describe('scenario 1 — happy refresh-all: preDeduct 5×n, settle 5×n', () => {
  it('2 prompts → exactly 10 credits settled, all txs terminal, usage counter raised', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({ prompts: 2 });
    happyVendors();
    const before = await ledger.snapshot(orgId);
    assert.equal(before.total, 100);

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    await ledger.assertConservation(before, orgId, { settled: 10, label: 'S1' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S1');

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');

    const period = tierService.getPeriod('monthly');
    const usage = await UsageTracker.findOne({ organizationId: orgId, period }).lean();
    assert.equal(usage.creditsUsed, 10, 'F10-03: usage counter matches the settled charge');
  });
});

describe('scenario 2 — single on-demand refresh', () => {
  it('with results → flat 5 settled', { timeout: 60_000 }, async () => {
    const { orgId, tracker, promptDocs } = await seedWorld({ prompts: 1 });
    happyVendors();
    const before = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, {
      promptIds: [promptDocs[0]._id], costAction: 'trackerRefreshSingle', bill: true,
    });

    await ledger.assertConservation(before, orgId, { settled: 5, label: 'S2a' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S2a');
  });

  it('without results (models no longer overlap the engines) → 0 billed, full refund, timer NOT advanced', { timeout: 60_000 }, async () => {
    const { orgId, tracker, promptDocs } = await seedWorld({
      prompts: 1,
      promptOverrides: [{ models: ['gemini'] }], // gemini key absent → prompt scans nowhere
    });
    // No vendor steps scripted: ANY call would throw — proves zero API spend.
    const before = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, {
      promptIds: [promptDocs[0]._id], costAction: 'trackerRefreshSingle', bill: true,
    });

    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S2b' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S2b');
    assert.equal(vendorMock.calls.length, 0, 'no vendor was called');

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    const promptAfter = await AiTrackerPrompt.findById(promptDocs[0]._id).lean();
    assert.equal(promptAfter.lastScannedAt ?? null, null, 'F4-19: unscanned prompt keeps its schedule');
  });
});

describe('scenario 3 — insufficient credits at preDeduct', () => {
  it('scan is skipped cleanly: no ledger movement, no scan doc, retry scheduled', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({ prompts: 1, credits: 2 }); // needs 5
    const before = await ledger.snapshot(orgId);
    const t0 = Date.now();

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S3' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S3');
    assert.equal(vendorMock.calls.length, 0);

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.scanError, 'Insufficient credits');
    assert.ok(trackerAfter.nextScanAt.getTime() > t0 + 30 * 60 * 1000, 'retry pushed ~1h out');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0, 'no scan doc created');
  });
});

describe('scenario 4 — settle failure (S74): refund, both docs failed', () => {
  it('refunds the pre-deduction and marks scan+tracker failed without saving results', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({ prompts: 1 });
    happyVendors();
    const before = await ledger.snapshot(orgId);

    const origSettle = creditService.settle;
    creditService.settle = async () => { throw new Error('settle boom (injected)'); };
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    } finally {
      creditService.settle = origSettle;
    }

    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S4 (full refund)' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S4');

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'failed');
    assert.equal(trackerAfter.scanError, 'Credit settlement failed');
    assert.ok(trackerAfter.nextScanAt instanceof Date, 'F4-09: retry IS scheduled after settle failure');

    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.equal(scan.status, 'failed', 'results are NOT published on settle failure');
  });
});

describe('scenario 5 — settle AND refund both fail: loss is logged, detectable, and sweep-recoverable', () => {
  it('leaves pending txs the reconciliation flags, then the sweep restores the balance', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({ prompts: 1 });
    happyVendors();
    const before = await ledger.snapshot(orgId);

    const origSettle = creditService.settle;
    const origRefund = creditService.refund;
    const errors = [];
    const origConsoleError = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    creditService.settle = async () => { throw new Error('settle boom (injected)'); };
    creditService.refund = async () => { throw new Error('refund boom (injected)'); };
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    } finally {
      creditService.settle = origSettle;
      creditService.refund = origRefund;
      console.error = origConsoleError;
    }

    // The loss is real (5 deducted, nothing settled) and it is LOGGED.
    const after = await creditService.getBalance(orgId);
    assert.equal(before.total - after.total, 5, 'credits are stuck in pending');
    assert.ok(errors.some((e) => e.includes('refund also failed')), 'double-failure is logged');

    // Reconciliation detects the orphan once it ages past the cutoff.
    await ledger.backdateTransactions(mongoose.connection, {
      organizationId: new mongoose.Types.ObjectId(orgId), status: 'pending',
    });
    const report = await reconcile();
    assert.equal(report.clean, false);
    assert.ok(report.anomalies.some((a) => a.check === 'orphaned_pending' && a.orgId === orgId));

    // And the (now healthy) sweep recovers the money.
    const sweep = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.ok(sweep.refundedGroups >= 1);
    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S5 post-sweep' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S5 post-sweep');
  });
});

describe('scenario 7 — settle-then-refund is a no-op (idempotency contract)', () => {
  it('refund after settle refunds nothing and moves no money', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    await creditService.grantGeneralCredits(orgId, 100, 'S7 seed');

    const { transactionId } = await creditService.preDeduct(orgId, null, 10, 'aiTrackerScan', { feature: 'aiTrackerScan' });
    const settleResult = await creditService.settle(transactionId, 6);
    assert.equal(settleResult.refunded, 4, 'over-estimate refunded at settle');
    assert.equal((await creditService.getBalance(orgId)).total, 94);

    const refundResult = await creditService.refund(transactionId);
    assert.equal(refundResult.refunded, 0, 'settled group cannot be refunded again');
    assert.equal((await creditService.getBalance(orgId)).total, 94, 'no double-credit');
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S7');
  });
});

describe('scenario 8 — unbilled paths move zero credits', () => {
  it('bill=false (unmetered/BYOK): scan completes, ledger untouched', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({ prompts: 1 });
    happyVendors();
    const before = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: false });

    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S8a' });
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.ok(vendorMock.calls.length > 0, 'the scan really ran');
  });

  it('cron (force=false) on a PAID org: zero-credit scheduled scan runs and advances the fixed-rate timer', { timeout: 60_000 }, async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const { orgId, tracker, promptDocs } = await seedWorld({
      prompts: 1, paid: true,
      promptOverrides: [{ lastScannedAt: eightDaysAgo }], // Weekly → due
    });
    happyVendors();
    const before = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, { force: false });

    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S8b' });
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id, status: 'ready' }), 1);

    // End-to-end fixed-rate advance (closes the Phase-2 wiring residual):
    // 8 days late on a Weekly prompt → exactly old + 7d, not "now".
    const promptAfter = await AiTrackerPrompt.findById(promptDocs[0]._id).lean();
    assert.equal(
      promptAfter.lastScannedAt.getTime(),
      eightDaysAgo.getTime() + 7 * 24 * 60 * 60 * 1000,
      'lastScannedAt advanced to the fixed-rate grid boundary',
    );
  });
});

describe('scenario 9 — recurring scans are paid-org-only', () => {
  it('FREE org: cron scan unschedules the tracker (nextScanAt=null), zero scan, zero billing', { timeout: 60_000 }, async () => {
    const seededLastScan = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const { orgId, tracker, promptDocs } = await seedWorld({
      prompts: 1, // no Subscription doc → tier 'free'
      promptOverrides: [{ lastScannedAt: seededLastScan }],
    });
    const before = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, { force: false });

    await ledger.assertConservation(before, orgId, { settled: 0, label: 'S9a' });
    assert.equal(vendorMock.calls.length, 0, 'no vendor spend for an unfunded recurring scan');
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.nextScanAt, null, 'tracker unscheduled');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0);
    const promptAfter = await AiTrackerPrompt.findById(promptDocs[0]._id).lean();
    assert.equal(
      promptAfter.lastScannedAt.getTime(),
      seededLastScan.getTime(),
      'prompt timer untouched — still exactly the seeded date',
    );
  });

  it('ORG-LESS legacy workspace: same unschedule, nothing billed to anyone', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld({
      prompts: 1, orgless: true, credits: 0,
      promptOverrides: [{ lastScannedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }],
    });

    await aiTrackerController.executeScan(tracker._id, null, { force: false });

    assert.equal(vendorMock.calls.length, 0);
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.nextScanAt, null);
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0);
  });
});
