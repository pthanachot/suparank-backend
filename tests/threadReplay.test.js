'use strict';

// Threads Phase 2: replay shaper (all 7 binding rules from the plan §5) +
// the seeding invariant in setupSession + chat's secondary-session wiring +
// the engineContent durable tenancy fallback.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const writingEngine = require('../src/services/writingEngine');
const threadService = require('../src/services/threadService');
const aiController = require('../src/controllers/aiController');

const { shapeThreadForReplay } = threadService;

const u = (text, meta = {}) => ({ seq: 0, kind: 'user', text, meta });
const a = (text, meta = {}) => ({ seq: 0, kind: 'assistant', text, meta });

// ─── Rule coverage: shapeThreadForReplay ─────────────────────

test('rule 1/2: plain alternation maps kinds→roles using full text (never displayText)', () => {
  const out = shapeThreadForReplay([
    { kind: 'user', text: 'the full engineered goal', displayText: '/auto-optimize', meta: {} },
    a('I did the thing.'),
  ]);
  assert.deepStrictEqual(out, [
    { role: 'user', content: 'the full engineered goal' },
    { role: 'assistant', content: 'I did the thing.' },
  ]);
});

test('rule 4: consecutive same-role rows coalesce with \\n\\n and channel prefixes', () => {
  const out = shapeThreadForReplay([
    u('Write the intro.'),
    u('make it punchier', { channel: 'steer' }),
    u('B2B readers', { channel: 'clarify' }),
    a('Done.'),
    a('[Run completed: 2 document edits applied.]'),
  ]);
  assert.strictEqual(out.length, 2, 'coalesced to one user + one assistant');
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(
    out[0].content,
    'Write the intro.\n\n[Mid-run steering note] make it punchier\n\n[Answer to the AI\'s question] B2B readers',
  );
  assert.strictEqual(out[1].role, 'assistant');
  assert.match(out[1].content, /^Done\.\n\n\[Run completed/);
});

test('rule 5: a leading assistant orphan is dropped', () => {
  const out = shapeThreadForReplay([a('orphan from a budget cut'), u('hello'), a('hi')]);
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(out.length, 2);
});

test('rule 6: a dangling trailing user (crashed run, D6) is sealed with a synthetic assistant', () => {
  const out = shapeThreadForReplay([u('please write'), a('done'), u('this run crashed')]);
  assert.strictEqual(out[out.length - 1].role, 'assistant');
  assert.match(out[out.length - 1].content, /interrupted before completion/);
});

test('rule 3: compaction leads as a user/assistant pair before the tail', () => {
  const out = shapeThreadForReplay(
    [u('latest question'), a('latest answer')],
    { compaction: { kind: 'compaction', text: 'Earlier: user named the product Zephyr.' } },
  );
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[0].role, 'user');
  assert.match(out[0].content, /^\[Summary of the earlier conversation\]\nEarlier: user named the product Zephyr\./);
  assert.strictEqual(out[1].role, 'assistant');
  assert.match(out[1].content, /continuing from that context/);
  assert.strictEqual(out[2].content, 'latest question');
});

test('rule 3: compaction with an empty tail still yields a valid pair', () => {
  const out = shapeThreadForReplay([], { compaction: { kind: 'compaction', text: 'summary' } });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(out[1].role, 'assistant');
});

test('rule 7: token budget keeps the NEWEST rows and the result still starts with user', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(u(`question ${i} ` + 'x'.repeat(4000)));  // ~1k tokens each
    rows.push(a(`answer ${i} ` + 'y'.repeat(4000)));
  }
  const out = shapeThreadForReplay(rows);
  const est = out.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  assert.ok(est <= 24000 + 1200, `budget respected (est=${est})`);
  assert.strictEqual(out[0].role, 'user', 'starts with user after the cut');
  assert.match(out[out.length - 1].content, /answer 39/, 'newest row survives');
  assert.ok(!out.some((m) => m.content.includes('question 0 ')), 'oldest rows dropped');
});

