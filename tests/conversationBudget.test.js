'use strict';

// Conversations Phase 7: the cumulative turn budget, and the economics it exists
// to bound.
//
// WHY THIS FILE MATTERS MORE THAN IT LOOKS. Nothing in the system bounds
// repeated work: every engine budget (max_turns, max_edits, the cumulative token
// ceiling) resets to ZERO on each run; `creditsUsed` is written to three tables
// and read by nobody who blocks; workspaceQuotaService short-circuits on a dark
// flag and always returns null; and the only aggregate USD kill-switch in the
// codebase is a $10/day cap on anonymous public tools that never touches
// /ai/agent. So one repeatable click is an unbounded spend loop unless something
// counts ACROSS runs.
//
// The cost table below is the reason a ceiling is needed at all: the SAME user
// gesture costs 2 or 100 credits depending only on what the client puts in the
// request body. That 50x spread was discovered by reading the billing code; it
// is pinned here so it is never rediscovered by someone's credit balance.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const threadService = require('../src/services/threadService');
const flagService = require('../src/services/flagService');
const FeatureFlag = require('../src/models/FeatureFlag');
const AiThread = require('../src/models/AiThread');
const AiThreadMessage = require('../src/models/AiThreadMessage');
const { classifyAgentRun, isPlanArticleWrite } = require('../src/config/agentBilling');
const { resolveCredits } = require('../src/config/creditRules');

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

// ─── The economics the ceiling exists to bound ───────────────

test('ECONOMIC REGRESSION: the same gesture costs 2 or 100 depending on the body', () => {
  // Every row is a "continue this run" click. Only the request body differs.
  const PLAN_UNWRITTEN = { mode: 'execute', activePlanId: 'P1', articleGeneratedPlanId: null };
  const PLAN_WRITTEN = { mode: 'execute', activePlanId: 'P1', articleGeneratedPlanId: 'P1' };
  const NON_PLAN = { mode: 'chat', activePlanId: null, articleGeneratedPlanId: null };

  const rows = [
    { what: 're-sends intent:auto-write', body: { mode: 'freeform', intent: 'auto-write' }, content: NON_PLAN, expect: 'articleGenerate' },
    { what: 'plain goal, non-plan doc', body: { mode: 'freeform' }, content: NON_PLAN, expect: 'inlineAction' },
    { what: 'plan-execute, prior run WROTE', body: { mode: 'freeform' }, content: PLAN_WRITTEN, expect: 'inlineAction' },
    { what: 'plan-execute, prior run wrote NOTHING', body: { mode: 'freeform' }, content: PLAN_UNWRITTEN, expect: 'articleGenerate' },
  ];

  for (const r of rows) {
    assert.strictEqual(classifyAgentRun(r.body, r.content), r.expect, r.what);
  }

  const cheap = resolveCredits('inlineAction', {});
  const dear = resolveCredits('articleGenerate', {});
  assert.strictEqual(cheap, 2);
  assert.strictEqual(dear, 100);
  assert.strictEqual(dear / cheap, 50, 'the spread a Continue button silently picks between');
});

test('the plan stamp is what flips the price — and it is one-way', () => {
  // A truncated execute run that wrote ANYTHING stamps articleGeneratedPlanId
  // and burns the plan's single paid generation. Every continue after it is 2
  // credits, unslotted and uncapped: a full rewrite for 2 credits, repeatable.
  // Decision §4 #6 is to MEASURE this, not reprice it — so the test pins the
  // behaviour rather than asserting a gate that deliberately does not exist.
  const unwritten = { mode: 'execute', activePlanId: 'P1', articleGeneratedPlanId: null };
  const written = { mode: 'execute', activePlanId: 'P1', articleGeneratedPlanId: 'P1' };
  assert.strictEqual(isPlanArticleWrite(unwritten), true);
  assert.strictEqual(isPlanArticleWrite(written), false,
    'once stamped, the expensive classification never returns for this plan');
});

