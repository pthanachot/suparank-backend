'use strict';

// Threads Phase 1: capture plumbing.
// Covers (1) route wiring for GET /ai/thread + POST /ai/threads, (2) the
// usage tap's assistant-text accumulation (text_delta + agent_commentary,
// tool_start turn boundaries, steering_applied, Cancelled-fallback rejection),
// and (3) threadService's flag gating + never-throws contract. Seq-allocation
// concurrency is exercised against the model layer with stubbed statics —
// real-Mongo concurrency is covered by the Phase-1 live smoke.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const router = require('../src/routes/workspaceRoutes');
const aiController = require('../src/controllers/aiController');
const threadService = require('../src/services/threadService');
const flagService = require('../src/services/flagService');
const FeatureFlag = require('../src/models/FeatureFlag');
const AiThread = require('../src/models/AiThread');
const AiThreadMessage = require('../src/models/AiThreadMessage');

// ─── Route wiring ────────────────────────────────────────────

function findRoute(fragment, method = 'post') {
  return router.stack.find(
    (l) => l.route && l.route.path && l.route.path.includes(fragment) && l.route.methods[method],
  );
}

test('GET ai/thread and POST ai/threads are registered with the run-status gate shape', () => {
  const getThread = findRoute('ai/thread', 'get');
  const postThreads = findRoute('ai/threads', 'post');
  const runStatus = findRoute('ai/run-status', 'get');
  assert.ok(getThread, 'GET ai/thread registered');
  assert.ok(postThreads, 'POST ai/threads registered');
  // rwr + rf('aiThreads') + rp('aiChat','use') + handler = 4, same as run-status.
  assert.strictEqual(getThread.route.stack.length, runStatus.route.stack.length);
  assert.strictEqual(postThreads.route.stack.length, runStatus.route.stack.length);
});

// ─── Usage tap: assistant-text accumulation ──────────────────

function sse(ev) {
  return Buffer.from(`data: ${JSON.stringify(ev)}\n\n`);
}

test('tap accumulates chat text_delta across chunks into finalAssistantText', () => {
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'text_delta', textDelta: 'Hello ' }));
  tap.addChunk(sse({ type: 'text_delta', textDelta: 'world.' }));
  tap.addChunk(sse({ type: 'complete', fullText: 'world.', completion: { stopReason: 'done' } }));
  assert.strictEqual(tap.finalAssistantText(), 'Hello world.');
  assert.strictEqual(tap.snapshot().stopReason, 'done');
});

test('tap joins agent commentary turns with tool_start boundaries', () => {
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'agent_commentary', textDelta: 'Reading the document first.' }));
  tap.addChunk(sse({ type: 'tool_start', toolName: 'ReadFileTool' }));
  tap.addChunk(sse({ type: 'agent_commentary', textDelta: 'Done — I tightened the intro.' }));
  tap.addChunk(sse({ type: 'complete', fullText: 'Done — I tightened the intro.', completion: { stopReason: 'done' } }));
  assert.strictEqual(
    tap.finalAssistantText(),
    'Reading the document first.\n\nDone — I tightened the intro.',
  );
  assert.strictEqual(tap.turnCount(), 1);
});

test('tap falls back to complete.fullText only when no deltas were seen, and never to "Cancelled"', () => {
  const t1 = aiController.makeUsageTap();
  t1.addChunk(sse({ type: 'complete', fullText: 'Final reply.', completion: { stopReason: 'done' } }));
  assert.strictEqual(t1.finalAssistantText(), 'Final reply.');

  const t2 = aiController.makeUsageTap();
  t2.addChunk(sse({ type: 'complete', fullText: 'Cancelled', completion: { stopReason: '' } }));
  assert.strictEqual(t2.finalAssistantText(), '', 'engine-synthesized "Cancelled" is not assistant text');
});

test('tap surfaces steering_applied', () => {
  const tap = aiController.makeUsageTap();
  assert.strictEqual(tap.steeringWasApplied(), false);
  tap.addChunk(sse({ type: 'steering_applied', fullText: 'make it shorter' }));
  assert.strictEqual(tap.steeringWasApplied(), true);
});

