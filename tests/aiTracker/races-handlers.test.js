/**
 * Phase 5 — handler-level races (F04 §5.1 rows through the real handlers).
 *
 *  R7  workspace concurrent-scan cap under 3-way trigger (F4-04 —
 *      executable record: the check-then-act window may admit all 3)
 *  R8  concurrent same-name createMonitor — both legitimate outcomes
 *      accepted (E11000→409 or suffix→two 201s), quota exact either way
 *      (F4-05 fixed: rollback on the 409 loser)
 *  R9  insertMany non-11000 failure → orphan tracker cleaned up, quota
 *      rolled back (F1-05/F1-06 under test)
 *
 * Run: node --test tests/aiTracker/races-handlers.test.js
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
const TierConfig = require('../../src/models/TierConfig');
const UsageTracker = require('../../src/models/UsageTracker');
const creditService = require('../../src/services/creditService');
const tierService = require('../../src/services/tierService');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

let wsCounter = 996000;

function makeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

function happyVendors() {
  vendorMock.script({
    chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
    kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until no tracker in the workspace is pending/scanning (background
 *  fire-and-forget scans must finish before the test ends). */
async function awaitQuiescent(workspaceId, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const active = await AiTracker.countDocuments({
      workspaceId, scanStatus: { $in: ['pending', 'scanning'] },
    });
    if (active === 0) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('workspace never went quiescent');
    await sleep(100);
  }
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
  tierService.clearTierCache(); // PRIMITIVES §8 — 5-min TTL poisons seeded configs
});

describe('R7 — workspace concurrent-scan cap under 3-way trigger (F4-04)', () => {
  it('3 simultaneous triggerMonitorScan on 3 trackers: cap admits 2 by contract, may admit 3 in the race window — pinned either way', { timeout: 60_000 }, async () => {
    const orgId = new mongoose.Types.ObjectId();
    const ws = await Workspace.create({
      workspaceNumber: wsCounter++,
      userId: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: `Cap WS ${wsCounter}`,
    });
    const trackers = [];
    for (let i = 0; i < 3; i++) {
      const t = await AiTracker.create({
        workspaceId: ws._id, domain: `cap${i}.com`, name: `Cap ${i} ${wsCounter}`,
        defaultModels: ['chatgpt'], scanStatus: 'ready',
      });
      await AiTrackerPrompt.create({
        trackerId: t._id, prompt: `cap prompt ${i} ${wsCounter}`, models: ['chatgpt'], frequency: 'Weekly', active: true,
      });
      trackers.push(t);
    }
    await creditService.grantGeneralCredits(orgId.toString(), 200, 'cap seed');
    happyVendors();
    const beforeBal = await ledger.snapshot(orgId.toString());

    const responses = await Promise.all(trackers.map((t) => {
      const res = makeRes();
      return aiTrackerController
        .triggerMonitorScan({ workspace: ws, params: { monitorId: t._id.toString() } }, res)
        .then(() => res);
    }));

    const accepted = responses.filter((r) => r.body?.scanStatus === 'pending').length;
    const rejected = responses.filter((r) => r.statusCode === 429).length;
    assert.equal(accepted + rejected, 3, 'every trigger got a definitive answer');
    // Contract says at most 2; the F4-04 check-then-act window can admit 3.
    // Executable record: BOTH outcomes are legal today. If the atomic-counter
    // fix lands, tighten this to `accepted <= 2`.
    assert.ok(accepted >= 2 && accepted <= 3, `accepted=${accepted} (3 = F4-04 manifesting)`);
    console.log(`[R7] cap race outcome: accepted=${accepted} rejected=${rejected}${accepted === 3 ? ' — F4-04 window hit' : ''}`);

    await awaitQuiescent(ws._id);

    // Per-tracker atomicity is the hard invariant: never two scans for one
    // tracker, no matter how the cap race resolved.
    let scanDocs = 0;
    let readyScans = 0;
    const statuses = [];
    for (const t of trackers) {
      const docs = await AiTrackerScan.find({ trackerId: t._id }).lean();
      assert.ok(docs.length <= 1, 'never more than one scan per tracker');
      scanDocs += docs.length;
      readyScans += docs.filter((d) => d.status === 'ready').length;
      statuses.push(`${(await AiTracker.findById(t._id).lean()).scanStatus}/${docs[0]?.status ?? 'none'}`);
    }
    // A scan can legitimately fail BEFORE creating its doc (Phase H) — an
    // earlier `scanDocs === accepted` assertion flaked ~1-in-12 on exactly
    // that. The truthful invariants: work never exceeds what was admitted,
    // and BILLING FOLLOWS WORK ACTUALLY DONE, not what was admitted.
    assert.ok(
      scanDocs <= accepted && scanDocs >= 1,
      `scans(${scanDocs}) must be ≥1 and ≤ accepted(${accepted}); tracker/scan states: ${statuses.join(', ')}`,
    );
    await ledger.assertConservation(beforeBal, orgId.toString(), {
      settled: 5 * readyScans,
      label: `R7 (billed for ${readyScans} completed scan(s); ${statuses.join(', ')})`,
    });
    await ledger.assertNoPendingTx({ organizationId: orgId.toString() }, 'R7');
  });
});

