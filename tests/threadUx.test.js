'use strict';

// Threads Phase 4: list + activate (the picker's backend).

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
const Content = require('../src/models/Content');

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

const CONTENT = { _id: { toString: () => 'c-ux', equals: undefined }, workspaceId: 'w1', contentNumber: 4 };

test('routes registered: GET ai/threads (list) + POST activate, thread-family gate shape', () => {
  const list = router.stack.find((l) => l.route && l.route.path.endsWith('/ai/threads') && l.route.methods.get);
  const act = router.stack.find((l) => l.route && l.route.path.includes('/ai/threads/:threadId/activate') && l.route.methods.post);
  const getThread = router.stack.find((l) => l.route && l.route.path.endsWith('/ai/thread') && l.route.methods.get);
  assert.ok(list, 'GET threads registered');
  assert.ok(act, 'POST activate registered');
  assert.strictEqual(list.route.stack.length, getThread.route.stack.length, 'same gate chain as the thread family');
  assert.strictEqual(act.route.stack.length, getThread.route.stack.length);
});

test('listThreads maps and bounds the picker payload', async () => {
  const saved = AiThread.find;
  let seenOpts = null;
  AiThread.find = (filter, projection) => ({
    sort: (s) => { seenOpts = s; return {
      limit: (n) => ({ lean: async () => [
        { _id: { toString: () => 'T-active' }, title: 'Current work', status: 'active', messageCount: 4, lastMessageAt: new Date(1), createdAt: new Date(0) },
        { _id: { toString: () => 'T-old' }, title: '', status: 'archived', messageCount: 12, lastMessageAt: new Date(2), createdAt: new Date(0) },
      ] }) };
    },
  });
  try {
    const out = await threadService.listThreads('c-ux');
    assert.deepStrictEqual(seenOpts, { status: 1, lastMessageAt: -1 }, "active-first ('active' < 'archived'), newest-first within");
    assert.strictEqual(out[0].id, 'T-active');
    assert.strictEqual(out[1].title, '', 'untitled threads pass through (FE renders a fallback)');
  } finally { AiThread.find = saved; }
});

test('activateThread: archive-current → activate-target; already-active is a no-op', async () => {
  const restore = stubFlag(true);
  const savedFindOne = AiThread.findOne;
  const savedUpdateMany = AiThread.updateMany;
  const savedFOU = AiThread.findOneAndUpdate;
  let archived = false;
  AiThread.findOne = async (f) => (String(f._id) === 'T-arch'
    ? { _id: 'T-arch', status: 'archived', title: 'Old plan' }
    : { _id: 'T-live', status: 'active', title: 'Live' });
  AiThread.updateMany = async () => { archived = true; return { modifiedCount: 1 }; };
  AiThread.findOneAndUpdate = async (f, u) => {
    assert.strictEqual(u.$set.status, 'active');
    assert.strictEqual(u.$set.archivedAt, null);
    return { _id: 'T-arch', status: 'active', title: 'Old plan' };
  };
  try {
    const t = await threadService.activateThread(CONTENT, 'T-arch');
    assert.strictEqual(t.status, 'active');
    assert.strictEqual(archived, true, 'current active archived first');

    archived = false;
    const same = await threadService.activateThread(CONTENT, 'T-live');
    assert.strictEqual(same._id, 'T-live');
    assert.strictEqual(archived, false, 'already-active target must not touch anything');
  } finally {
    AiThread.findOne = savedFindOne;
    AiThread.updateMany = savedUpdateMany;
    AiThread.findOneAndUpdate = savedFOU;
    restore();
  }
});

test('activateThread: cross-content threadId → null (content-scoped 404)', async () => {
  const restore = stubFlag(true);
  const saved = AiThread.findOne;
  AiThread.findOne = async () => null; // scoped filter missed
  try {
    assert.strictEqual(await threadService.activateThread(CONTENT, 'T-foreign'), null);
  } finally { AiThread.findOne = saved; restore(); }
});

// ─── P4 review fixes ─────────────────────────────────────────

test('review BUG-1: activate retries an E11000 (upstart active) by re-archiving, then succeeds', async () => {
  const restore = stubFlag(true);
  const savedFindOne = AiThread.findOne;
  const savedUpdateMany = AiThread.updateMany;
  const savedFOU = AiThread.findOneAndUpdate;
  let archives = 0;
  let activations = 0;
  AiThread.findOne = async (f) => (f._id ? { _id: 'T-arch', status: 'archived', title: 'Old' } : { _id: 'T-prev', status: 'active' });
  AiThread.updateMany = async () => { archives++; return { modifiedCount: 1 }; };
  AiThread.findOneAndUpdate = async () => {
    activations++;
    if (activations === 1) { const e = new Error('dup'); e.code = 11000; throw e; }
    return { _id: 'T-arch', status: 'active', title: 'Old' };
  };
  try {
    const t = await threadService.activateThread(CONTENT, 'T-arch');
    assert.strictEqual(t.status, 'active', 'second attempt wins');
    assert.strictEqual(archives, 2, 're-archived the upstart between attempts');
  } finally {
    AiThread.findOne = savedFindOne;
    AiThread.updateMany = savedUpdateMany;
    AiThread.findOneAndUpdate = savedFOU;
    restore();
  }
});

