/**
 * Phase 9 — performance smoke + observability assertions.
 *
 * Two guards that only a full-stack run can give:
 *  1. F4-08 WRITE FAN-OUT: the progress callback fires per (platform ×
 *     prompt); each one is a Mongo round-trip on the tracker doc. At 50
 *     prompts that is 50 writes for a single-platform scan. This test COUNTS
 *     tracker writes and fails if the ratio regresses (e.g. someone adds a
 *     second write per step), and budgets wall-clock for a fully-mocked scan.
 *  2. OBSERVABILITY: the Phase-9 completion lines exist and carry the fields
 *     the alert conditions key on (durationMs, fallbackRate, credits) —
 *     docs/ai-tracker-observability.md is only actionable if these hold.
 *
 * Budgets are generous (CI machines vary); they catch order-of-magnitude
 * regressions, not micro-drift.
 *
 * Run: node --test tests/aiTracker/perf-smoke.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');

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
const aiTrackerController = require('../../src/controllers/aiTrackerController');

const PROMPT_COUNT = 50;
const WALL_CLOCK_BUDGET_MS = 45_000; // fully mocked; real vendors are minutes
const POLL_BUDGET_MS = 250;

let ws;
let tracker;

before(async () => {
  await db.connect();
  await db.clear();
  vendorMock.install();
  ws = await Workspace.create({
    workspaceNumber: 999001,
    userId: new mongoose.Types.ObjectId(),
    organizationId: null, // org-less → no billing noise in the timing
    name: 'Perf WS',
  });
  tracker = await AiTracker.create({
    workspaceId: ws._id, domain: 'perf.com', name: 'Perf Monitor',
    defaultModels: ['chatgpt'], scanStatus: 'pending',
  });
  for (let i = 0; i < PROMPT_COUNT; i++) {
    await AiTrackerPrompt.create({
      trackerId: tracker._id, prompt: `perf prompt ${i}`,
      models: ['chatgpt'], frequency: 'Weekly', active: true,
    });
  }
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

describe('perf smoke — 50-prompt mocked scan', () => {
  it('completes within budget, and progress writes stay ~1 per (prompt × platform)', { timeout: 120_000 }, async () => {
    vendorMock.script({
      chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
      kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
    });

    // Count tracker-doc writes carrying scanProgress (the F4-08 fan-out).
    let progressWrites = 0;
    const origUpdate = AiTracker.findByIdAndUpdate;
    AiTracker.findByIdAndUpdate = function (id, update, ...rest) {
      if (update?.$set?.scanProgress !== undefined && update.$set.scanStatus === undefined) progressWrites++;
      return origUpdate.call(this, id, update, ...rest);
    };

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };

    const t0 = Date.now();
    try {
      await aiTrackerController.executeScan(tracker._id, null, { force: true, bill: false });
    } finally {
      AiTracker.findByIdAndUpdate = origUpdate;
      console.log = origLog;
    }
    const elapsed = Date.now() - t0;

    assert.ok(
      elapsed < WALL_CLOCK_BUDGET_MS,
      `50-prompt mocked scan took ${elapsed}ms (budget ${WALL_CLOCK_BUDGET_MS}ms) — vendor mock or DB path regressed`,
    );

    // One write per (prompt × platform) is the CURRENT contract. Allow a
    // small margin for boundary writes; fail loudly on a doubling.
    assert.ok(
      progressWrites <= PROMPT_COUNT + 2,
      `progress writes = ${progressWrites} for ${PROMPT_COUNT} steps — F4-08 fan-out regressed (a 2nd write per step doubles Mongo load)`,
    );
    assert.ok(progressWrites >= PROMPT_COUNT - 2, `only ${progressWrites} progress writes — progress reporting may have broken`);

    // Observability contract (Phase 9).
    const complete = logs.find((l) => l.includes('[ai-tracker-scan] COMPLETE'));
    assert.ok(complete, 'executeScan must emit a COMPLETE line');
    for (const field of ['durationMs=', 'prompts=', 'platforms=', 'errors=', 'fallbackRate=', 'credits=']) {
      assert.ok(complete.includes(field), `COMPLETE line missing ${field}: ${complete}`);
    }
    const engineLine = logs.find((l) => l.includes('scan complete:'));
    assert.ok(engineLine && engineLine.includes('fallbackRate='), 'engine summary must carry fallbackRate');
    assert.ok(engineLine.includes('durationMs='), 'engine summary must carry durationMs');
  });

  it('scan-status poll stays fast with a scan in flight', { timeout: 60_000 }, async () => {
    await AiTracker.findByIdAndUpdate(tracker._id, {
      $set: { scanStatus: 'scanning', scanProgress: 42, platformStatuses: [{ platformId: 'chatgpt', status: 'scanning' }] },
    });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };

    const t0 = Date.now();
    await aiTrackerController.getScanStatus({ workspace: ws }, res);
    const elapsed = Date.now() - t0;

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.progress, 42);
    assert.ok(elapsed < POLL_BUDGET_MS, `poll took ${elapsed}ms (budget ${POLL_BUDGET_MS}ms) — the 4s-interval poll must stay cheap`);
  });
});