describe('R8 — concurrent same-name createMonitor', () => {
  it('org-less: both legitimate outcomes accepted; monitors created = 201 count', { timeout: 60_000 }, async () => {
    const ws = await Workspace.create({
      workspaceNumber: wsCounter++,
      userId: new mongoose.Types.ObjectId(),
      organizationId: null, // org-less → no quota, no billing
      name: `Dup WS ${wsCounter}`,
    });
    happyVendors(); // fire-and-forget first scans need vendors

    const make = () => {
      const res = makeRes();
      return aiTrackerController.createMonitor({
        workspace: ws,
        user: {},
        body: { domain: 'suparank.com', name: 'Duplicate Race', prompts: ['best seo tools'] },
      }, res).then(() => res);
    };
    const [a, b] = await Promise.all([make(), make()]);

    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    const createdCount = codes.filter((c) => c === 201).length;
    assert.ok(
      (codes[0] === 201 && codes[1] === 409) || (codes[0] === 201 && codes[1] === 201),
      `legal outcomes are 201+409 (E11000 race) or 201+201 (suffix path); got ${codes}`,
    );
    console.log(`[R8] same-name outcome: ${codes.join('+')}`);

    const monitors = await AiTracker.find({ workspaceId: ws._id }).lean();
    assert.equal(monitors.length, createdCount, 'monitor count matches successful creates');
    assert.equal(new Set(monitors.map((m) => m.name)).size, monitors.length, 'names are distinct');

    await awaitQuiescent(ws._id);
  });

  it('with a prompt quota: usage equals 201-count × prompts — the 409 loser rolls back (F4-05 fixed, under concurrency)', { timeout: 60_000 }, async () => {
    await TierConfig.create({
      tier: 'free', displayName: 'Free',
      maxAiTrackerPromptsPerMonth: 100, aiTrackerPromptLimitType: 'monthly',
    });
    const orgId = new mongoose.Types.ObjectId();
    const ws = await Workspace.create({
      workspaceNumber: wsCounter++,
      userId: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: `Quota WS ${wsCounter}`,
    });
    await creditService.grantGeneralCredits(orgId.toString(), 100, 'quota seed');
    happyVendors();

    const make = () => {
      const res = makeRes();
      return aiTrackerController.createMonitor({
        workspace: ws,
        user: {},
        body: { domain: 'suparank.com', name: 'Quota Race', prompts: ['p one', 'p two', 'p three'] },
      }, res).then(() => res);
    };
    const [a, b] = await Promise.all([make(), make()]);
    const createdCount = [a, b].filter((r) => r.statusCode === 201).length;
    assert.ok(createdCount >= 1, 'at least one create succeeded');

    await awaitQuiescent(ws._id);

    const period = tierService.getPeriod('monthly');
    const usage = await UsageTracker.findOne({ organizationId: orgId, period }).lean();
    assert.equal(
      usage?.aiTrackerPromptsCreated ?? 0,
      3 * createdCount,
      'quota reflects ONLY successful creates — the 409 loser rolled back (F4-05)',
    );
  });
});

describe('R9 — insertMany failure cleanup', () => {
  it('non-11000 insertMany error → 500, orphan tracker deleted, quota rolled back to zero', { timeout: 60_000 }, async () => {
    await TierConfig.create({
      tier: 'free', displayName: 'Free',
      maxAiTrackerPromptsPerMonth: 100, aiTrackerPromptLimitType: 'monthly',
    });
    const orgId = new mongoose.Types.ObjectId();
    const ws = await Workspace.create({
      workspaceNumber: wsCounter++,
      userId: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      name: `Rollback WS ${wsCounter}`,
    });

    const origInsertMany = AiTrackerPrompt.insertMany;
    AiTrackerPrompt.insertMany = async () => { throw new Error('injected insertMany outage'); };
    const res = makeRes();
    try {
      await aiTrackerController.createMonitor({
        workspace: ws,
        user: {},
        body: { domain: 'suparank.com', name: 'Rollback Case', prompts: ['p one', 'p two'] },
      }, res);
    } finally {
      AiTrackerPrompt.insertMany = origInsertMany;
    }

    assert.equal(res.statusCode, 500);
    assert.equal(await AiTracker.countDocuments({ workspaceId: ws._id }), 0, 'orphan tracker cleaned up (F1-05)');
    const period = tierService.getPeriod('monthly');
    const usage = await UsageTracker.findOne({ organizationId: orgId, period }).lean();
    assert.equal(usage?.aiTrackerPromptsCreated ?? 0, 0, 'quota fully rolled back (F1-06)');
  });
});
