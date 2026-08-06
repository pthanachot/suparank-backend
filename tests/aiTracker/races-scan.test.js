/**
 * Phase 5 — executeScan-level races (F04 §5.1 rows).
 *
 *  R1  atomic claim under 5-way contention → exactly one scan, one charge
 *  R2  manual + cron simultaneously → one winner, exactly one scan doc
 *  R3  delete monitor mid-scan → no crash; orphan/billing blast radius pinned
 *  R4  prompt frequency change mid-scan → B11 uses the SNAPSHOT frequency
 *  R5  recovery sweep false-positive on a live scan → self-heals (F4-22)
 *  R6  re-claim after mid-flight recovery → the DOCUMENTED double-scan
 *      corruption window: both scans complete, both bill (executable record)
 *
 * Mid-flight timing uses generous vendorMock delays (hundreds of ms apart)
 * — the 20-repeat gate validates they hold.
 *
 * Run: node --test tests/aiTracker/races-scan.test.js
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
const creditService = require('../../src/services/creditService');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

const { recoverStuckScans } = aiTrackerController.__test;

const DAY = 24 * 60 * 60 * 1000;
let wsCounter = 995000;

async function seedWorld({ prompts = 1, credits = 100, paid = false, promptOverrides = [] } = {}) {
  const orgId = new mongoose.Types.ObjectId();
  if (paid) await Subscription.create({ organizationId: orgId, planId: 'standard-monthly', status: 'active' });
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    name: `Races WS ${wsCounter}`,
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id,
    domain: 'suparank.com',
    name: `Races Monitor ${wsCounter}`,
    defaultModels: ['chatgpt'],
    scanStatus: 'pending',
  });
  const promptDocs = [];
  for (let i = 0; i < prompts; i++) {
    promptDocs.push(await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: `race prompt ${i} ${wsCounter}`,
      models: ['chatgpt'],
      frequency: 'Weekly',
      active: true,
      ...(promptOverrides[i] || {}),
    }));
  }
  await creditService.grantGeneralCredits(orgId.toString(), credits, 'phase5 seed');
  return { orgId: orgId.toString(), ws, tracker, promptDocs };
}

function happyVendors({ chatgptDelayMs = 0 } = {}) {
  vendorMock.script({
    chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), delayMs: chatgptDelayMs, repeat: true }],
    kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function forceScan(trackerId) {
  return aiTrackerController.executeScan(trackerId, null, {
    force: true, costAction: 'trackerRefreshAll', bill: true,
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

beforeEach(() => vendorMock.script({}));

describe('R1 — atomic claim under contention', () => {
  it('5 parallel executeScan on one tracker → exactly one scan doc, exactly one charge', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld();
    happyVendors();
    const beforeBal = await ledger.snapshot(orgId);

    await Promise.all([1, 2, 3, 4, 5].map(() => forceScan(tracker._id)));

    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 1, 'B1 claim admits exactly one');
    await ledger.assertConservation(beforeBal, orgId, { settled: 5, label: 'R1 (single charge)' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'R1');
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
  });
});

describe('R2 — manual trigger vs cron pick', () => {
  it('simultaneous force=true and force=false → one winner, one scan doc, billing matches the winner', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({
      paid: true,
      promptOverrides: [{ lastScannedAt: new Date(Date.now() - 8 * DAY) }], // due for cron too
    });
    happyVendors();
    const beforeBal = await ledger.snapshot(orgId);

    await Promise.all([
      forceScan(tracker._id),
      aiTrackerController.executeScan(tracker._id, null, { force: false }),
    ]);

    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 1, 'exactly one scan regardless of winner');
    const after = await creditService.getBalance(orgId);
    const moved = beforeBal.total - after.total;
    assert.ok([0, 5].includes(moved), `billing is 5 if manual won, 0 if cron won (moved ${moved})`);
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'R2');
    assert.equal((await AiTracker.findById(tracker._id).lean()).scanStatus, 'ready');
  });
});

describe('R3 — delete monitor mid-scan', () => {
  it('scan survives the deletion without crashing; blast radius: no orphan docs, but the settled charge stands (pinned)', { timeout: 60_000 }, async () => {
    const { orgId, ws, tracker } = await seedWorld();
    happyVendors({ chatgptDelayMs: 1200 });
    const beforeBal = await ledger.snapshot(orgId);

    const scanPromise = forceScan(tracker._id);
    await sleep(300); // scan doc created, vendor call in flight

    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await aiTrackerController.deleteMonitor(
      { workspace: ws, params: { monitorId: tracker._id.toString() } },
      res,
    );
    assert.equal(res.body?.success, true, 'delete succeeds while the scan is running');

    await scanPromise; // must not throw

    assert.equal(await AiTracker.countDocuments({ _id: tracker._id }), 0, 'tracker gone');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0, 'no orphan scan doc (B10 update on a deleted doc is a no-op)');
    assert.equal(await AiTrackerPrompt.countDocuments({ trackerId: tracker._id }), 0, 'no orphan prompts');
    // PINNED: the in-flight scan still settles 5 — the vendor work happened.
    // Documented blast radius: a user deleting mid-scan pays for that scan.
    await ledger.assertConservation(beforeBal, orgId, { settled: 5, label: 'R3 (charge stands)' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'R3');
  });
});

describe('R4 — prompt frequency change mid-scan', () => {
  it('B11 advances the timer with the SNAPSHOT frequency, not the concurrent update', { timeout: 60_000 }, async () => {
    const lastScan = new Date(Date.now() - 8 * DAY);
    const { tracker, promptDocs } = await seedWorld({ promptOverrides: [{ lastScannedAt: lastScan }] });
    happyVendors({ chatgptDelayMs: 1000 });

    const scanPromise = forceScan(tracker._id);
    await sleep(250); // prompts loaded (snapshot Weekly), vendor in flight
    await AiTrackerPrompt.findByIdAndUpdate(promptDocs[0]._id, { $set: { frequency: 'Monthly' } });
    await scanPromise;

    const promptAfter = await AiTrackerPrompt.findById(promptDocs[0]._id).lean();
    assert.equal(promptAfter.frequency, 'Monthly', 'the concurrent frequency write persisted');
    assert.equal(
      promptAfter.lastScannedAt.getTime(),
      lastScan.getTime() + 7 * DAY,
      'timer advanced on the WEEKLY (snapshot) grid — not the Monthly one. Small drift, no corruption.',
    );
  });
});

describe('R5 — recovery sweep false-positive on a live scan', () => {
  it('mid-flight recovery flips to failed, then the finishing scan self-heals to ready with scanError cleared (F4-22)', { timeout: 60_000 }, async () => {
    const { orgId, ws, tracker } = await seedWorld();
    happyVendors({ chatgptDelayMs: 2500 });
    const beforeBal = await ledger.snapshot(orgId);

    const scanPromise = forceScan(tracker._id);
    await sleep(500); // claimed + scan doc created; chatgpt still in flight

    await mongoose.connection.db.collection('aitrackers').updateOne(
      { _id: tracker._id },
      { $set: { updatedAt: new Date(Date.now() - 31 * 60 * 1000) } },
    );
    await recoverStuckScans(ws._id);

    const midFlight = await AiTracker.findById(tracker._id).lean();
    assert.equal(midFlight.scanStatus, 'failed', 'sweep wrongly recovered the live scan (observable window)');
    assert.equal(midFlight.scanError, 'Scan timed out and was automatically recovered');

    await scanPromise;

    const final = await AiTracker.findById(tracker._id).lean();
    assert.equal(final.scanStatus, 'ready', 'the finishing scan overwrites the false recovery');
    assert.equal(final.scanError, null, 'F4-22: bogus recovery error does not stick');
    assert.equal((await AiTrackerScan.findOne({ trackerId: tracker._id }).lean()).status, 'ready');
    await ledger.assertConservation(beforeBal, orgId, { settled: 5, label: 'R5' });
  });
});

describe('R6 — re-claim after mid-flight recovery (the documented corruption window)', () => {
  it('a second scan claims the falsely-recovered tracker: BOTH run, BOTH bill — executable record of the F04 §5.1 row', { timeout: 60_000 }, async () => {
    const { orgId, ws, tracker } = await seedWorld({ credits: 100 });
    happyVendors({ chatgptDelayMs: 2500 });
    const beforeBal = await ledger.snapshot(orgId);

    const scanA = forceScan(tracker._id);
    await sleep(500);
    await mongoose.connection.db.collection('aitrackers').updateOne(
      { _id: tracker._id },
      { $set: { updatedAt: new Date(Date.now() - 31 * 60 * 1000) } },
    );
    await recoverStuckScans(ws._id); // tracker now 'failed' while scan A is live

    const scanB = forceScan(tracker._id); // claims from 'failed' — the corruption window opens
    await Promise.all([scanA, scanB]);

    // Blast radius, pinned: two scan docs, double billing, tracker lands 'ready'
    // (whichever finished last). Per-doc writes serialize in Mongo — no crash,
    // no pending tx — but the user paid twice for one logical scan.
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 2, 'both invocations created scans');
    await ledger.assertConservation(beforeBal, orgId, { settled: 10, label: 'R6 (double charge — known gap)' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'R6');
    assert.equal((await AiTracker.findById(tracker._id).lean()).scanStatus, 'ready');
  });
});
