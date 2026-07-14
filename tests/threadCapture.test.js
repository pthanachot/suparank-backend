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

test('tap seals turn segments on usage events (the one-per-turn boundary)', () => {
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'agent_commentary', textDelta: 'Reading the document first.' }));
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } }));
  tap.addChunk(sse({ type: 'tool_start', toolName: 'EditTool' })); // tool calls are NOT boundaries
  tap.addChunk(sse({ type: 'agent_commentary', textDelta: 'Done — I tightened the intro.' }));
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 120, output_tokens: 12 } }));
  tap.addChunk(sse({ type: 'complete', fullText: 'Done — I tightened the intro.', completion: { stopReason: 'done' } }));
  assert.strictEqual(
    tap.finalAssistantText(),
    'Reading the document first.\n\nDone — I tightened the intro.',
  );
  assert.strictEqual(tap.turnCount(), 2, 'one turn per usage event, not per tool call');
});

test('review BUG-1: consecutive text turns (nudge between, no tool_start) do NOT fuse', () => {
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'text_delta', textDelta: "I'll begin now." }));
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } }));
  // engine injects a nudge with NO wire event, next turn streams more text
  tap.addChunk(sse({ type: 'text_delta', textDelta: 'Let me start by reading the doc.' }));
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 60, output_tokens: 8 } }));
  assert.strictEqual(
    tap.finalAssistantText(),
    "I'll begin now.\n\nLet me start by reading the doc.",
    'turn boundary preserved without a tool_start between',
  );
});

test('review CAVEAT-5: any coded error event sets stopReason (not just the W4 whitelist)', () => {
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'error', code: 'api_error', error: 'provider 500' }));
  assert.strictEqual(tap.snapshot().stopReason, 'api_error');
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
    assert.deepStrictEqual(r, { seq: 4, threadId: 't1' }, 'seq = post-inc count - 1, threadId echoed for the seed-marker bump');
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

test('markSteersApplied flips only unapplied steer rows for the thread', async () => {
  const saved = AiThreadMessage.updateMany;
  let filter = null;
  let update = null;
  AiThreadMessage.updateMany = async (f, u) => { filter = f; update = u; return { modifiedCount: 1 }; };
  try {
    const t0 = Date.now() - 5000;
    await threadService.markSteersApplied('t9', t0);
    assert.strictEqual(filter.threadId, 't9');
    assert.strictEqual(filter['meta.channel'], 'steer');
    assert.strictEqual(filter['meta.applied'], false, 'only unapplied steers are flipped');
    assert.deepStrictEqual(filter.createdAt, { $gte: new Date(t0) }, 'review BUG-3: time-scoped to THIS run — a prior run\'s dropped steer stays false');
    assert.strictEqual(update.$set['meta.applied'], true);
    // Null threadId is a silent no-op (callers pass thread?._id unguarded).
    filter = null;
    await threadService.markSteersApplied(null);
    assert.strictEqual(filter, null, 'no query when threadId missing');
  } finally {
    AiThreadMessage.updateMany = saved;
  }
});

test('unique (threadId, seq) index is declared on AiThreadMessage', () => {
  const idx = AiThreadMessage.schema.indexes().find(
    ([keys, opts]) => keys.threadId === 1 && keys.seq === 1 && opts && opts.unique,
  );
  assert.ok(idx, 'unique compound index (threadId, seq) must exist');
});

// ─── Review fixes (data-layer) ───────────────────────────────

test('BUG-1 fix: unique partial index on active threads is declared', () => {
  const idx = AiThread.schema.indexes().find(
    ([keys, opts]) => keys.contentId === 1 && keys.ownerUserId === 1 && opts && opts.unique
      && opts.partialFilterExpression && opts.partialFilterExpression.status === 'active',
  );
  assert.ok(idx, 'unique partial index (contentId, ownerUserId | status=active) must exist — the upsert is NOT atomic without it');
});

test('BUG-1 fix: getOrCreateActiveThread retries an E11000 as a read of the winner', async () => {
  const restore = stubFlag(true);
  const savedUpdate = AiThread.findOneAndUpdate;
  const savedFind = AiThread.findOne;
  AiThread.findOneAndUpdate = async () => { const e = new Error('dup'); e.code = 11000; throw e; };
  AiThread.findOne = async () => ({ _id: 'winner', title: '' });
  try {
    const thread = await threadService.getOrCreateActiveThread(fakeContent, 'u1');
    assert.strictEqual(thread._id, 'winner', 'loser of the insert race adopts the winner row');
  } finally {
    AiThread.findOneAndUpdate = savedUpdate;
    AiThread.findOne = savedFind;
    restore();
  }
});