// ─── The counter ─────────────────────────────────────────────

/** Capture the $inc an appendMessage would issue. */
function stubAppend() {
  const saved = { fou: AiThread.findOneAndUpdate, create: AiThreadMessage.create, upd: AiThread.updateOne };
  const incs = [];
  AiThread.findOneAndUpdate = async (_f, update) => {
    incs.push(update.$inc);
    return { _id: 't1', messageCount: 3, title: 'x' };
  };
  AiThread.updateOne = () => ({ catch: () => {} });
  AiThreadMessage.create = async (d) => d;
  return {
    incs,
    restore: () => { AiThread.findOneAndUpdate = saved.fou; AiThreadMessage.create = saved.create; AiThread.updateOne = saved.upd; },
  };
}

test('an assistant row folds its run turns into the conversation total', async () => {
  const s = stubAppend();
  try {
    await threadService.appendMessage({ _id: 't1', title: 'x' }, {
      kind: 'assistant', text: 'the reply', meta: { channel: 'agent', turns: 14 },
    });
    assert.strictEqual(s.incs[0].turnsUsed, 14);
  } finally { s.restore(); }
});

test('a USER row adds nothing — turns are a property of the run, not the message', async () => {
  const s = stubAppend();
  try {
    await threadService.appendMessage({ _id: 't1', title: 'x' }, {
      kind: 'user', text: 'do the thing', meta: { channel: 'agent', turns: 14 },
    });
    assert.ok(!('turnsUsed' in s.incs[0]),
      'counting both rows of a turn pair would double the whole budget');
  } finally { s.restore(); }
});

test('a COMPACTION row adds nothing — it is bookkeeping, not work the user asked for', async () => {
  const s = stubAppend();
  try {
    await threadService.appendMessage({ _id: 't1', title: 'x' }, {
      kind: 'compaction', text: 'summary of earlier turns', meta: { channel: 'compaction' },
    });
    assert.ok(!('turnsUsed' in s.incs[0]),
      'compaction appends a row and bumps messageCount — it must not bump the budget');
  } finally { s.restore(); }
});

test('side-channel rows carry no turns and are ignored', async () => {
  const s = stubAppend();
  try {
    for (const channel of ['steer', 'clarify', 'plan-confirm']) {
      await threadService.appendMessage({ _id: 't1', title: 'x' }, {
        kind: 'user', text: `note via ${channel}`, meta: { channel },
      });
    }
    assert.ok(s.incs.every((i) => !('turnsUsed' in i)));
  } finally { s.restore(); }
});

test('a malformed turn count never corrupts the tally', async () => {
  const s = stubAppend();
  try {
    for (const turns of [NaN, -5, undefined, 'twelve', Infinity]) {
      await threadService.appendMessage({ _id: 't1', title: 'x' }, {
        kind: 'assistant', text: 'reply', meta: { channel: 'agent', turns },
      });
    }
    assert.ok(s.incs.every((i) => i.turnsUsed === undefined || i.turnsUsed > 0),
      'a NaN or negative $inc would poison the counter permanently');
  } finally { s.restore(); }
});

// ─── The runs that persist nothing ───────────────────────────

test('recordTurns charges a run that filed no message', async () => {
  // appendMessage folds turns in as a side effect of writing the reply, so a run
  // that persists nothing pays nothing — and "start a run, stop it, repeat" is
  // exactly the loop the ceiling exists to bound.
  const saved = AiThread.updateOne;
  let seen = null;
  AiThread.updateOne = async (_f, update) => { seen = update; return { modifiedCount: 1 }; };
  try {
    const charged = await threadService.recordTurns({ _id: 't1' }, 9);
    assert.strictEqual(charged, 9);
    assert.strictEqual(seen.$inc.turnsUsed, 9);
  } finally { AiThread.updateOne = saved; }
});