test('P3 review BUG-1(b): with a compaction, a leading assistant KEEP row merges into the pair (never dropped)', () => {
  const out = shapeThreadForReplay(
    [a('(run summary: 5 document edits were applied)'), u('next ask'), a('next reply')],
    { compaction: { kind: 'compaction', text: 'summary text' } },
  );
  assert.strictEqual(out[0].role, 'user', 'pair leads');
  assert.strictEqual(out[1].role, 'assistant');
  assert.match(out[1].content, /Understood — continuing from that context\.\n\n\(run summary: 5 document edits were applied\)/,
    'the boundary-orphan reply survives inside the pair');
  assert.strictEqual(out[2].content, 'next ask');
  // Alternation preserved throughout.
  for (let i = 1; i < out.length; i++) assert.notStrictEqual(out[i].role, out[i - 1].role);
});

test('P3 review BUG-2(int): the truncation note fires WITH a compaction present (the hole sits between summary and tail)', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push(u(`q${i} ` + 'x'.repeat(4000)));
    rows.push(a(`r${i} ` + 'y'.repeat(4000)));
  }
  const out = shapeThreadForReplay(rows, { compaction: { kind: 'compaction', text: 'old summary' } });
  // First TAIL user message (index 2, after the pair) carries the note.
  assert.match(out[2].content, /^\[Note: some earlier messages in this conversation are not shown here\.\]/,
    'post-compaction budget cut must be visible to the model');
});

test('P3 lifecycle CAVEAT-2: forceTruncatedNote surfaces a DB-window clip even under budget', () => {
  const out = shapeThreadForReplay([u('only ask'), a('only reply')], { forceTruncatedNote: true });
  assert.match(out[0].content, /^\[Note: some earlier messages/);
});

test('compaction-kind rows inside `messages` are ignored (only the explicit compaction param leads)', () => {
  const out = shapeThreadForReplay([
    { kind: 'compaction', text: 'stray summary row', meta: {} },
    u('hi'), a('hello'),
  ]);
  assert.strictEqual(out.length, 2);
  assert.ok(!out.some((m) => m.content.includes('stray')));
});

test('empty / no usable rows → []', () => {
  assert.deepStrictEqual(shapeThreadForReplay([]), []);
  assert.deepStrictEqual(shapeThreadForReplay([{ kind: 'user', text: '', meta: {} }]), []);
});

// ─── Seeding invariant (setupSession fan-out task) ───────────

const ENGINE_PUSH = ['pushDocument', 'pushBrief', 'pushContextFiles', 'pushBrandVoice', 'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig'];

function makeContent(id) {
  return {
    _id: { toString: () => id },
    workspaceId: 'w1',
    contentNumber: 9,
    blocks: [{ type: 'p', text: 'Doc body for the seed tests.' }],
    mode: 'chat',
  };
}

function stubAll({ stamp, payload, seedImpl } = {}) {
  const saved = {
    createSession: writingEngine.createSession,
    seedMessages: writingEngine.seedMessages,
    getActiveThreadStamp: threadService.getActiveThreadStamp,
    getReplayPayload: threadService.getReplayPayload,
  };
  for (const m of ENGINE_PUSH) { saved[m] = writingEngine[m]; writingEngine[m] = async () => {}; }
  let createCalls = 0;
  const seedCalls = [];
  writingEngine.createSession = async () => { createCalls++; return `p2-sess-${createCalls}`; };
  writingEngine.seedMessages = seedImpl || (async (sid, msgs) => { seedCalls.push({ sid, count: msgs.length }); return { count: msgs.length }; });
  threadService.getActiveThreadStamp = async () => stamp ?? null;
  threadService.getReplayPayload = async () => payload ?? null;
  return {
    createCalls: () => createCalls,
    seedCalls,
    restore() {
      for (const m of ENGINE_PUSH) writingEngine[m] = saved[m];
      writingEngine.createSession = saved.createSession;
      writingEngine.seedMessages = saved.seedMessages;
      threadService.getActiveThreadStamp = saved.getActiveThreadStamp;
      threadService.getReplayPayload = saved.getReplayPayload;
    },
  };
}

const SHAPED = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];

