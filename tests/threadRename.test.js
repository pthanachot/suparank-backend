'use strict';

// Conversations Phase 2: rename a conversation.
//
// Two properties carry the weight here and neither is enforced by the schema:
//
//  1. Mongoose does NOT run validators on update operators, so `title`'s
//     maxlength:120 is enforced by AiThread.create only. Every update path has
//     to clamp for itself or a 10KB title stores clean.
//  2. A STORED empty title re-arms the auto-titler (its gate is
//     `!updated.title`), so the next user message would silently rename the
//     conversation again. Empty must be rejected, not persisted.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const router = require('../src/routes/workspaceRoutes');
const threadService = require('../src/services/threadService');
const flagService = require('../src/services/flagService');
const FeatureFlag = require('../src/models/FeatureFlag');
const AiThread = require('../src/models/AiThread');

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

const CONTENT = { _id: { toString: () => 'c-rn' }, workspaceId: 'w1', contentNumber: 7 };

/** Capture what findOneAndUpdate was asked to do, and echo a plausible doc. */
function stubUpdate(result) {
  const saved = AiThread.findOneAndUpdate;
  const calls = [];
  AiThread.findOneAndUpdate = async (filter, update, opts) => {
    calls.push({ filter, update, opts });
    if (result === undefined) return { _id: 'T1', title: update.$set.title };
    return result;
  };
  return { calls, restore: () => { AiThread.findOneAndUpdate = saved; } };
}

// ─── Route wiring ────────────────────────────────────────────

test('PATCH ai/threads/:threadId is registered with the thread-family gate shape', () => {
  const patch = router.stack.find(
    (l) => l.route && l.route.path.includes('/ai/threads/:threadId') && l.route.methods.patch,
  );
  const getThread = router.stack.find((l) => l.route && l.route.path.endsWith('/ai/thread') && l.route.methods.get);
  assert.ok(patch, 'PATCH rename registered');
  // rwr + rf('aiThreads') + rp('aiChat','use') + handler. A route that gates
  // differently from its siblings is how a permission hole arrives by copy-paste.
  assert.strictEqual(patch.route.stack.length, getThread.route.stack.length);
});

// ─── Clamping (the schema will not do it) ────────────────────

test('clamps an over-long title to the schema cap', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate();
  try {
    await threadService.renameThread(CONTENT, 'T1', 'x'.repeat(500));
    assert.strictEqual(s.calls[0].update.$set.title.length, 120,
      'validators do not run on update ops — the service must clamp');
  } finally { s.restore(); restore(); }
});

test('a clamp never leaves a lone surrogate half', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate();
  try {
    // 119 chars then an emoji (2 UTF-16 units) — a raw slice(0,120) splits it.
    await threadService.renameThread(CONTENT, 'T1', 'a'.repeat(119) + '😀');
    const title = s.calls[0].update.$set.title;
    assert.ok(!/[\uD800-\uDBFF]$/.test(title), 'trailing high surrogate trimmed');
  } finally { s.restore(); restore(); }
});

test('trims before storing', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate();
  try {
    await threadService.renameThread(CONTENT, 'T1', '   Chicken farming   ');
    assert.strictEqual(s.calls[0].update.$set.title, 'Chicken farming');
  } finally { s.restore(); restore(); }
});

// ─── Empty is rejected, not stored ───────────────────────────