test('recordTurns is a no-op with no thread, no turns, or junk', async () => {
  const saved = AiThread.updateOne;
  let calls = 0;
  AiThread.updateOne = async () => { calls += 1; return { modifiedCount: 1 }; };
  try {
    assert.strictEqual(await threadService.recordTurns(null, 9), null, 'flag off / no conversation');
    assert.strictEqual(await threadService.recordTurns({ _id: 't1' }, 0), null);
    assert.strictEqual(await threadService.recordTurns({ _id: 't1' }, -3), null);
    assert.strictEqual(await threadService.recordTurns({ _id: 't1' }, NaN), null);
    assert.strictEqual(calls, 0, 'a NaN or negative $inc would poison the counter permanently');
  } finally { AiThread.updateOne = saved; }
});

test('recordTurns never throws — accounting must not break a run that happened', async () => {
  const saved = AiThread.updateOne;
  AiThread.updateOne = async () => { throw new Error('mongo down'); };
  try {
    assert.strictEqual(await threadService.recordTurns({ _id: 't1' }, 5), null);
  } finally { AiThread.updateOne = saved; }
});

// ─── Phase 8: never shadow a live run ────────────────────────

test('a second run is REFUSED while one is in flight, not silently shadowed', async () => {
  // activeAgentRuns.set() on an occupied key orphans the existing entry. The
  // victim is usually a detached run still draining: once unregistered,
  // /ai/run-status reports nothing active, /ai/stop 409s on the sessionId
  // mismatch, and the 30-minute TTL sweep can never abort it — it keeps writing
  // the document, invisible and unstoppable. Continue is clicked at exactly the
  // moment such a twin may be draining.
  const aiController = require('../src/controllers/aiController');
  const existing = { sessionId: 's-live', runId: 'run-A', startedAt: Date.now(), abort() {} };
  aiController.contentSessionMap.delete('c-shadow');
  aiController.activeAgentRuns.set('c-shadow', existing);

  const req = {
    params: { workspaceNumber: '1', contentNumber: '3' },
    user: { userId: 'u1' },
    body: { goal: 'Continue from where the previous run stopped.', mode: 'freeform' },
    on() {},
    _prefetchedContent: {
      _id: { toString: () => 'c-shadow' },
      workspaceId: 'w1', contentNumber: 3, blocks: [{ type: 'p', text: 'body' }], mode: 'chat',
    },
  };
  let status = 200; let payload = null;
  const res = {
    status(s) { status = s; return this; },
    json(p) { payload = p; return this; },
    writeHead() { return this; }, write() { return true; }, end() {},
    get writableEnded() { return false; },
  };

  try {
    await aiController.agent(req, res);
    assert.strictEqual(status, 409, 'must refuse, not proceed');
    assert.strictEqual(payload.code, 'busy');
    assert.strictEqual(aiController.activeAgentRuns.get('c-shadow'), existing,
      'the live run keeps its registry entry — losing it is what makes it unstoppable');
  } finally {
    aiController.activeAgentRuns.delete('c-shadow');
    aiController.contentSessionMap.delete('c-shadow');
  }
});

function makeRunReqRes(contentId, contentNumber) {
  const req = {
    params: { workspaceNumber: '1', contentNumber: String(contentNumber) },
    user: { userId: 'u1' },
    body: { goal: 'Continue from where the previous run stopped.', mode: 'freeform' },
    on() {},
    _prefetchedContent: {
      _id: { toString: () => contentId },
      workspaceId: 'w1', contentNumber, blocks: [{ type: 'p', text: 'body' }], mode: 'chat',
    },
  };
  const out = { status: 200, payload: null };
  const res = {
    status(s) { out.status = s; return this; },
    json(p) { out.payload = p; return this; },
    writeHead() { return this; }, write() { return true; }, end() {},
    get writableEnded() { return false; },
    get headersSent() { return false; },
  };
  return { req, res, out };
}

