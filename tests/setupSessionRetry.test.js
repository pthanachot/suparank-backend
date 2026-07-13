'use strict';

// W5-b review (CAVEAT 2): setupSession must recover from a REUSED engine
// session the engine has since evicted (redeploy / engine TTL) by recreating a
// fresh session and retrying the whole push fan-out ONCE — mirroring
// setupSessionLite's stale-session recovery. Autocomplete's bare sessions made
// this pre-existing gap more reachable (a redeploy between "user typed" and
// "user runs an agent" would otherwise 500 the run).
// Internal Mongo lookups inside the fan-out (brand voice, links, plan) reject
// with buffering disabled but are all non-fatal (caught internally), so only
// the stubbed engine pushes drive the outcome.

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

function stubEngine({ pushDocument, createSession }) {
  const saved = { createSession: writingEngine.createSession };
  for (const m of ENGINE_PUSH) saved[m] = writingEngine[m];
  for (const m of ENGINE_PUSH) writingEngine[m] = async () => {};
  writingEngine.pushDocument = pushDocument;
  writingEngine.createSession = createSession;
  return () => {
    writingEngine.createSession = saved.createSession;
    for (const m of ENGINE_PUSH) writingEngine[m] = saved[m];
  };
}

test('setupSession recreates + retries once when a REUSED session 404s', async () => {
  let createCalls = 0;
  let docCalls = 0;
  const restore = stubEngine({
    createSession: async () => { createCalls++; return `new-sess-${createCalls}`; },
    pushDocument: async () => {
      docCalls++;
      if (docCalls === 1) { const e = new Error('session gone'); e.status = 404; throw e; }
    },
  });
  try {
    aiController.rememberSession('c-setup-retry', 'stale-sess'); // seed a reusable entry
    const res = await aiController.setupSession(makeContent('c-setup-retry'), { reuseSession: true });
    assert.strictEqual(docCalls, 2, 'document pushed twice (404 then success)');
    assert.strictEqual(createCalls, 1, 'created exactly one fresh session (only on the retry — initial call reused)');
    assert.strictEqual(res.sessionId, 'new-sess-1', 'returns the recreated session');
    assert.strictEqual(aiController.contentSessionMap.get('c-setup-retry').sessionId, 'new-sess-1', 'map repointed to the fresh session');
  } finally {
    restore();
    aiController.contentSessionMap.delete('c-setup-retry');
  }
});

test('setupSession does NOT retry a FRESH session 404 (cannot recurse) — it throws', async () => {
  let createCalls = 0;
  const restore = stubEngine({
    createSession: async () => { createCalls++; return `fresh-${createCalls}`; },
    pushDocument: async () => { const e = new Error('session gone'); e.status = 404; throw e; },
  });
  try {
    // No seeded entry → setupSession mints a fresh session (reused=false).
    await assert.rejects(
      () => aiController.setupSession(makeContent('c-fresh-404'), { reuseSession: true }),
      /gone|404/,
    );
    assert.strictEqual(createCalls, 1, 'created once, did NOT retry (a fresh session must not loop)');
  } finally {
    restore();
    aiController.contentSessionMap.delete('c-fresh-404');
  }
});