test('tap split-across-chunks SSE line still accumulates (buffering)', () => {
  const tap = aiController.makeUsageTap();
  const whole = `data: ${JSON.stringify({ type: 'text_delta', textDelta: 'unbroken' })}\n\n`;
  tap.addChunk(Buffer.from(whole.slice(0, 15)));
  tap.addChunk(Buffer.from(whole.slice(15)));
  assert.strictEqual(tap.finalAssistantText(), 'unbroken');
});

// ─── threadService: flag gating + never-throws ───────────────

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

const fakeContent = { _id: new mongoose.Types.ObjectId(), workspaceId: new mongoose.Types.ObjectId() };

test('getOrCreateActiveThread returns null when the flag is off (capture no-op)', async () => {
  const restore = stubFlag(false);
  try {
    const thread = await threadService.getOrCreateActiveThread(fakeContent, 'u1');
    assert.strictEqual(thread, null);
    // appendMessage(null, …) is the no-op contract the handlers rely on.
    assert.strictEqual(await threadService.appendMessage(null, { kind: 'user', text: 'x' }), null);
  } finally { restore(); }
});

test('getOrCreateActiveThread never throws when Mongo is down (flag on)', async () => {
  const restore = stubFlag(true);
  try {
    // bufferCommands=false + disconnected mongoose → findOneAndUpdate rejects;
    // the service must swallow it and return null, not break the run.
    const thread = await threadService.getOrCreateActiveThread(fakeContent, 'u1');
    assert.strictEqual(thread, null);
  } finally { restore(); }
});

test('appendMessage allocates seq from the atomic counter and writes the message', async () => {
  const savedUpdate = AiThread.findOneAndUpdate;
  const savedCreate = AiThreadMessage.create;
  const savedTitle = AiThread.updateOne;
  let counter = 4; // thread already has 4 messages
  let created = null;
  AiThread.findOneAndUpdate = async (_q, update) => {
    counter += update.$inc.messageCount;
    return { _id: 't1', messageCount: counter, title: 'existing' };
  };
  AiThread.updateOne = () => ({ catch: () => {} });
  AiThreadMessage.create = async (doc) => { created = doc; return doc; };
  try {
    const r = await threadService.appendMessage(
      { _id: 't1', title: 'existing' },
      { kind: 'assistant', text: 'reply text', meta: { runId: 'r1' } },
    );
    assert.deepStrictEqual(r, { seq: 4 }, 'seq = post-inc count - 1');
    assert.strictEqual(created.threadId, 't1');
    assert.strictEqual(created.seq, 4);
    assert.strictEqual(created.kind, 'assistant');
    assert.strictEqual(created.meta.runId, 'r1');
  } finally {
    AiThread.findOneAndUpdate = savedUpdate;
    AiThreadMessage.create = savedCreate;
    AiThread.updateOne = savedTitle;
  }
});

test('appendMessage caps text at 32KB and drops empty text', async () => {
  const savedUpdate = AiThread.findOneAndUpdate;
  const savedCreate = AiThreadMessage.create;
  let created = null;
  AiThread.findOneAndUpdate = async () => ({ _id: 't1', messageCount: 1, title: 't' });
  AiThreadMessage.create = async (doc) => { created = doc; return doc; };
  try {
    assert.strictEqual(await threadService.appendMessage({ _id: 't1', title: 't' }, { kind: 'user', text: '' }), null);
    await threadService.appendMessage({ _id: 't1', title: 't' }, { kind: 'user', text: 'x'.repeat(40000) });
    assert.strictEqual(created.text.length, 32768);
  } finally {
    AiThread.findOneAndUpdate = savedUpdate;
    AiThreadMessage.create = savedCreate;
  }
});

test('unique (threadId, seq) index is declared on AiThreadMessage', () => {
  const idx = AiThreadMessage.schema.indexes().find(
    ([keys, opts]) => keys.threadId === 1 && keys.seq === 1 && opts && opts.unique,
  );
  assert.ok(idx, 'unique compound index (threadId, seq) must exist');
});
