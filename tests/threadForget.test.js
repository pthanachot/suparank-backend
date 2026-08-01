'use strict';

// Conversations Phase 4: making forgetting real.
//
// The engine has no deleteSession. The only way to displace a session's
// conversation is a REPLACING seed — and `taskSeed` skips seeding entirely when
// the active thread is empty or gone. So removing a conversation from Mongo does
// NOT remove it from the warm engine session: the next freeform run reuses that
// session and answers from a conversation the user just deleted.
//
// Eviction is the fix. These tests pin the two properties it depends on:
//   1. after eviction, setupSession MINTS a fresh session instead of reusing;
//   2. the fresh session re-pushes everything — it cannot inherit the old
//      session's push hashes and silently skip the document.
//
// Property 2 is the subtle one. If a fresh session could inherit hashes, the
// document push would be skipped and the new engine session would start EMPTY —
// which looks like forgetting but is actually data loss.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const writingEngine = require('../src/services/writingEngine');
const aiController = require('../src/controllers/aiController');

const ENGINE_PUSH = ['pushDocument', 'pushBrief', 'pushContextFiles', 'pushBrandVoice', 'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig'];

function makeContent(id) {
  return {
    _id: { toString: () => id },
    workspaceId: 'w1',
    contentNumber: 7,
    blocks: [{ type: 'p', text: 'Hello world, this is the document body.' }],
    mode: 'chat',
  };
}

/** Stub every engine push; record which ones ran and how many sessions were minted. */
function stubEngine() {
  const saved = { createSession: writingEngine.createSession };
  for (const m of ENGINE_PUSH) saved[m] = writingEngine[m];
  const calls = { created: 0, pushed: [] };
  for (const m of ENGINE_PUSH) writingEngine[m] = async () => { calls.pushed.push(m); };
  writingEngine.createSession = async () => `sess-${++calls.created}`;
  return {
    calls,
    restore: () => {
      writingEngine.createSession = saved.createSession;
      for (const m of ENGINE_PUSH) writingEngine[m] = saved[m];
    },
  };
}

test('forgetSession drops the content→session binding', () => {
  aiController.rememberSession('c-forget-1', 'warm-sess');
  assert.ok(aiController.contentSessionMap.get('c-forget-1'), 'precondition: a warm entry exists');
  aiController.forgetSession('c-forget-1');
  assert.strictEqual(aiController.contentSessionMap.get('c-forget-1'), undefined);
});

test('forgetting is idempotent and safe on unknown content', () => {
  assert.doesNotThrow(() => aiController.forgetSession('c-never-seen'));
  aiController.forgetSession('c-never-seen');
});

test('after eviction the next setup MINTS a session instead of reusing the warm one', async () => {
  const s = stubEngine();
  try {
    // A warm run establishes the binding.
    const first = await aiController.setupSession(makeContent('c-forget-2'), { reuseSession: true });
    assert.strictEqual(first.sessionId, 'sess-1');
    // A second run would normally REUSE it — that is the memory chain.
    const reused = await aiController.setupSession(makeContent('c-forget-2'), { reuseSession: true });
    assert.strictEqual(reused.sessionId, 'sess-1', 'precondition: warm sessions are reused');

    aiController.forgetSession('c-forget-2');

    const afterForget = await aiController.setupSession(makeContent('c-forget-2'), { reuseSession: true });
    assert.strictEqual(afterForget.sessionId, 'sess-2',
      'a forgotten content gets a NEW engine session — the old one holds the deleted conversation and is now unreachable');
  } finally {
    s.restore();
    aiController.contentSessionMap.delete('c-forget-2');
  }
});

test('the fresh session re-pushes the document — it cannot inherit stale hashes', async () => {
  const s = stubEngine();
  try {
    const first = await aiController.setupSession(makeContent('c-forget-3'), { reuseSession: true });
    // The document skip needs BOTH an unchanged hash and a previous run that
    // wrote nothing (`lastRunDocWrites === 0`) — a run that edited the document
    // must always re-push, or the engine would keep a stale copy. Establish that
    // second condition explicitly; without it the skip never engages and this
    // test would pass for the wrong reason.
    aiController.recordRunDocWrites('c-forget-3', first.sessionId, 0);
    s.calls.pushed.length = 0;
    await aiController.setupSession(makeContent('c-forget-3'), { reuseSession: true });
    assert.ok(!s.calls.pushed.includes('pushDocument'),
      'precondition: an unchanged document after a no-write run is hash-skipped');

    aiController.forgetSession('c-forget-3');

    s.calls.pushed.length = 0;
    await aiController.setupSession(makeContent('c-forget-3'), { reuseSession: true });
    assert.ok(s.calls.pushed.includes('pushDocument'),
      'a fresh session starts with EMPTY hashes — otherwise the new session would ' +
      'begin with no document at all, which reads as forgetting but is data loss');
  } finally {
    s.restore();
    aiController.contentSessionMap.delete('c-forget-3');
  }
});

