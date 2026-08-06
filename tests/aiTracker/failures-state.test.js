/**
 * Phase 4 — engine-level state rows: empty-platform bail (F4-06), the
 * per-tier engine clamp, cron skip-no-due, force-vs-non-force timers,
 * stale-scanError clearing (F4-22), stuck-scan recovery, the poll read
 * shape, and the zero-overlap billing pin.
 *
 * Run: node --test tests/aiTracker/failures-state.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');
const ledger = require('./helpers/ledger');

const chatgptFixture = require('./fixtures/chatgpt-responses-clean.json');
const kimiFixture = require('./fixtures/kimi-analyzer-clean.json');
const perplexityFixture = require('./fixtures/perplexity-clean.json');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.PERPLEXITY_API_KEY = 'test-key';
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../../src/models/AiTrackerScan');
const TierConfig = require('../../src/models/TierConfig');
const Subscription = require('../../src/models/Subscription');
const creditService = require('../../src/services/creditService');
const tierService = require('../../src/services/tierService');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

const { recoverStuckScans } = aiTrackerController.__test;

const DAY = 24 * 60 * 60 * 1000;
let wsCounter = 993000;

async function seedWorld({ prompts = 1, credits = 100, paid = false, defaultModels = ['chatgpt'], promptModels = null, promptOverrides = [] } = {}) {
  const orgId = new mongoose.Types.ObjectId();
  if (paid) await Subscription.create({ organizationId: orgId, planId: 'standard-monthly', status: 'active' });
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    name: `State WS ${wsCounter}`,
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id,
    domain: 'suparank.com',
    name: `State Monitor ${wsCounter}`,
    defaultModels,
    scanStatus: 'pending',
  });
  const promptDocs = [];
  for (let i = 0; i < prompts; i++) {
    promptDocs.push(await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: `state scenario prompt ${i} ${wsCounter}`,
      models: promptModels || defaultModels,
      frequency: 'Weekly',
      active: true,
      ...(promptOverrides[i] || {}),
    }));
  }
  if (credits > 0) await creditService.grantGeneralCredits(orgId.toString(), credits, 'phase4 seed');
  return { orgId: orgId.toString(), ws, tracker, promptDocs };
}

function happyVendors() {
  vendorMock.script({
    chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
    perplexity: [{ ...vendorMock.jsonReply(perplexityFixture), repeat: true }],
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

beforeEach(async () => {
  vendorMock.script({});
  await TierConfig.deleteMany({});
  // The tier/TierConfig caches have a 5-min TTL (PRIMITIVES §8) — without
  // clearing, one test's null-config lookup poisons the next test's seeded
  // TierConfig. Exactly the "don't trust 'fixed' until the cache window
  // matches" trap the docs warn about.
  tierService.clearTierCache();
});

describe('F4-06 — empty defaultModels bails without side effects', () => {
  it('no scan doc, no timer advance, no billing, reselection error set', { timeout: 60_000 }, async () => {
    const { orgId, tracker, promptDocs } = await seedWorld({ defaultModels: [], promptModels: ['chatgpt'] });
    const beforeBal = await ledger.snapshot(orgId);
    const t0 = Date.now();

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.scanError, 'No platforms enabled');
    assert.ok(trackerAfter.nextScanAt.getTime() > t0 + 12 * 60 * 60 * 1000, 'retry ~1 day out');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0, 'NO scan doc');
    assert.equal((await AiTrackerPrompt.findById(promptDocs[0]._id).lean()).lastScannedAt ?? null, null, 'timer untouched');
    assert.equal(vendorMock.calls.length, 0);
    await ledger.assertConservation(beforeBal, orgId, { settled: 0, label: 'F4-06' });
  });
});

describe('per-tier engine clamp at scan time', () => {
  it('CONTROL (no cap configured): perplexity runs alongside chatgpt', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld({
      defaultModels: ['chatgpt', 'claude', 'perplexity'],
      promptModels: ['chatgpt', 'claude', 'perplexity'],
    });
    happyVendors();

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    assert.ok(vendorMock.calls.some((c) => c.vendor === 'perplexity'), 'uncapped: perplexity was queried');
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.deepEqual(
      trackerAfter.platformStatuses.map((p) => p.platformId).sort(),
      ['chatgpt', 'perplexity'],
      'claude silently dropped (no key) but NOT reported completed — F4-10 contract',
    );
  });

  it('free-tier cap 2 clamps [chatgpt,claude,perplexity] → [chatgpt,claude]: perplexity is NEVER queried', { timeout: 60_000 }, async () => {
    await TierConfig.create({ tier: 'free', displayName: 'Free', maxAiTrackerPlatforms: 2 });
    const { tracker } = await seedWorld({
      defaultModels: ['chatgpt', 'claude', 'perplexity'], // over-provisioned pre-downgrade
      promptModels: ['chatgpt', 'claude', 'perplexity'],
    });
    happyVendors();

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    assert.equal(vendorMock.calls.filter((c) => c.vendor === 'perplexity').length, 0, 'clamped engine must not be queried');
    assert.ok(vendorMock.calls.some((c) => c.vendor === 'chatgpt'));
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.deepEqual(trackerAfter.platformStatuses.map((p) => p.platformId), ['chatgpt'], 'only the keyed survivor of the clamp ran');
  });
});

describe('scheduling rows', () => {
  it('cron skip-no-due: no scan doc, nextScanAt = exact next due boundary', { timeout: 60_000 }, async () => {
    const lastScan = new Date(Date.now() - 1 * DAY); // Weekly → not due
    const { orgId, tracker } = await seedWorld({ paid: true, promptOverrides: [{ lastScannedAt: lastScan }] });
    const beforeBal = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, { force: false });

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.scanProgress, 0);
    assert.equal(trackerAfter.nextScanAt.getTime(), lastScan.getTime() + 7 * DAY, 'precise next-due, no drift');
    assert.equal(await AiTrackerScan.countDocuments({ trackerId: tracker._id }), 0);
    assert.equal(vendorMock.calls.length, 0);
    await ledger.assertConservation(beforeBal, orgId, { settled: 0, label: 'skip-no-due' });
  });

  it('force=true scans due AND not-due prompts, but advances only the due timer (F4 §12.4 end-to-end)', { timeout: 60_000 }, async () => {
    const dueDate = new Date(Date.now() - 8 * DAY);
    const freshDate = new Date(Date.now() - 1 * DAY);
    const { tracker, promptDocs } = await seedWorld({
      prompts: 2,
      promptOverrides: [{ lastScannedAt: dueDate }, { lastScannedAt: freshDate }],
    });
    happyVendors();

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.equal(scan.results.length, 2, 'force scans BOTH prompts');

    const dueAfter = await AiTrackerPrompt.findById(promptDocs[0]._id).lean();
    const freshAfter = await AiTrackerPrompt.findById(promptDocs[1]._id).lean();
    assert.equal(dueAfter.lastScannedAt.getTime(), dueDate.getTime() + 7 * DAY, 'due prompt advanced on the fixed-rate grid');
    assert.equal(freshAfter.lastScannedAt.getTime(), freshDate.getTime(), 'not-due prompt keeps its cooldown timer');
  });

  it('F4-22 — a stale scanError is cleared by the next successful scan', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld();
    await AiTracker.findByIdAndUpdate(tracker._id, { $set: { scanError: 'Scan timed out (recovered by cron)' } });
    happyVendors();

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.scanError, null, 'bogus recovery error does not survive a success');
  });

  it('zero-overlap prompt (models ⊄ engines) under refresh-all: scans nothing, keeps timer — but still bills 5 (pinned)', { timeout: 60_000 }, async () => {
    const { orgId, tracker, promptDocs } = await seedWorld({ promptModels: ['gemini'] }); // gemini has no key
    const beforeBal = await ledger.snapshot(orgId);

    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });

    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.equal(scan.results[0].platforms.length, 0, 'no platform ran for the prompt');
    assert.equal((await AiTrackerPrompt.findById(promptDocs[0]._id).lean()).lastScannedAt ?? null, null, 'F4-19: timer preserved');
    assert.equal(vendorMock.calls.length, 0);
    // PRODUCT PIN: refresh-all settles 5 × prompts SCANNED-OR-NOT (only the
    // single-refresh path refunds no-work prompts). Flagged in the plan as a
    // billing-fairness observation; this assertion is the tripwire if the
    // policy is ever changed.
    await ledger.assertConservation(beforeBal, orgId, { settled: 5, label: 'zero-overlap billing pin' });
  });
});

describe('recovery + poll rows', () => {
  it('recoverStuckScans flips ONLY aged scanning/pending trackers in the workspace; scan doc stays running (residual F4-07 variant)', { timeout: 60_000 }, async () => {
    const { ws, tracker } = await seedWorld();
    // A second, FRESH scanning tracker in the same workspace must survive.
    const freshTracker = await AiTracker.create({
      workspaceId: ws._id, domain: 'fresh.com', name: `Fresh ${wsCounter}`,
      defaultModels: ['chatgpt'], scanStatus: 'scanning',
    });
    const orphanScan = await AiTrackerScan.create({ trackerId: tracker._id, startedAt: new Date() });
    await AiTracker.findByIdAndUpdate(tracker._id, { $set: { scanStatus: 'scanning', currentScanId: orphanScan._id } });
    // An aged scanning tracker in a DIFFERENT workspace must also survive —
    // the sweep is workspace-scoped by contract.
    const { ws: otherWs, tracker: otherTracker } = await seedWorld({ credits: 0 });
    await AiTracker.findByIdAndUpdate(otherTracker._id, { $set: { scanStatus: 'scanning' } });
    // Age the stuck ones below the 30-min line (updatedAt is timestamp-managed → driver level).
    await mongoose.connection.db.collection('aitrackers').updateMany(
      { _id: { $in: [tracker._id, otherTracker._id] } },
      { $set: { updatedAt: new Date(Date.now() - 31 * 60 * 1000) } },
    );

    await recoverStuckScans(ws._id);

    const stuck = await AiTracker.findById(tracker._id).lean();
    assert.equal(stuck.scanStatus, 'failed');
    assert.equal(stuck.scanError, 'Scan timed out and was automatically recovered');
    assert.equal((await AiTracker.findById(freshTracker._id).lean()).scanStatus, 'scanning', 'fresh scan untouched');
    assert.equal(
      (await AiTracker.findById(otherTracker._id).lean()).scanStatus,
      'scanning',
      'aged tracker in ANOTHER workspace untouched — sweep is workspace-scoped',
    );
    assert.ok(otherWs._id.toString() !== ws._id.toString());
    // RESIDUAL (documented): recovery flips the tracker but leaves the scan
    // doc in 'running' — invisible to dashboards (status filter) but never
    // terminal. Pinned here so a future cleanup changes this test knowingly.
    assert.equal((await AiTrackerScan.findById(orphanScan._id).lean()).status, 'running');
  });

  it('poll read path returns the coherent mid-scan shape', async () => {
    const { ws, tracker } = await seedWorld();
    await AiTracker.findByIdAndUpdate(tracker._id, {
      $set: {
        scanStatus: 'scanning', scanProgress: 40,
        platformStatuses: [{ platformId: 'chatgpt', status: 'scanning' }],
      },
    });

    const res = { body: null, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await aiTrackerController.getScanStatus({ workspace: ws }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'scanning');
    assert.equal(res.body.progress, 40);
    assert.deepEqual(res.body.platformStatuses.map((p) => p.platformId), ['chatgpt']);
    assert.ok(Array.isArray(res.body.availablePlatformIds));
    assert.equal(res.body.error, undefined, 'no error field without a scanError');
  });
});
