/**
 * Phase 9 review addition (F5) — prove `fallbackRate` can actually be non-zero.
 *
 * `fallbackRate` is the #1 alert condition in docs/ai-tracker-observability.md
 * (">5% sustained"), and it is the in-product signal for the P9-01 incident:
 * a dead OpenRouter key silently degraded the Kimi analyzer to regex, so scans
 * kept "succeeding" while producing worthless brand data.
 *
 * The only existing coverage asserted the SUBSTRING `fallbackRate=` appears in
 * the log line. That passes just as well when the counter is hard-wired to
 * zero. If someone drops the `fallback: true` marker from the analyzer result,
 * the rate reads 0% forever, the alert never fires, and the whole suite stays
 * green — P9-01 recurring with the detector itself broken.
 *
 * This drives a real scan with the analyzer DOWN and asserts the rate reflects
 * it. Both directions are pinned so the assertion cannot pass vacuously.
 *
 * Run: node --test tests/aiTracker/observability-fallback.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
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

const PROMPT_COUNT = 4;
let ws;

/** Run a scan with the given vendor script and return the captured log lines. */
async function scanCapturingLogs(script) {
  const tracker = await AiTracker.create({
    workspaceId: ws._id, domain: 'fallback.com', name: 'Fallback Monitor',
    defaultModels: ['chatgpt'], scanStatus: 'pending',
  });
  for (let i = 0; i < PROMPT_COUNT; i++) {
    await AiTrackerPrompt.create({
      trackerId: tracker._id, prompt: `fallback prompt ${i}`,
      models: ['chatgpt'], frequency: 'Weekly', active: true,
    });
  }
  vendorMock.script(script);

  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.error = () => {};
  console.warn = () => {};
  try {
    await aiTrackerController.executeScan(tracker._id, null, { force: true, bill: false });
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return logs;
}

/** Pull the numeric fallbackRate out of the COMPLETE line. */
function fallbackRateFrom(logs) {
  const line = logs.find((l) => l.includes('[ai-tracker-scan] COMPLETE'));
  assert.ok(line, 'executeScan emitted no COMPLETE line');
  const m = line.match(/fallbackRate=([\d.]+)/);
  assert.ok(m, `COMPLETE line carries no numeric fallbackRate: ${line}`);
  return { value: Number(m[1]), line };
}

before(async () => {
  await db.connect();
  await db.clear();
  vendorMock.install();
  ws = await Workspace.create({
    workspaceNumber: 999501,
    userId: new mongoose.Types.ObjectId(),
    organizationId: null, // org-less → no billing noise
    name: 'Fallback WS',
  });
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

beforeEach(async () => {
  await AiTracker.deleteMany({});
  await AiTrackerPrompt.deleteMany({});
});

describe('fallbackRate is a live signal, not a hard-coded zero', () => {
  it('a healthy analyzer reports fallbackRate=0 (the control)', { timeout: 120_000 }, async () => {
    const logs = await scanCapturingLogs({
      chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
      kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
    });
    const { value, line } = fallbackRateFrom(logs);
    assert.equal(value, 0, `a healthy scan reported fallbackRate=${value}: ${line}`);
  });

  it('a DEAD analyzer key (401) drives fallbackRate above zero — the P9-01 signal', { timeout: 120_000 }, async () => {
    // Exactly the P9-01 shape: the vendor answers fine, the ANALYZER is
    // rejected, and the engine silently degrades to regex.
    const logs = await scanCapturingLogs({
      chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
      kimi: [{ status: 401, text: '{"error":{"message":"No auth credentials found"}}', repeat: true }],
    });
    const { value, line } = fallbackRateFrom(logs);
    assert.ok(
      value > 0,
      `the analyzer was DOWN for every prompt but fallbackRate=${value}. `
      + `The counter is not wired to analysis.fallback — the alert in `
      + `docs/ai-tracker-observability.md can never fire. Line: ${line}`,
    );
    assert.equal(value, 100, `expected a total analyzer outage to read 100%, got ${value}: ${line}`);
  });

  it('the engine summary line carries the same signal', { timeout: 120_000 }, async () => {
    const logs = await scanCapturingLogs({
      chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
      kimi: [{ status: 401, text: '{"error":{"message":"No auth credentials found"}}', repeat: true }],
    });
    const engineLine = logs.find((l) => l.includes('scan complete:'));
    assert.ok(engineLine, 'no engine summary line');
    const m = engineLine.match(/fallbackRate=([\d.]+)/);
    assert.ok(m, `engine summary carries no numeric fallbackRate: ${engineLine}`);
    assert.ok(Number(m[1]) > 0, `engine summary reported fallbackRate=${m[1]} during a total analyzer outage`);
  });
});