test('review BUG-1/BUG-3: terminal activate failure returns {error:true} and RESTORES the original active', async () => {
  const restore = stubFlag(true);
  const savedFindOne = AiThread.findOne;
  const savedUpdateMany = AiThread.updateMany;
  const savedFOU = AiThread.findOneAndUpdate;
  const savedUpdateOne = AiThread.updateOne;
  let restored = false;
  AiThread.findOne = async (f) => (f._id ? { _id: 'T-arch', status: 'archived' } : { _id: 'T-prev', status: 'active' });
  AiThread.updateMany = async () => ({ modifiedCount: 1 });
  AiThread.findOneAndUpdate = async () => { const e = new Error('dup'); e.code = 11000; throw e; }; // loses every attempt
  AiThread.updateOne = async (f, u) => {
    if (String(f._id) === 'T-prev' && u.$set.status === 'active') restored = true;
    return { modifiedCount: 1 };
  };
  try {
    const t = await threadService.activateThread(CONTENT, 'T-arch');
    assert.deepStrictEqual(t, { error: true }, 'failure is NOT a null/404 — the controller maps it to a retryable 503');
    assert.strictEqual(restored, true, 'the user is never stranded on a fresh empty thread');
  } finally {
    AiThread.findOne = savedFindOne;
    AiThread.updateMany = savedUpdateMany;
    AiThread.findOneAndUpdate = savedFOU;
    AiThread.updateOne = savedUpdateOne;
    restore();
  }
});

test('review BUG-2: the thread-write lock 409s activate/new (chat runs never hit activeAgentRuns)', async () => {
  const savedFind = Content.findByNumber;
  Content.findByNumber = async () => ({ _id: { toString: () => 'c-lock' }, workspaceId: 'w1', contentNumber: 4 });
  const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  aiController.lockThreadWrites('c-lock'); // a chat run holds the user→assistant span
  try {
    let res = mkRes();
    await aiController.activateThread({ params: { contentNumber: '4', threadId: 'a'.repeat(24) }, workspace: { _id: 'w1' } }, res);
    assert.strictEqual(res.statusCode, 409, 'activate blocked while a chat run writes thread rows');

    res = mkRes();
    await aiController.newThread({ params: { contentNumber: '4' }, workspace: { _id: 'w1' }, user: { userId: 'u1' } }, res);
    assert.strictEqual(res.statusCode, 409, 'newThread blocked too');

    aiController.unlockThreadWrites('c-lock');
    // Lock released → the guard passes. The request then reaches the service
    // layer, whose flag lookup fails-closed here (no Mongo) → the DISABLED
    // 409 — a different 409 whose message proves the run-guard was cleared.
    res = mkRes();
    await aiController.activateThread({ params: { contentNumber: '4', threadId: 'a'.repeat(24) }, workspace: { _id: 'w1' } }, res);
    assert.ok(!/run is in progress/i.test(res.body?.error || ''), 'the run-guard 409 must be gone once the lock releases');
  } finally {
    aiController.unlockThreadWrites('c-lock');
    Content.findByNumber = savedFind;
  }
});

test('review CAVEAT-1: startNewThread no-ops when the active thread is already empty', async () => {
  const restore = stubFlag(true);
  const savedFindOne = AiThread.findOne;
  const savedUpdateMany = AiThread.updateMany;
  let archived = false;
  AiThread.findOne = async () => ({ _id: 'T-empty', status: 'active', messageCount: 0 });
  AiThread.updateMany = async () => { archived = true; return { modifiedCount: 1 }; };
  try {
    const t = await threadService.startNewThread(CONTENT, 'u1');
    assert.strictEqual(t._id, 'T-empty', 'the empty active thread IS the new conversation');
    assert.strictEqual(archived, false, 'no archive, no spam row');
  } finally {
    AiThread.findOne = savedFindOne;
    AiThread.updateMany = savedUpdateMany;
    restore();
  }
});

test('review CAVEAT-8: listThreads filters empty ARCHIVED artifacts (active always shows)', async () => {
  const saved = AiThread.find;
  let seenFilter = null;
  AiThread.find = (filter) => { seenFilter = filter; return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; };
  try {
    await threadService.listThreads('c-ux');
    assert.deepStrictEqual(seenFilter.$or, [{ status: 'active' }, { messageCount: { $gt: 0 } }]);
  } finally { AiThread.find = saved; }
});

test('activateThread controller: 409 while a run is in flight; 400 on malformed id', async () => {
  const savedFind = Content.findByNumber;
  Content.findByNumber = async () => ({ _id: { toString: () => 'c-ux-run' }, workspaceId: 'w1', contentNumber: 4 });
  const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const entry = { sessionId: 's', startedAt: Date.now(), abort: () => {} };
  aiController.activeAgentRuns.set('c-ux-run', entry);
  try {
    let res = mkRes();
    await aiController.activateThread({ params: { contentNumber: '4', threadId: 'a'.repeat(24) }, workspace: { _id: 'w1' } }, res);
    assert.strictEqual(res.statusCode, 409, 'mid-run switch would file the reply on an archived thread');

    aiController.activeAgentRuns.delete('c-ux-run');
    res = mkRes();
    await aiController.activateThread({ params: { contentNumber: '4', threadId: 'nope' }, workspace: { _id: 'w1' } }, res);
    assert.strictEqual(res.statusCode, 400);
  } finally {
    aiController.activeAgentRuns.delete('c-ux-run');
    Content.findByNumber = savedFind;
  }
});