test('two CONCURRENT runs: exactly one is refused, and neither leaks its slot', async () => {
  // The guard used to be check-then-act. It read activeAgentRuns here and
  // registered ~100 lines and five awaits later — setupSession's 6-8 engine
  // round trips, the credit pre-deduct, the thread read, the user-row append.
  // Two requests inside that multi-second window BOTH saw an empty map, both
  // passed, and the second orphaned the first. Continue makes this routine by
  // being clicked while a detached twin may still be draining.
  //
  // Both runs here fail at setupSession (no engine in tests), which is the
  // point: the refusal must happen before that, and the slot must come back
  // afterwards. A leaked reservation would pin the document until the 30-minute
  // TTL sweep — strictly worse than the shadowing it prevents.
  const aiController = require('../src/controllers/aiController');
  aiController.activeAgentRuns.delete('c-race');
  aiController.contentSessionMap.delete('c-race');

  const a = makeRunReqRes('c-race', 7);
  const b = makeRunReqRes('c-race', 7);
  try {
    // Started without awaiting between them: interleaved exactly as two clicks
    // landing in the same event loop would be.
    await Promise.all([
      aiController.agent(a.req, a.res).catch(() => {}),
      aiController.agent(b.req, b.res).catch(() => {}),
    ]);
    const refused = [a.out, b.out].filter((o) => o.status === 409 && o.payload?.code === 'busy');
    assert.strictEqual(refused.length, 1,
      `exactly one run must be refused as busy, got ${refused.length} — `
      + 'both passing means the slot is still reserved after the awaits, not before them');
    assert.strictEqual(aiController.activeAgentRuns.has('c-race'), false,
      'both runs finished, so the slot must be free — a leaked reservation locks '
      + 'the document out of every agent run until the TTL sweep');
  } finally {
    aiController.activeAgentRuns.delete('c-race');
    aiController.contentSessionMap.delete('c-race');
  }
});

// ─── Reading the budget ──────────────────────────────────────

function stubActiveThread(doc) {
  const saved = AiThread.findOne;
  AiThread.findOne = async () => doc;
  return () => { AiThread.findOne = saved; };
}

test('reports used / remaining / exhausted against the ceiling', async () => {
  const restoreFlag = stubFlag(true);
  const restore = stubActiveThread({ turnsUsed: 40 });
  try {
    const b = await threadService.getConversationBudget('c1');
    assert.strictEqual(b.used, 40);
    assert.strictEqual(b.remaining, b.limit - 40);
    assert.strictEqual(b.exhausted, false);
  } finally { restore(); restoreFlag(); }
});

test('exhausted at or past the ceiling, and remaining never goes negative', async () => {
  const restoreFlag = stubFlag(true);
  const restore = stubActiveThread({ turnsUsed: 10_000 });
  try {
    const b = await threadService.getConversationBudget('c1');
    assert.strictEqual(b.exhausted, true);
    assert.strictEqual(b.remaining, 0, 'a negative remaining would render as "-9850 turns left"');
  } finally { restore(); restoreFlag(); }
});

test('unknown budget is NULL, never "exhausted" — it must not become a wall', async () => {
  // Flag off, no conversation yet, or a Mongo hiccup. Failing closed here would
  // block runs outright on a deployment where threads are simply not enabled.
  const restoreFlagOff = stubFlag(false);
  try {
    assert.strictEqual(await threadService.getConversationBudget('c1'), null);
  } finally { restoreFlagOff(); }

  const restoreFlag = stubFlag(true);
  const restoreNone = stubActiveThread(null);
  try {
    assert.strictEqual(await threadService.getConversationBudget('c1'), null);
  } finally { restoreNone(); restoreFlag(); }

  const restoreFlag2 = stubFlag(true);
  const saved = AiThread.findOne;
  AiThread.findOne = async () => { throw new Error('mongo down'); };
  try {
    assert.strictEqual(await threadService.getConversationBudget('c1'), null);
  } finally { AiThread.findOne = saved; restoreFlag2(); }
});