test('fresh session with thread history → seeds; marker records what was REPLAYED (payload), not the stamp', async () => {
  // Review BUG-2 companion: stamp (allocator high-water 5) deliberately
  // DIVERGES from the payload (max real row 4 — e.g. a racing append whose
  // row hasn't landed). The marker must record 4: claiming 5 would skip a
  // row the seed never contained.
  const s = stubAll({ stamp: { threadId: 'T1', lastSeq: 5 }, payload: { threadId: 'T1', lastSeq: 4, messages: SHAPED } });
  try {
    await aiController.setupSession(makeContent('c-p2-fresh'), {});
    assert.strictEqual(s.seedCalls.length, 1, 'fresh session seeded');
    const entry = aiController.contentSessionMap.get('c-p2-fresh');
    assert.deepStrictEqual(entry.seeded, { threadId: 'T1', seq: 4 }, 'marker = payload.lastSeq (actually replayed), never the stamp');
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-fresh'); }
});

test('review BUG-1: a NON-memory run (sequential) neither seeds nor sets a marker', async () => {
  const s = stubAll({ stamp: { threadId: 'T1', lastSeq: 5 }, payload: { threadId: 'T1', lastSeq: 5, messages: SHAPED } });
  try {
    // Sequential shape: reuseSession false, memoryRun false.
    await aiController.setupSession(makeContent('c-p2-seq'), { memoryRun: false });
    assert.strictEqual(s.seedCalls.length, 0, 'engine wipes sequential history — seeding it is waste AND poisons the marker');
    const entry = aiController.contentSessionMap.get('c-p2-seq');
    assert.strictEqual(entry.seeded, undefined, 'no marker → the NEXT freeform run re-seeds over the wiped history');
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-seq'); }
});

test('review BUG-2: the marker bump requires CONTIGUITY — foreign interleaved rows block it', () => {
  const cid = 'c-p2-bump';
  aiController.rememberSession(cid, 'sess-b');
  const entry = aiController.contentSessionMap.get(cid);
  entry.seeded = { threadId: 'T1', seq: 10 };
  try {
    // Pristine case: marker 10 → user 11 → assistant 12. Bumps.
    assert.strictEqual(
      aiController.maybeBumpSeededMarker(cid, 'sess-b', { seq: 11, threadId: 'T1' }, { seq: 12, threadId: 'T1' }),
      true,
    );
    assert.strictEqual(entry.seeded.seq, 12);

    // Interleaved case: a second tab's chat rows took 13/14; this run's pair
    // is 15/16 — the interval (12,16] contains foreign rows. NO bump: an
    // advance would hide the chat turn from the warm session indefinitely.
    assert.strictEqual(
      aiController.maybeBumpSeededMarker(cid, 'sess-b', { seq: 15, threadId: 'T1' }, { seq: 16, threadId: 'T1' }),
      false,
    );
    assert.strictEqual(entry.seeded.seq, 12, 'marker stays stale → next run re-seeds (correct)');

    // Cross-thread and wrong-session guards.
    assert.strictEqual(aiController.maybeBumpSeededMarker(cid, 'other-sess', { seq: 13, threadId: 'T1' }, { seq: 14, threadId: 'T1' }), false);
    assert.strictEqual(aiController.maybeBumpSeededMarker(cid, 'sess-b', { seq: 13, threadId: 'T2' }, { seq: 14, threadId: 'T2' }), false);
    // Missing user append (create failure) → no bump.
    assert.strictEqual(aiController.maybeBumpSeededMarker(cid, 'sess-b', null, { seq: 13, threadId: 'T1' }), false);
  } finally {
    aiController.contentSessionMap.delete(cid);
  }
});

test('warm reuse with a CURRENT marker → seed skipped', async () => {
  const s = stubAll({ stamp: { threadId: 'T1', lastSeq: 5 }, payload: { threadId: 'T1', lastSeq: 5, messages: SHAPED } });
  try {
    await aiController.setupSession(makeContent('c-p2-warm'), {});           // run 1: seeds
    await aiController.setupSession(makeContent('c-p2-warm'), { reuseSession: true }); // run 2: warm
    assert.strictEqual(s.seedCalls.length, 1, 'second (warm, same thread+seq) run must NOT re-seed');
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-warm'); }
});

test('warm reuse with a STALE seq (chat advanced the thread) → re-seeds', async () => {
  const s = stubAll({ stamp: { threadId: 'T1', lastSeq: 9 }, payload: { threadId: 'T1', lastSeq: 9, messages: SHAPED } });
  try {
    aiController.rememberSession('c-p2-stale', 'warm-sess');
    const entry = aiController.contentSessionMap.get('c-p2-stale');
    entry.seeded = { threadId: 'T1', seq: 5 }; // marker behind the thread
    // stub createSession is irrelevant — reuse path keeps warm-sess
    await aiController.setupSession(makeContent('c-p2-stale'), { reuseSession: true });
    assert.strictEqual(s.seedCalls.length, 1, 're-seeded');
    assert.strictEqual(s.seedCalls[0].sid, 'warm-sess');
    assert.deepStrictEqual(entry.seeded, { threadId: 'T1', seq: 9 }, 'marker advanced');
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-stale'); }
});

test('warm reuse with a DIFFERENT threadId (New conversation) → re-seeds', async () => {
  const s = stubAll({ stamp: { threadId: 'T2', lastSeq: 0 }, payload: { threadId: 'T2', lastSeq: 0, messages: SHAPED } });
  try {
    aiController.rememberSession('c-p2-switch', 'warm-sess-2');
    aiController.contentSessionMap.get('c-p2-switch').seeded = { threadId: 'T1', seq: 50 };
    await aiController.setupSession(makeContent('c-p2-switch'), { reuseSession: true });
    assert.strictEqual(s.seedCalls.length, 1, 'thread switch forces re-seed despite higher old seq');
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-switch'); }
});

test('no thread (stamp null) → no seed call, setup succeeds', async () => {
  const s = stubAll({ stamp: null, payload: null });
  try {
    const r = await aiController.setupSession(makeContent('c-p2-none'), {});
    assert.ok(r.sessionId);
    assert.strictEqual(s.seedCalls.length, 0);
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-none'); }
});

test('seed failure (non-404) is FATAL — setupSession throws', async () => {
  const s = stubAll({
    stamp: { threadId: 'T1', lastSeq: 2 },
    payload: { threadId: 'T1', lastSeq: 2, messages: SHAPED },
    seedImpl: async () => { const e = new Error('seed blew up'); e.status = 500; throw e; },
  });
  try {
    await assert.rejects(
      () => aiController.setupSession(makeContent('c-p2-fatal'), {}),
      /seed blew up/,
      'memory is a contract — an amnesiac run must not start silently',
    );
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-fatal'); }
});

test('chat secondary session joins the tenancy set WITHOUT dethroning the primary', async () => {
  const s = stubAll({ stamp: null, payload: null });
  try {
    aiController.rememberSession('c-p2-sec', 'agent-primary');
    const { sessionId } = await aiController.setupSession(makeContent('c-p2-sec'), { secondary: true });
    const entry = aiController.contentSessionMap.get('c-p2-sec');
    assert.strictEqual(entry.sessionId, 'agent-primary', 'primary untouched — chat no longer truncates agent memory');
    assert.ok(entry.sessionIds.has(sessionId), 'chat session still tenancy-bound (clarify/steer work)');
    assert.notStrictEqual(sessionId, 'agent-primary', 'chat got its own fresh session');
  } finally { s.restore(); aiController.contentSessionMap.delete('c-p2-sec'); }
});

// ─── engineContent durable tenancy fallback ──────────────────

test('engineContent accepts a session the DURABLE thread has seen when the map is cold', async () => {
  const savedSeen = threadService.sessionSeenForContent;
  const savedGet = writingEngine.getContent;
  const savedFind = require('../src/models/Content').findByNumber;
  const Content = require('../src/models/Content');
  threadService.sessionSeenForContent = async (cid, sid) => sid === 'restart-survivor';
  writingEngine.getContent = async () => ({ title: 'T', content: '# doc', wordCount: 2 });
  Content.findByNumber = async () => makeContent('c-p2-tenancy');
  const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  try {
    // Map is cold (no rememberSession for this content) — pre-P2 this 409'd.
    let res = mkRes();
    await aiController.engineContent({ params: { contentNumber: '9' }, query: { sessionId: 'restart-survivor' }, workspace: { _id: 'w1' } }, res);
    assert.strictEqual(res.statusCode, 200, 'durable fallback accepts the session');
    assert.strictEqual(res.body.content, '# doc');
    // An unknown session still 409s (fail closed).
    res = mkRes();
    await aiController.engineContent({ params: { contentNumber: '9' }, query: { sessionId: 'stranger' }, workspace: { _id: 'w1' } }, res);
    assert.strictEqual(res.statusCode, 409);
  } finally {
    threadService.sessionSeenForContent = savedSeen;
    writingEngine.getContent = savedGet;
    Content.findByNumber = savedFind;
  }
});
