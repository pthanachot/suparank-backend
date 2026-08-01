'use strict';

// Conversations Phase 5: permanent delete.
//
// Two properties carry the weight, and neither is enforced by the schema:
//
//  1. CHILDREN FIRST. AiThreadMessage is keyed only by threadId — no workspace,
//     no content field — so a parent deleted before its children orphans them
//     permanently, with no query that can ever find them again.
//  2. EVICTION. Deleting the active conversation leaves zero actives; the next
//     run mints an EMPTY thread; an empty thread makes taskSeed skip its
//     replacing seed. So without forgetSession the warm engine session keeps
//     answering from the conversation that was just deleted. Proven live by
//     scripts/forget-smoke.mjs, which fails at step 4 with eviction removed.

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

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

const CONTENT = { _id: { toString: () => 'c-del' }, workspaceId: 'w1', contentNumber: 9 };
const OID = 'cccccccccccccccccccccccc';

/** Stub the delete chain and record the ORDER of operations. */
function stubDeletes({ target = { _id: 'T1', status: 'active' }, msgFails = false } = {}) {
  const saved = {
    findOne: AiThread.findOne,
    deleteMany: AiThreadMessage.deleteMany,
    deleteOne: AiThread.deleteOne,
  };
  const order = [];
  // findOne is called with (filter, projection, { lean: true }) and AWAITED
  // directly — it is not a query that gets .lean() chained. A stub returning
  // `{ lean: fn }` resolves to that object, which is truthy, so the service
  // would sail past its own miss check with an undefined _id.
  AiThread.findOne = async () => target;
  AiThreadMessage.deleteMany = async () => {
    order.push('messages');
    if (msgFails) throw new Error('message delete failed');
    return { deletedCount: 7 };
  };
  AiThread.deleteOne = async () => { order.push('thread'); return { deletedCount: 1 }; };
  return {
    order,
    restore: () => {
      AiThread.findOne = saved.findOne;
      AiThreadMessage.deleteMany = saved.deleteMany;
      AiThread.deleteOne = saved.deleteOne;
    },
  };
}

// ─── Route wiring ────────────────────────────────────────────

test('DELETE ai/threads/:threadId registered with the thread-family gate shape', () => {
  const del = router.stack.find(
    (l) => l.route && l.route.path.includes('/ai/threads/:threadId') && l.route.methods.delete,
  );
  const getThread = router.stack.find((l) => l.route && l.route.path.endsWith('/ai/thread') && l.route.methods.get);
  assert.ok(del, 'DELETE registered');
  assert.strictEqual(del.route.stack.length, getThread.route.stack.length,
    'rwr + rf(aiThreads) + rp(aiChat,use) + handler, same as its siblings');
});

// ─── The ordering that prevents unreachable orphans ──────────

test('messages are deleted BEFORE the thread', async () => {
  const restore = stubFlag(true);
  const s = stubDeletes();
  try {
    const out = await threadService.deleteThread(CONTENT, 'T1');
    assert.deepStrictEqual(s.order, ['messages', 'thread'],
      'AiThreadMessage carries only threadId — a parent-first delete strands its ' +
      'children with no query that can find them');
    assert.strictEqual(out.messages, 7);
    assert.strictEqual(out.threads, 1);
  } finally { s.restore(); restore(); }
});

test('a failed message delete does NOT delete the thread', async () => {
  // A thread with its messages is recoverable. Messages without their thread
  // are not — so on failure the parent must survive.
  const restore = stubFlag(true);
  const s = stubDeletes({ msgFails: true });
  try {
    const out = await threadService.deleteThread(CONTENT, 'T1');
    assert.deepStrictEqual(out, { error: true });
    assert.ok(!s.order.includes('thread'), 'thread left intact when its children could not be removed');
  } finally { s.restore(); restore(); }
});

// ─── Scoping, flag, misses ───────────────────────────────────