test('eviction clears the tenancy set, not just the primary session id', async () => {
  // sessionBoundToContent reads `sessionIds`. Leaving it behind would let a
  // catch-up resume against a session that holds the removed conversation.
  aiController.rememberSession('c-forget-4', 'sess-a');
  aiController.rememberSession('c-forget-4', 'sess-b');
  const entry = aiController.contentSessionMap.get('c-forget-4');
  assert.ok(entry.sessionIds.has('sess-a') && entry.sessionIds.has('sess-b'), 'precondition');
  aiController.forgetSession('c-forget-4');
  assert.strictEqual(aiController.contentSessionMap.get('c-forget-4'), undefined,
    'the whole entry goes — sessionIds cannot outlive it');
});

/** Drive a thread route with a pre-resolved content (resolveContent honours
 *  `req._prefetchedContent`, aiController.js:498) and report what it answered. */
async function callRoute(handler, contentId, params = {}) {
  const req = {
    params: { workspaceNumber: '1', contentNumber: '7', ...params },
    user: { userId: 'u1' },
    body: {},
    _prefetchedContent: makeContent(contentId),
  };
  let status = 200;
  let payload = null;
  const res = {
    status(s) { status = s; return this; },
    json(p) { payload = p; return this; },
  };
  await handler(req, res);
  return { status, payload };
}

test('newThread evicts the session after archiving', async () => {
  // The route-level proof: "New conversation" has always left the warm session
  // holding the ARCHIVED conversation (its own route comment admitted it), and
  // the fresh thread is empty so taskSeed skips its replacing seed.
  const threadService = require('../src/services/threadService');
  const savedStart = threadService.startNewThread;
  threadService.startNewThread = async () => ({ _id: 'T-new' });
  aiController.rememberSession('c-forget-5', 'warm-sess');
  try {
    const { status } = await callRoute(aiController.newThread, 'c-forget-5');
    // Asserted, not skipped: a conditional assertion here could pass forever
    // without ever running if the handler started bouncing.
    assert.strictEqual(status, 200, 'handler reached the success path');
    assert.strictEqual(aiController.contentSessionMap.get('c-forget-5'), undefined,
      'a successful new-conversation must evict, or the next run answers from the archived one');
  } finally {
    threadService.startNewThread = savedStart;
    aiController.contentSessionMap.delete('c-forget-5');
  }
});

test('activateThread evicts too — the seeding invariant is not sufficient alone', async () => {
  // taskSeed bails out silently twice (null stamp; a replay payload the shaper
  // emptied). Either leaves the warm session holding the conversation the user
  // just switched AWAY from, so switching cannot rely on the re-seed alone.
  const threadService = require('../src/services/threadService');
  const savedActivate = threadService.activateThread;
  threadService.activateThread = async () => ({ _id: 'T-target', title: 'Older work' });
  aiController.rememberSession('c-forget-6', 'warm-sess');
  try {
    const { status } = await callRoute(aiController.activateThread, 'c-forget-6', {
      threadId: 'aaaaaaaaaaaaaaaaaaaaaaaa', // 24 hex — passes the id guard
    });
    assert.strictEqual(status, 200, 'handler reached the success path');
    assert.strictEqual(aiController.contentSessionMap.get('c-forget-6'), undefined,
      'switching conversations must not be able to leak the previous one');
  } finally {
    threadService.activateThread = savedActivate;
    aiController.contentSessionMap.delete('c-forget-6');
  }
});

test('a failed switch does NOT evict — the conversation did not change', async () => {
  // Eviction costs a full re-setup. A 404/503 means the user is still in the
  // same conversation, so throwing away a warm session would be pure waste.
  const threadService = require('../src/services/threadService');
  const savedActivate = threadService.activateThread;
  threadService.activateThread = async () => null; // genuine miss → 404
  aiController.rememberSession('c-forget-7', 'warm-sess');
  try {
    const { status } = await callRoute(aiController.activateThread, 'c-forget-7', {
      threadId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    });
    assert.strictEqual(status, 404);
    assert.ok(aiController.contentSessionMap.get('c-forget-7'), 'warm session kept on a failed switch');
  } finally {
    threadService.activateThread = savedActivate;
    aiController.contentSessionMap.delete('c-forget-7');
  }
});
