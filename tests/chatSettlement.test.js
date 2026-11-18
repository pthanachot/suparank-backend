/**
 * QA Nov 2026 (B04 + B33) — chat() settlement wiring, end to end with every
 * collaborator stubbed (no DB, no engine). Pins that:
 *   - a chat reply that writes nothing is refunded in full,
 *   - a chat reply that writes is priced on the largest single turn,
 *   - replyOnly is forwarded to the engine and bills as a no-write turn.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const aiController = require('../src/controllers/aiController');
const writingEngine = require('../src/services/writingEngine');
const tierService = require('../src/services/tierService');
const creditService = require('../src/services/creditService');
const threadService = require('../src/services/threadService');
const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const BrandVoice = require('../src/models/BrandVoice');
const Avatar = require('../src/models/Avatar');
const Plan = require('../src/models/Plan');

function sseBody(events) {
  const chunks = events.map((e) => Buffer.from(`data: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      cancel: async () => {},
    }),
  };
}

async function runChat({ events, body = {}, mode = 'chat', env = {} }) {
  const saved = [];
  const stub = (obj, key, fn) => { saved.push([obj, key, obj[key]]); obj[key] = fn; };
  const captured = { settle: null, refunded: 0, engineOpts: null, appended: [] };
  const content = { _id: `c-${Math.random()}`, workspaceId: 'w1', contentNumber: 1, blocks: [], mode, targetKeywords: [] };
  const savedEnv = {};
  for (const [k, v] of Object.entries(env)) { savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  stub(Content, 'findByNumber', async () => content);
  stub(Workspace, 'findById', () => ({ select: () => ({ lean: async () => ({ workspaceNumber: 1 }) }) }));
  stub(BrandVoice, 'findOne', () => ({ lean: async () => null, select: () => ({ lean: async () => null }) }));
  stub(Avatar, 'findOne', () => ({ lean: async () => null }));
  stub(Plan, 'findProposed', async () => null);
  stub(Plan, 'findDraft', async () => null);
  stub(Plan, 'findById', async () => null);
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'professional', config: {} }));
  stub(creditService, 'preDeduct', async () => ({ transactionId: 'tx1' }));
  stub(creditService, 'settle', async (txId, actual) => { captured.settle = { txId, actual }; return { refunded: 0 }; });
  stub(creditService, 'refund', async () => { captured.refunded++; return { refunded: 0 }; });
  stub(threadService, 'getActiveThreadStamp', async () => null);
  stub(threadService, 'getOrCreateActiveThread', async () => ({ _id: 't1' }));
  stub(threadService, 'appendMessage', async (_t, m) => { captured.appended.push(m); return { seq: 1, threadId: 't1' }; });
  stub(threadService, 'recordTurns', async () => {});
  stub(threadService, 'maybeCompactThread', async () => {});
  for (const m of ['pushDocument', 'pushBrief', 'pushContextFiles', 'pushBrandVoice', 'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig']) {
    stub(writingEngine, m, async () => {});
  }
  stub(writingEngine, 'createSession', async () => 'sess-1');
  stub(writingEngine, 'sendChatMessageStream', async (_s, _p, _sig, _preset, opts) => {
    captured.engineOpts = opts;
    return { body: sseBody(events) };
  });

  const res = {
    statusCode: 200, headersSent: false, chunks: [], ended: false,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.jsonBody = b; return res; },
    writeHead() { res.headersSent = true; },
    write(c) { res.chunks.push(String(c)); },
    end() { res.ended = true; },
  };
  const req = {
    params: { workspaceNumber: '1', contentNumber: '1' },
    workspace: { _id: 'w1', organizationId: 'org1' },
    user: { userId: 'u1' },
    body: { prompt: 'hello', ...body },
    creditContext: { orgId: 'org1', deductionEnabled: true, featureKey: 'aiChat', tier: 'professional', estimatedCredits: 2 },
    on: () => {},
  };
  try {
    await aiController.chat(req, res);
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) { const [o, k, v] = saved[i]; o[k] = v; }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { res, captured };
}

test('chat that only answers (no document_diff) is refunded in full', async () => {
  const { captured } = await runChat({
    events: [
      { type: 'usage', usage: { input_tokens: 9000, output_tokens: 300 } },
      { type: 'text_delta', textDelta: 'Here is an answer.' },
      { type: 'complete', completion: { stopReason: 'done' } },
    ],
  });
  assert.equal(captured.settle, null);
  assert.equal(captured.refunded, 1);
});

test('chat that edits is priced on the largest single turn, not the sum', async () => {
  const { captured } = await runChat({
    events: [
      { type: 'usage', usage: { input_tokens: 6000, output_tokens: 100 } },
      { type: 'document_diff', patches: [] },
      { type: 'usage', usage: { input_tokens: 6500, output_tokens: 100 } },
      { type: 'complete', completion: { stopReason: 'done' } },
    ],
  });
  assert.deepEqual(captured.settle, { txId: 'tx1', actual: 1 }, '12.7K summed, but no turn exceeded 8K');
});

test('chat that edits with an oversized single turn costs 2', async () => {
  const { captured } = await runChat({
    events: [
      { type: 'usage', usage: { input_tokens: 9000, output_tokens: 100 } },
      { type: 'document_diff', patches: [] },
    ],
  });
  assert.deepEqual(captured.settle, { txId: 'tx1', actual: 2 });
});

test('chat that wrote then hit an engine error keeps its charge', async () => {
  const { captured } = await runChat({
    events: [
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 100 } },
      { type: 'document_diff', patches: [] },
      { type: 'error', code: 'api_error', error: 'provider failed' },
    ],
  });
  assert.deepEqual(captured.settle, { txId: 'tx1', actual: 1 });
});

test('replyOnly: forwarded to the engine, and bills 0 even if a diff slips through', async () => {
  const { captured } = await runChat({
    body: { replyOnly: true },
    events: [
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 100 } },
      { type: 'document_diff', patches: [] }, // an engine that ignored reply_only
      { type: 'text_delta', textDelta: 'Meta description: ...' },
    ],
  });
  assert.deepEqual(captured.engineOpts, { replyOnly: true });
  assert.equal(captured.settle, null);
  assert.equal(captured.refunded, 1);
  const assistant = captured.appended.find((m) => m.kind === 'assistant');
  assert.equal(assistant.meta.docWrites, 0, 'the thread must not claim edits a replyOnly turn never applied');
});

test('replyOnly is strict boolean: a truthy string is a normal turn', async () => {
  const { captured } = await runChat({ body: { replyOnly: 'yes' }, events: [] });
  assert.deepEqual(captured.engineOpts, { replyOnly: false });
});

test('writingEngine.sendChatMessageStream sends reply_only only when true', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true }; };
  try {
    await writingEngine.sendChatMessageStream('s1', 'p', undefined, '', { replyOnly: true });
    await writingEngine.sendChatMessageStream('s1', 'p', undefined, '');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(bodies[0], { prompt: 'p', reply_only: true });
  assert.deepEqual(bodies[1], { prompt: 'p' }, 'byte-identical body for older engines');
});

// ─── QA N5/B34: context file system failures are visible to the client ───

const events = (res) => res.chunks.join('').split('\n')
  .filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

test('chat with the CFS unavailable streams a context_unavailable warning and still runs', async () => {
  const { res } = await runChat({
    env: { INTERNAL_API_KEY: undefined },
    events: [{ type: 'text_delta', textDelta: 'answer' }],
  });
  const ev = events(res);
  const warn = ev.find((e) => e.type === 'warning');
  assert.ok(warn, 'a warning event was sent');
  assert.equal(warn.code, 'context_unavailable');
  assert.doesNotMatch(warn.message, /\u2014|INTERNAL_API_KEY|CFS/);
  assert.ok(ev.some((e) => e.type === 'text_delta'), 'the run itself continued');
});

test('chat with the CFS configured sends no warning', async () => {
  const saved = writingEngine.pushCFSConfig;
  const { res } = await runChat({ env: { INTERNAL_API_KEY: 'k' }, events: [] });
  writingEngine.pushCFSConfig = saved;
  assert.equal(events(res).filter((e) => e.type === 'warning').length, 0);
});

test('plan mode with the CFS unavailable ends cleanly with a friendly SSE error, nothing charged', async () => {
  const { res, captured } = await runChat({ mode: 'plan', env: { INTERNAL_API_KEY: undefined }, events: [] });
  assert.equal(res.statusCode, 200, 'not a raw 500');
  assert.equal(res.ended, true, 'the stream is closed so the UI does not stall');
  const ev = events(res);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'error');
  assert.equal(ev[0].code, 'context_unavailable');
  assert.doesNotMatch(ev[0].error, /\u2014|INTERNAL_API_KEY|context file system/);
  assert.equal(captured.settle, null);
});
