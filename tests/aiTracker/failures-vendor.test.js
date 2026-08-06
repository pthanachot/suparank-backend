/**
 * Phase 4 — vendor failure matrix (search + analyzer rows).
 *
 * Every vendor failure must degrade EXACTLY as designed: the ChatGPT
 * two-API ladder, retry exhaustion → error:true isolation, empty-answer
 * throws, analyzer 429 retry-after honoring, analyzer 5xx retry →
 * fallback with the answer PRESERVED (F2-08) and the fallback logged
 * (F3-13), and Claude's 429 retry-after floor. Ledger conservation is
 * asserted wherever billing runs.
 *
 * Real timers — retry backoffs make this the slowest suite (~30 s total,
 * budgeted per test). Run: node --test tests/aiTracker/failures-vendor.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');
const ledger = require('./helpers/ledger');

const chatgptFixture = require('./fixtures/chatgpt-responses-clean.json');
const kimiFixture = require('./fixtures/kimi-analyzer-clean.json');
const claudeFixture = require('./fixtures/claude-messages-clean.json');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.GEMINI_API_KEY;
delete process.env.PERPLEXITY_API_KEY;

const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../../src/models/AiTrackerScan');
const creditService = require('../../src/services/creditService');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

// ChatGPT Chat Completions success (the ladder's second rung).
const completionsFixture = {
  choices: [{
    message: {
      content: 'SupaRank leads AI-era SEO [suparank.com](https://suparank.com/features).',
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://suparank.com/features' } }],
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 40 },
};

const emptyResponses = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] }], usage: {} };
const emptyCompletions = { choices: [{ message: { content: '' } }], usage: {} };

let wsCounter = 992000;

async function seedWorld({ prompts = 1, credits = 100, defaultModels = ['chatgpt'], promptOverrides = [] } = {}) {
  const orgId = new mongoose.Types.ObjectId();
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    name: `Failures WS ${wsCounter}`,
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id,
    domain: 'suparank.com',
    name: `Failures Monitor ${wsCounter}`,
    defaultModels,
    scanStatus: 'pending',
  });
  const promptDocs = [];
  for (let i = 0; i < prompts; i++) {
    promptDocs.push(await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: `failure scenario prompt ${i} ${wsCounter}`,
      models: defaultModels,
      frequency: 'Weekly',
      active: true,
      ...(promptOverrides[i] || {}),
    }));
  }
  await creditService.grantGeneralCredits(orgId.toString(), credits, 'phase4 seed');
  return { orgId: orgId.toString(), ws, tracker, promptDocs };
}

async function runForceScan(tracker) {
  return aiTrackerController.executeScan(tracker._id, null, {
    force: true, costAction: 'trackerRefreshAll', bill: true,
  });
}

async function latestScan(trackerId) {
  return AiTrackerScan.findOne({ trackerId }).sort({ startedAt: -1 }).lean();
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

describe('ChatGPT two-API ladder', () => {
  it('Responses API 500 → Chat Completions fallback succeeds in the SAME attempt (no error flag)', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld();
    vendorMock.script({
      chatgpt: [{ status: 500, text: 'responses down' }, vendorMock.jsonReply(completionsFixture)],
      kimi: [vendorMock.jsonReply(kimiFixture)],
    });
    const beforeBal = await ledger.snapshot(orgId);

    await runForceScan(tracker);

    const scan = await latestScan(tracker._id);
    const p = scan.results[0].platforms.find((x) => x.platformId === 'chatgpt');
    assert.equal(p.error, false, 'fallback rung rescued the pair');
    assert.equal(p.mentioned, true);
    assert.equal(vendorMock.calls.filter((c) => c.vendor === 'chatgpt').length, 2, 'responses + completions');
    await ledger.assertConservation(beforeBal, orgId, { settled: 5, label: 'ladder' });
  });

  it('BOTH APIs fail across all retries → error:true, while the next prompt succeeds untouched (per-prompt isolation)', { timeout: 60_000 }, async () => {
    const { orgId, tracker } = await seedWorld({ prompts: 2 });
    vendorMock.script({
      // Prompt 1: 3 withRetry attempts × (responses+completions) = 6 failures —
      // mixed HTTP-status and NETWORK-level errors so both throw paths of the
      // ladder are exercised. Prompt 2: responses succeeds first try.
      chatgpt: [
        { status: 502, text: 'down' }, { status: 502, text: 'down' },
        { error: new Error('ECONNRESET (injected)') }, { error: new Error('socket hang up (injected)') },
        { status: 502, text: 'down' }, { status: 502, text: 'down' },
        vendorMock.jsonReply(chatgptFixture),
      ],
      kimi: [vendorMock.jsonReply(kimiFixture)],
    });
    const beforeBal = await ledger.snapshot(orgId);

    await runForceScan(tracker);

    const scan = await latestScan(tracker._id);
    assert.equal(scan.status, 'ready', 'scan still completes');
    // Identify results by prompt TEXT — Mongo natural order is not a contract,
    // so positional [r1, r2] destructuring would be a latent flake.
    const r1 = scan.results.find((r) => r.prompt.includes('prompt 0'));
    const r2 = scan.results.find((r) => r.prompt.includes('prompt 1'));
    const p1 = r1.platforms.find((x) => x.platformId === 'chatgpt');
    const p2 = r2.platforms.find((x) => x.platformId === 'chatgpt');
    assert.equal(p1.error, true, 'exhausted prompt marked errored');
    assert.equal(p1.aiResponse, '', 'no answer to preserve — search itself failed');
    assert.equal(p2.error, false, 'second prompt unaffected');
    assert.equal(p2.mentioned, true);
    // Billing pin (product observation): refresh-all settles 5 × prompts
    // scanned, INCLUDING the errored prompt. The user pays for a failed pair.
    await ledger.assertConservation(beforeBal, orgId, { settled: 10, label: 'isolation' });
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'isolation');
  });

  it('empty answers from both APIs exhaust retries → error:true (empty is a failure, not a result)', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld();
    vendorMock.script({
      chatgpt: [
        vendorMock.jsonReply(emptyResponses), vendorMock.jsonReply(emptyCompletions),
        vendorMock.jsonReply(emptyResponses), vendorMock.jsonReply(emptyCompletions),
        vendorMock.jsonReply(emptyResponses), vendorMock.jsonReply(emptyCompletions),
      ],
    });

    await runForceScan(tracker);

    const scan = await latestScan(tracker._id);
    const p = scan.results[0].platforms.find((x) => x.platformId === 'chatgpt');
    assert.equal(p.error, true);
    assert.equal(vendorMock.calls.filter((c) => c.vendor === 'kimi').length, 0, 'analyzer never invoked without an answer');
  });
});

describe('analyzer (Kimi/OpenRouter) failure rows', () => {
  it('429 honors retry-after and succeeds on the retry', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld();
    vendorMock.script({
      chatgpt: [vendorMock.jsonReply(chatgptFixture)],
      kimi: [
        { status: 429, text: 'slow down', headers: { 'retry-after': '1' } },
        vendorMock.jsonReply(kimiFixture),
      ],
    });
    const t0 = Date.now();

    await runForceScan(tracker);

    const scan = await latestScan(tracker._id);
    const p = scan.results[0].platforms.find((x) => x.platformId === 'chatgpt');
    assert.equal(p.error, false);
    assert.equal(p.mentioned, true, 'full analysis after the retry');
    assert.ok(p.position != null, 'not the fallback path');
    assert.equal(vendorMock.calls.filter((c) => c.vendor === 'kimi').length, 2);
    assert.ok(Date.now() - t0 >= 2000, 'the 2s backoff floor (max(retry-after, 2^n·2s)) was awaited');
  });

  it('persistent 5xx → retries then FALLBACK: answer preserved (F2-08), position null, fallback logged (F3-13)', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld();
    vendorMock.script({
      chatgpt: [vendorMock.jsonReply(chatgptFixture)],
      kimi: [{ status: 503, text: 'openrouter down', repeat: true }],
    });
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); origWarn(...a); };
    try {
      await runForceScan(tracker);
    } finally {
      console.warn = origWarn;
    }

    const scan = await latestScan(tracker._id);
    const p = scan.results[0].platforms.find((x) => x.platformId === 'chatgpt');
    assert.equal(p.error, false, 'analyzer failure is NOT a platform error');
    assert.ok(p.aiResponse.length > 0, 'F2-08: the paid-for answer is preserved');
    assert.equal(p.position, null, 'F3-02: fallback never fabricates a rank');
    assert.equal(p.sentiment, null);
    assert.equal(p.mentioned, true, 'regex fallback still detects the brand');
    assert.ok(
      warns.some((w) => w.includes('fallback')),
      'F3-13: the fallback path announces itself in the logs',
    );
  });
});

describe('Claude search failure rows', () => {
  it('429 honors the retry-after header (not just the 5s floor) and recovers on retry', { timeout: 60_000 }, async () => {
    const { tracker } = await seedWorld({ defaultModels: ['claude'], promptOverrides: [{ models: ['claude'] }] });
    vendorMock.script({
      claude: [
        { status: 429, text: 'rate limited', headers: { 'retry-after': '6' } },
        vendorMock.jsonReply(claudeFixture),
      ],
      kimi: [vendorMock.jsonReply(kimiFixture)],
    });
    const t0 = Date.now();

    await runForceScan(tracker);

    const elapsed = Date.now() - t0;
    const scan = await latestScan(tracker._id);
    const p = scan.results[0].platforms.find((x) => x.platformId === 'claude');
    assert.equal(p.error, false, 'recovered after the rate-limit wait');
    assert.equal(p.mentioned, true);
    assert.ok(p.citedUrls.includes('https://suparank.com/features'), 'structured block citations parsed');
    assert.equal(vendorMock.calls.filter((c) => c.vendor === 'claude').length, 2);
    assert.ok(elapsed >= 6000, `retry-after: 6 must beat the 5s floor (waited ${elapsed}ms)`);
  });
});