test('BUG-2 fix: appendMessage re-resolves the ACTIVE thread when the captured one was archived', async () => {
  const restore = stubFlag(true);
  const savedUpdate = AiThread.findOneAndUpdate;
  const savedCreate = AiThreadMessage.create;
  let created = null;
  const calls = [];
  AiThread.findOneAndUpdate = async (filter, update, opts) => {
    calls.push(filter);
    if (filter._id === 'archived-t') return null;            // status:'active' filter misses
    if (opts && opts.upsert) return { _id: 'fresh-t', title: '', messageCount: 0 }; // re-resolve
    if (filter._id === 'fresh-t') return { _id: 'fresh-t', title: '', messageCount: 1 };
    return null;
  };
  AiThreadMessage.create = async (doc) => { created = doc; return doc; };
  try {
    const r = await threadService.appendMessage(
      { _id: 'archived-t', title: 't' },
      { kind: 'assistant', text: 'the reply', meta: { channel: 'agent' } },
      fakeContent, // enables re-resolve
    );
    assert.deepStrictEqual(r, { seq: 0, threadId: 'fresh-t' });
    assert.strictEqual(created.threadId, 'fresh-t', 'reply filed on the CURRENT active thread, not the archived one');
    assert.ok(calls.every((f) => f.status === 'active' || f.upsert === undefined), 'every $inc filters on status:active');
  } finally {
    AiThread.findOneAndUpdate = savedUpdate;
    AiThreadMessage.create = savedCreate;
    restore();
  }
});

test('title gate: a steer can never become the thread title', async () => {
  const savedUpdate = AiThread.findOneAndUpdate;
  const savedCreate = AiThreadMessage.create;
  const savedTitle = AiThread.updateOne;
  let titleSet = false;
  AiThread.findOneAndUpdate = async () => ({ _id: 't1', title: '', messageCount: 1 });
  AiThread.updateOne = () => { titleSet = true; return { catch: () => {} }; };
  AiThreadMessage.create = async (d) => d;
  try {
    await threadService.appendMessage({ _id: 't1', title: '' }, { kind: 'user', text: 'make it shorter', meta: { channel: 'steer' } });
    assert.strictEqual(titleSet, false, 'steer must not title the thread');
    await threadService.appendMessage({ _id: 't1', title: '' }, { kind: 'user', text: 'Write an intro', meta: { channel: 'agent' } });
    assert.strictEqual(titleSet, true, 'a real conversation prompt does');
  } finally {
    AiThread.findOneAndUpdate = savedUpdate;
    AiThreadMessage.create = savedCreate;
    AiThread.updateOne = savedTitle;
  }
});

test('startNewThread: flag off → { disabled: true } (controller maps to a clean 409)', async () => {
  const restore = stubFlag(false);
  try {
    assert.deepStrictEqual(await threadService.startNewThread(fakeContent, 'u1'), { disabled: true });
  } finally { restore(); }
});

test('safeSlice: 32KB cut never leaves a dangling surrogate half', async () => {
  const savedUpdate = AiThread.findOneAndUpdate;
  const savedCreate = AiThreadMessage.create;
  let created = null;
  AiThread.findOneAndUpdate = async () => ({ _id: 't1', title: 'x', messageCount: 1 });
  AiThreadMessage.create = async (d) => { created = d; return d; };
  try {
    // 32767 chars then an emoji (2 UTF-16 units) — slice(0, 32768) would cut it in half.
    const text = 'a'.repeat(32767) + '😀';
    await threadService.appendMessage({ _id: 't1', title: 'x' }, { kind: 'user', text, meta: { channel: 'chat' } });
    assert.strictEqual(created.text.length, 32767, 'lone high surrogate trimmed');
    assert.ok(!/[\uD800-\uDBFF]$/.test(created.text));
  } finally {
    AiThread.findOneAndUpdate = savedUpdate;
    AiThreadMessage.create = savedCreate;
  }
});
