'use strict';

// A failed pushMode used to land in `failures[]` as a warning. That was only
// harmless while the engine ignored session mode on the agent path — it does
// not any more. RunFreeformAgent now selects its strategy FROM the mode, so a
// lost push leaves the engine on its default (chat) while Mongo says plan, and
// the run proceeds under the wrong contract: the document is writable when the
// user was promised read-only, and UpdatePlan/ExitPlanMode are denied so no
// plan can ever be produced. Silent, and indistinguishable from the feature
// simply being broken.
//
// So: fatal for a non-chat mode, still non-fatal for chat (the engine's own
// default IS chat, so a lost chat push leaves the session exactly as intended).

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const writingEngine = require('../src/services/writingEngine');
const aiController = require('../src/controllers/aiController');

const ENGINE_PUSH = ['pushDocument', 'pushBrief', 'pushContextFiles', 'pushBrandVoice', 'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig'];

function makeContent(id, mode) {
  return {
    _id: { toString: () => id },
    workspaceId: 'w1',
    contentNumber: 7,
    blocks: [{ type: 'p', text: 'Hello world, this is the document body.' }],
    mode,
  };
}

function stubEngine({ pushMode, createSession }) {
  const saved = { createSession: writingEngine.createSession };
  for (const m of ENGINE_PUSH) saved[m] = writingEngine[m];
  for (const m of ENGINE_PUSH) writingEngine[m] = async () => {};
  if (pushMode) writingEngine.pushMode = pushMode;
  if (createSession) writingEngine.createSession = createSession;
  return () => {
    writingEngine.createSession = saved.createSession;
    for (const m of ENGINE_PUSH) writingEngine[m] = saved[m];
  };
}

test('a failed pushMode ABORTS setup when the mode is plan', async () => {
  let calls = 0;
  const restore = stubEngine({
    createSession: async () => 'sess-plan',
    pushMode: async () => { calls++; throw new Error('engine refused mode'); },
  });
  try {
    await assert.rejects(
      () => aiController.setupSession(makeContent('c-mode-plan', 'plan')),
      /engine refused mode/,
      'plan-mode setup must not continue with the engine still on chat',
    );
    assert.strictEqual(calls, 1, 'pushMode attempted once (no reuse, so no retry)');
  } finally {
    restore();
  }
});

test('a failed pushMode ABORTS setup when the mode is execute', async () => {
  const restore = stubEngine({
    createSession: async () => 'sess-exec',
    pushMode: async () => { throw new Error('engine refused mode'); },
  });
  try {
    await assert.rejects(
      () => aiController.setupSession(makeContent('c-mode-exec', 'execute')),
      /engine refused mode/,
    );
  } finally {
    restore();
  }
});

test('a failed pushMode is still NON-fatal for chat', async () => {
  const restore = stubEngine({
    createSession: async () => 'sess-chat',
    pushMode: async () => { throw new Error('engine refused mode'); },
  });
  try {
    // The engine defaults to chat on its own, so the session ends up in the
    // state we wanted anyway. Failing here would break the common path for no
    // gain.
    const res = await aiController.setupSession(makeContent('c-mode-chat', 'chat'));
    assert.strictEqual(res.sessionId, 'sess-chat');
  } finally {
    restore();
  }
});

test('a 404 pushMode on a REUSED session recreates and retries instead of failing', async () => {
  // The regression this guards: pushMode is the only fatal push that is not
  // hash-skippable when the mode changes, so on a reused-but-evicted session
  // with an unchanged document and no brief keyword it can be the ONLY 404
  // anyone sees. If setupSession's recreate-retry does not watch it, entering
  // plan mode on an evicted session hard-fails.
  let createCalls = 0;
  let modeCalls = 0;
  const restore = stubEngine({
    createSession: async () => { createCalls++; return `fresh-sess-${createCalls}`; },
    pushMode: async () => {
      modeCalls++;
      if (modeCalls === 1) { const e = new Error('session gone'); e.status = 404; throw e; }
    },
  });
  try {
    aiController.rememberSession('c-mode-404', 'stale-sess');
    const res = await aiController.setupSession(makeContent('c-mode-404', 'plan'), { reuseSession: true });
    assert.strictEqual(modeCalls, 2, 'mode pushed twice (404, then success on the fresh session)');
    assert.strictEqual(createCalls, 1, 'exactly one fresh session created — on the retry only');
    assert.strictEqual(res.sessionId, 'fresh-sess-1', 'returns the recreated session');
  } finally {
    restore();
  }
});

test('a non-404 pushMode failure does NOT retry — it fails once', async () => {
  let createCalls = 0;
  let modeCalls = 0;
  const restore = stubEngine({
    createSession: async () => { createCalls++; return `s-${createCalls}`; },
    pushMode: async () => { modeCalls++; const e = new Error('boom'); e.status = 500; throw e; },
  });
  try {
    aiController.rememberSession('c-mode-500', 'stale-sess');
    await assert.rejects(
      () => aiController.setupSession(makeContent('c-mode-500', 'plan'), { reuseSession: true }),
      /boom/,
    );
    assert.strictEqual(modeCalls, 1, 'a 500 is not a stale session — no recreate, no retry');
    assert.strictEqual(createCalls, 0);
  } finally {
    restore();
  }
});

test('the aggregate failure log prints instead of throwing ReferenceError', async () => {
  // `mode` was declared inside modeTask but read by the log at the bottom of
  // pushPlanModeContext, so every failure path threw a ReferenceError in place
  // of logging — and setupSession swallowed the rejection, hiding that too.
  // The CFS-misconfiguration error line this code exists to emit had never
  // once been printed.
  const savedKey = process.env.INTERNAL_API_KEY;
  delete process.env.INTERNAL_API_KEY; // makes cfsTask push a failure
  const lines = [];
  const savedError = console.error;
  console.error = (...args) => lines.push(args);
  const restore = stubEngine({ createSession: async () => 'sess-log' });
  try {
    const res = await aiController.setupSession(makeContent('c-mode-log', 'chat'));
    assert.strictEqual(res.sessionId, 'sess-log', 'a CFS misconfiguration stays non-fatal');
    const hit = lines.find(([msg]) => String(msg).includes('plan-mode push had failures'));
    assert.ok(hit, 'the failure line was logged');
    assert.strictEqual(hit[1].mode, 'chat', 'and `mode` resolves rather than throwing');
    assert.ok(
      hit[1].failures.some((f) => f.step === 'cfsConfig'),
      'the CFS failure is in the payload',
    );
  } finally {
    console.error = savedError;
    restore();
    if (savedKey !== undefined) process.env.INTERNAL_API_KEY = savedKey;
  }
});