test('scopes by contentId — another document\'s conversation is a 404, not a delete', async () => {
  const restore = stubFlag(true);
  const saved = AiThread.findOne;
  let seenFilter = null;
  AiThread.findOne = async (filter) => { seenFilter = filter; return null; };
  try {
    assert.strictEqual(await threadService.deleteThread(CONTENT, 'T-foreign'), null);
    assert.strictEqual(seenFilter.contentId, CONTENT._id);
    assert.strictEqual(seenFilter.ownerUserId, null);
  } finally { AiThread.findOne = saved; restore(); }
});

test('flag off short-circuits before any delete', async () => {
  const restore = stubFlag(false);
  const s = stubDeletes();
  try {
    assert.deepStrictEqual(await threadService.deleteThread(CONTENT, 'T1'), { disabled: true });
    assert.strictEqual(s.order.length, 0);
  } finally { s.restore(); restore(); }
});

test('reports whether the deleted conversation was the active one', async () => {
  const restore = stubFlag(true);
  const s = stubDeletes({ target: { _id: 'T2', status: 'archived' } });
  try {
    const out = await threadService.deleteThread(CONTENT, 'T2');
    assert.strictEqual(out.wasActive, false);
  } finally { s.restore(); restore(); }
});

// ─── Route behaviour: the guard and the eviction ─────────────

async function callDelete(contentId, threadId = OID) {
  const req = {
    params: { workspaceNumber: '1', contentNumber: '9', threadId },
    user: { userId: 'u1' }, body: {},
    _prefetchedContent: { ...CONTENT, _id: { toString: () => contentId } },
  };
  let status = 200; let payload = null;
  const res = { status(s) { status = s; return this; }, json(p) { payload = p; return this; } };
  await aiController.deleteThread(req, res);
  return { status, payload };
}

test('a malformed conversation id is rejected before any lookup', async () => {
  const { status } = await callDelete('c-del-badid', 'not-an-objectid');
  assert.strictEqual(status, 400);
});

test('deleting evicts the engine session', async () => {
  const restore = stubFlag(true);
  const s = stubDeletes();
  aiController.rememberSession('c-del-1', 'warm-sess');
  try {
    const { status } = await callDelete('c-del-1');
    assert.strictEqual(status, 200);
    assert.strictEqual(aiController.contentSessionMap.get('c-del-1'), undefined,
      'without this the warm session answers from the deleted conversation — ' +
      'an empty replacement thread means taskSeed skips its replacing seed');
  } finally { s.restore(); restore(); aiController.contentSessionMap.delete('c-del-1'); }
});

test('the route forwards wasActive — the client cannot know it otherwise', async () => {
  // If the deleted conversation was the one on screen, its messages and its
  // name are still displayed. Only the server knows which thread was active, so
  // dropping this field leaves the UI showing a conversation that no longer
  // exists.
  const restore = stubFlag(true);
  const s = stubDeletes({ target: { _id: 'T1', status: 'active' } });
  try {
    const { status, payload } = await callDelete('c-del-3');
    assert.strictEqual(status, 200);
    assert.strictEqual(payload.wasActive, true);
  } finally { s.restore(); restore(); aiController.contentSessionMap.delete('c-del-3'); }
});

test('wasActive is false for an archived conversation', async () => {
  const restore = stubFlag(true);
  const s = stubDeletes({ target: { _id: 'T2', status: 'archived' } });
  try {
    const { payload } = await callDelete('c-del-4');
    assert.strictEqual(payload.wasActive, false,
      'deleting a background conversation must NOT wipe the transcript on screen');
  } finally { s.restore(); restore(); aiController.contentSessionMap.delete('c-del-4'); }
});

test('a 404 does NOT evict — nothing was deleted', async () => {
  const restore = stubFlag(true);
  const saved = AiThread.findOne;
  AiThread.findOne = async () => null;
  aiController.rememberSession('c-del-2', 'warm-sess');
  try {
    const { status } = await callDelete('c-del-2');
    assert.strictEqual(status, 404);
    assert.ok(aiController.contentSessionMap.get('c-del-2'), 'warm session kept when nothing changed');
  } finally { AiThread.findOne = saved; restore(); aiController.contentSessionMap.delete('c-del-2'); }
});
