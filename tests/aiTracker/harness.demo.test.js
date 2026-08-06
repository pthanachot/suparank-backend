/**
 * Phase 1 exit criterion — one demo test drives executeScan end-to-end,
 * fully offline: seed → atomic claim → mocked vendor scan (ChatGPT search
 * + Kimi analyzer) → results in Mongo → credits pre-deducted and settled.
 *
 * Proves all three harness assumptions at once:
 *   1. mongodb-memory-server REPLSET supports creditService's transactions.
 *   2. Stubbing globalThis.fetch intercepts every vendor call the scan
 *      engine makes (hermeticity: unmocked hosts throw).
 *   3. The real controller/engine/creditService stack runs green against
 *      seeded documents with no monkey-patching.
 *
 * Run: node --test tests/aiTracker/harness.demo.test.js
 * First run without MONGO_TEST_URI downloads a mongod binary (one-time).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');

const chatgptFixture = require('./fixtures/chatgpt-responses-clean.json');
const kimiFixture = require('./fixtures/kimi-analyzer-clean.json');

// Platform availability is read from env at scan time: expose ONLY chatgpt
// (+ the analyzer key) so the demo scans exactly one platform.
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

describe('harness demo — executeScan end-to-end, offline', () => {
  let orgId;
  let workspace;
  let tracker;
  let prompt;

  // Generous timeout: first-ever run downloads the mongod binary.
  before(async () => {
    await db.connect();
    await db.clear();
    vendorMock.install();

    orgId = new mongoose.Types.ObjectId();
    workspace = await Workspace.create({
      workspaceNumber: 990001,
      userId: new mongoose.Types.ObjectId(), // no User doc → scan email is skipped
      organizationId: orgId,
      name: 'Harness Demo WS',
    });
    tracker = await AiTracker.create({
      workspaceId: workspace._id,
      domain: 'suparank.com',
      name: 'Harness Demo Monitor',
      defaultModels: ['chatgpt'],
      scanStatus: 'pending',
    });
    prompt = await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: 'best seo tools 2026',
      models: ['chatgpt'],
      frequency: 'Weekly',
      active: true,
    });

    // 100 general credits — enough for the 1-prompt refresh-all (5 × 1 = 5).
    await creditService.grantGeneralCredits(orgId.toString(), 100, 'harness seed');
  }, { timeout: 300_000 });

  after(async () => {
    vendorMock.uninstall();
    await db.disconnect();
  });

  it('runs a full on-demand scan: claim → mocked vendors → results saved → credits settled', { timeout: 60_000 }, async () => {
    vendorMock.script({
      chatgpt: [vendorMock.jsonReply(chatgptFixture)],
      kimi: [vendorMock.jsonReply(kimiFixture)],
    });

    const balanceBefore = await creditService.getBalance(orgId.toString());
    assert.equal(balanceBefore.total, 100);

    await aiTrackerController.executeScan(tracker._id, null, {
      force: true,
      costAction: 'trackerRefreshAll',
      bill: true,
    });

    // ── Tracker terminal state ──
    const trackerAfter = await AiTracker.findById(tracker._id).lean();
    assert.equal(trackerAfter.scanStatus, 'ready');
    assert.equal(trackerAfter.scanProgress, 100);
    assert.equal(trackerAfter.currentScanId, null);
    assert.ok(trackerAfter.lastScanAt instanceof Date);
    assert.ok(trackerAfter.nextScanAt instanceof Date);
    assert.ok(trackerAfter.nextScanAt > trackerAfter.lastScanAt, 'nextScanAt scheduled in the future');
    assert.deepEqual(
      trackerAfter.platformStatuses.map((p) => ({ platformId: p.platformId, status: p.status })),
      [{ platformId: 'chatgpt', status: 'completed' }],
    );

    // ── Scan doc: only B10 flips status to ready; results carry the analysis ──
    const scans = await AiTrackerScan.find({ trackerId: tracker._id }).lean();
    assert.equal(scans.length, 1);
    const scan = scans[0];
    assert.equal(scan.status, 'ready');
    assert.ok(scan.completedAt instanceof Date);
    assert.equal(scan.results.length, 1);
    assert.equal(scan.results[0].prompt, 'best seo tools 2026');

    const platformResult = scan.results[0].platforms.find((p) => p.platformId === 'chatgpt');
    assert.ok(platformResult, 'chatgpt platform result present');
    assert.equal(platformResult.error, false);
    assert.equal(platformResult.mentioned, true, 'SupaRank extracted as mentioned');
    assert.equal(platformResult.cited, true, 'suparank.com present in citedUrls (strict hostname match)');
    assert.ok(platformResult.citedUrls.includes('https://suparank.com/features'));
    const target = platformResult.brandRanking.find((b) => b.isTargetBrand);
    assert.ok(target, 'target brand present in brandRanking');
    assert.equal(target.brandName.toLowerCase(), 'suparank');
    assert.equal(platformResult.sentiment, 'positive');

    // ── Per-prompt fixed-rate timer advanced ──
    const promptAfter = await AiTrackerPrompt.findById(prompt._id).lean();
    assert.ok(promptAfter.lastScannedAt instanceof Date, 'lastScannedAt stamped');

    // ── Money: preDeduct 5 × 1 prompt, settled at 5 → 95 remaining.
    //    Ledger conservation: balance moved by exactly the settled amount. ──
    const balanceAfter = await creditService.getBalance(orgId.toString());
    assert.equal(balanceAfter.total, 95, 'exactly 5 credits settled for 1 prompt × trackerRefreshAll');

    // ── Hermeticity: exactly one search + one analyzer call, nothing else ──
    const byVendor = vendorMock.calls.reduce((acc, c) => {
      acc[c.vendor] = (acc[c.vendor] || 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(byVendor, { chatgpt: 1, kimi: 1 });
  });
});