test('an empty or whitespace title is rejected and never written', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate();
  try {
    for (const bad of ['', '   ', '\t\n', null, undefined]) {
      const out = await threadService.renameThread(CONTENT, 'T1', bad);
      assert.deepStrictEqual(out, { invalid: true }, `rejected: ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(s.calls.length, 0,
      'a stored empty title would re-arm the auto-titler and rename the thread again next turn');
  } finally { s.restore(); restore(); }
});

// ─── Scoping + flag ──────────────────────────────────────────

test('scopes by contentId and ownerUserId — a threadId alone is not enough', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate();
  try {
    await threadService.renameThread(CONTENT, 'T1', 'New name');
    const f = s.calls[0].filter;
    assert.strictEqual(f._id, 'T1');
    assert.strictEqual(f.contentId, CONTENT._id, 'another document\'s conversation must not be renameable');
    assert.strictEqual(f.ownerUserId, null);
  } finally { s.restore(); restore(); }
});

test('a foreign or unknown id resolves to null (controller maps 404)', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate(null);
  try {
    assert.strictEqual(await threadService.renameThread(CONTENT, 'T-nope', 'New name'), null);
  } finally { s.restore(); restore(); }
});

test('flag off short-circuits before any write', async () => {
  const restore = stubFlag(false);
  const s = stubUpdate();
  try {
    assert.deepStrictEqual(await threadService.renameThread(CONTENT, 'T1', 'New name'), { disabled: true });
    assert.strictEqual(s.calls.length, 0);
  } finally { s.restore(); restore(); }
});

test('a Mongo failure is a retryable error, not a lying 404', async () => {
  const restore = stubFlag(true);
  const saved = AiThread.findOneAndUpdate;
  AiThread.findOneAndUpdate = async () => { throw new Error('boom'); };
  try {
    assert.deepStrictEqual(await threadService.renameThread(CONTENT, 'T1', 'New name'), { error: true });
  } finally { AiThread.findOneAndUpdate = saved; restore(); }
});

// ─── The invariant this feature rests on ─────────────────────

test('rename touches ONLY title — the seeding invariant reads {threadId, seq}', async () => {
  const restore = stubFlag(true);
  const s = stubUpdate();
  try {
    await threadService.renameThread(CONTENT, 'T1', 'New name');
    const set = s.calls[0].update.$set;
    assert.deepStrictEqual(Object.keys(set), ['title'],
      'status/messageCount/lastMessageAt must be untouched — the seed marker and ' +
      'the picker sort both key off them, and the title reaches neither');
  } finally { s.restore(); restore(); }
});

test('a rename cannot change the seed stamp, so a warm session is never re-seeded', async () => {
  // The claim this whole feature rests on: renaming is invariant-inert.
  // getActiveThreadStamp projects { messageCount: 1 } and returns
  // { threadId, lastSeq } — no title anywhere. Prove it by renaming between two
  // stamp reads of the SAME underlying row and asserting the stamp is identical.
  const restore = stubFlag(true);
  const savedFindOne = AiThread.findOne;
  const savedUpdate = AiThread.findOneAndUpdate;
  const row = { _id: { toString: () => 'T1' }, title: 'Old name', messageCount: 9 };
  // Direct await, NOT `{ lean: async () => ... }`. getActiveThreadStamp awaits
  // findOne(...) itself — it passes { lean: true } as the THIRD argument rather
  // than chaining .lean(). A chainable stub resolves to the wrapper object,
  // whose `messageCount` is undefined, so the real function bailed to null on
  // both reads and the comparison below was null vs null: this test passed
  // regardless of what a rename did to the stamp. Every sibling file
  // (threadUx, threadDelete) already uses this form.
  AiThread.findOne = async (_f, projection) => {
    // Mirror the real projection: the stamp cannot see `title` even if it tried.
    assert.deepStrictEqual(projection, { messageCount: 1 });
    return { _id: row._id, messageCount: row.messageCount };
  };
  AiThread.findOneAndUpdate = async (_f, update) => { row.title = update.$set.title; return row; };
  try {
    const before = await threadService.getActiveThreadStamp('c-rn');
    // Pin the stamp to a real value. Without this the test can silently revert
    // to proving nothing the moment the stub shape drifts again.
    assert.deepStrictEqual(before, { threadId: 'T1', lastSeq: 8 },
      'the stamp must actually be read — comparing two nulls proves nothing');
    await threadService.renameThread(CONTENT, 'T1', 'Completely different name');
    const after = await threadService.getActiveThreadStamp('c-rn');
    assert.deepStrictEqual(after, before, 'stamp unchanged → setupSession skips its re-seed');
    assert.strictEqual(row.title, 'Completely different name', 'the rename did land');
  } finally {
    AiThread.findOne = savedFindOne;
    AiThread.findOneAndUpdate = savedUpdate;
    restore();
  }
});
