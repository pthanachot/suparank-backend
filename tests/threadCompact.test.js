'use strict';

// Threads Phase 3: compaction trigger + the coversThroughSeq replay-window
// contract. maybeCompactThread's inner appendMessage is a module-local call,
// so stubs live at the MODEL layer (AiThread/AiThreadMessage statics) like
// the capture tests.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const threadService = require('../src/services/threadService');
const writingEngine = require('../src/services/writingEngine');
const costLedger = require('../src/services/costLedgerService');
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

const CONTENT = { _id: new mongoose.Types.ObjectId(), workspaceId: new mongoose.Types.ObjectId() };

function row(seq, kind, text, meta = {}) {
  return { seq, kind, text, meta, threadId: 'T1' };
}

/**
 * Full-stack stub harness for maybeCompactThread.
 * threadDoc: the active AiThread; candidates: rows returned for the window;
 * prevCompaction: newest compaction row; compactImpl: writingEngine.compact.
 */
function harness({ threadDoc, candidates = [], prevCompaction = null, compactImpl } = {}) {
  const saved = {
    tFindOne: AiThread.findOne,
    tFindById: AiThread.findById,
    tUpdateOne: AiThread.updateOne,
    tFindOneAndUpdate: AiThread.findOneAndUpdate,
    mFindOne: AiThreadMessage.findOne,
    mFind: AiThreadMessage.find,
    mCreate: AiThreadMessage.create,
    compact: writingEngine.compact,
    cogs: costLedger.recordForWorkspace,
  };
  const calls = { compact: [], created: [], threadUpdates: [], cogs: [] };

  AiThread.findOne = async () => threadDoc || null;
  AiThread.findById = () => ({ select: () => ({ lean: async () => ({ tokenEstimate: (threadDoc?.tokenEstimate || 0) + 100 }) }) });
  AiThread.updateOne = async (f, u) => { calls.threadUpdates.push(u); return { modifiedCount: 1 }; };
  // appendMessage's allocator (for the compaction row append).
  AiThread.findOneAndUpdate = async () => ({ _id: 'T1', title: 't', messageCount: (threadDoc?.messageCount || 0) + 1 });
  AiThreadMessage.findOne = async (filter) => (filter.kind === 'compaction' ? prevCompaction : null);
  AiThreadMessage.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => candidates }) }) });
  AiThreadMessage.create = async (doc) => { calls.created.push(doc); return doc; };
  costLedger.recordForWorkspace = (p) => { calls.cogs.push(p); return Promise.resolve(null); };
  writingEngine.compact = async (args) => {
    calls.compact.push(args);
    if (compactImpl) return compactImpl(args);
    return { summary: 'the summary', usage: { model: 'google/gemini-2.5-flash-lite', input_tokens: 500, output_tokens: 80 } };
  };

  return {
    calls,
    restore() {
      AiThread.findOne = saved.tFindOne;
      AiThread.findById = saved.tFindById;
      AiThread.updateOne = saved.tUpdateOne;
      AiThread.findOneAndUpdate = saved.tFindOneAndUpdate;
      AiThreadMessage.findOne = saved.mFindOne;
      AiThreadMessage.find = saved.mFind;
      AiThreadMessage.create = saved.mCreate;
      writingEngine.compact = saved.compact;
      costLedger.recordForWorkspace = saved.cogs;
    },
  };
}

function bigThread(overrides = {}) {
  return {
    _id: 'T1',
    workspaceId: CONTENT.workspaceId,
    messageCount: 20,
    tokenEstimate: 30000,
    tokenEstimateAtCompaction: 0,
    lastCompactionSeq: -1,
    title: 't',
    ...overrides,
  };
}

function manyCandidates(n, startSeq = 0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(row(startSeq + i, i % 2 === 0 ? 'user' : 'assistant', `msg ${startSeq + i}`));
  }
  return rows;
}

test('below both thresholds → no-op', async () => {
  const restore = stubFlag(true);
  const h = harness({ threadDoc: bigThread({ tokenEstimate: 100, messageCount: 5 }) });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.strictEqual(r, null);
    assert.strictEqual(h.calls.compact.length, 0);
  } finally { h.restore(); restore(); }
});

test('token trigger fires: compacts all but the newest KEEP_LAST rows, writes coversThroughSeq', async () => {
  const restore = stubFlag(true);
  const h = harness({ threadDoc: bigThread(), candidates: manyCandidates(20) });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r, 'compaction ran');
    // 20 candidates − keep 8 = 12 compacted; coversThroughSeq = seq 11.
    assert.strictEqual(h.calls.compact[0].messages.length, 12);
    assert.strictEqual(r.coversThroughSeq, 11);
    const compactionRow = h.calls.created.find((d) => d.kind === 'compaction');
    assert.ok(compactionRow, 'compaction row appended');
    assert.strictEqual(compactionRow.meta.coversThroughSeq, 11);
    assert.strictEqual(compactionRow.text, 'the summary');
    // Trigger bookkeeping updated.
    const upd = h.calls.threadUpdates.find((u) => u.$set && 'lastCompactionSeq' in u.$set);
    assert.ok(upd, 'thread bookkeeping updated');
    assert.ok(upd.$set.tokenEstimateAtCompaction > 0, 'token baseline reset');
    // COGS-only.
    assert.strictEqual(h.calls.cogs.length, 1);
    assert.strictEqual(h.calls.cogs[0].action, 'threadCompact');
  } finally { h.restore(); restore(); }
});

test('message-count trigger fires independently of tokens', async () => {
  const restore = stubFlag(true);
  const h = harness({
    threadDoc: bigThread({ tokenEstimate: 500, messageCount: 70 }),
    candidates: manyCandidates(30),
  });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r, 'msg-count trigger compacted');
  } finally { h.restore(); restore(); }
});

test('chained compaction passes the previous summary and windows after coversThroughSeq', async () => {
  const restore = stubFlag(true);
  const prev = row(10, 'compaction', 'earlier summary', { coversThroughSeq: 5 });
  const h = harness({
    threadDoc: bigThread({ lastCompactionSeq: 10, tokenEstimateAtCompaction: 0, tokenEstimate: 60000 }),
    prevCompaction: prev,
    candidates: manyCandidates(15, 11),
  });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r);
    assert.strictEqual(h.calls.compact[0].previousSummary, 'earlier summary', 'summaries chain');
    // 15 − keep 8 = 7, +1 boundary alignment (candidates[7] is an assistant
    // row — the kept window must start at a user row, BUG-1(a)).
    assert.strictEqual(h.calls.compact[0].messages.length, 8);
  } finally { h.restore(); restore(); }
});

test('too few compactable rows → no-op even when the trigger fired', async () => {
  const restore = stubFlag(true);
  const h = harness({ threadDoc: bigThread(), candidates: manyCandidates(10) }); // 10−8=2 < MIN 4
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.strictEqual(r, null);
    assert.strictEqual(h.calls.compact.length, 0);
  } finally { h.restore(); restore(); }
});

test('engine rejection (e.g. truncated summary) appends NOTHING and retries later', async () => {
  const restore = stubFlag(true);
  const h = harness({
    threadDoc: bigThread(),
    candidates: manyCandidates(20),
    compactImpl: async () => ({ error: 'summary truncated at max tokens — rejected' }),
  });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.strictEqual(r, null);
    assert.strictEqual(h.calls.created.length, 0, 'no row on rejection');
    assert.strictEqual(h.calls.threadUpdates.length, 0, 'no bookkeeping on rejection');
  } finally { h.restore(); restore(); }
});

test('concurrent triggers on one thread: second call no-ops while the first is in flight', async () => {
  const restore = stubFlag(true);
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    threadDoc: bigThread(),
    candidates: manyCandidates(20),
    compactImpl: async () => { await gate; return { summary: 's', usage: { model: 'm', input_tokens: 1, output_tokens: 1 } }; },
  });
  try {
    const p1 = threadService.maybeCompactThread(CONTENT);
    await new Promise((r) => setTimeout(r, 20)); // let p1 claim the in-flight guard
    const r2 = await threadService.maybeCompactThread(CONTENT);
    assert.strictEqual(r2, null, 'second concurrent trigger must no-op');
    release();
    const r1 = await p1;
    assert.ok(r1, 'first completes normally');
    assert.strictEqual(h.calls.compact.length, 1, 'exactly one engine call');
  } finally { h.restore(); restore(); }
});

// ─── P3 review fixes ─────────────────────────────────────────

test('review BUG-2(eng)/BUG-1(lc): span is TOKEN-BUDGETED — oldest bite first, remainder next pass', async () => {
  const restore = stubFlag(true);
  // 30 rows × ~2500 tokens each (10k chars) — far over the 20k budget.
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(row(i, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(10000)));
  const h = harness({ threadDoc: bigThread({ tokenEstimate: 90000 }), candidates: rows });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r, 'compacted a bite');
    const sent = h.calls.compact[0].messages;
    assert.ok(sent.length < 22, `bite bounded, got ${sent.length} rows`);
    const sentTokens = sent.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
    assert.ok(sentTokens < 30000, `bite ~budget-bound (${sentTokens} est tokens)`);
    assert.strictEqual(r.coversThroughSeq, sent.length - 1, 'coverage = last row of the BITE, not the full span');
    // Partial pass keeps the token baseline HOT so the backlog drains next run.
    const upd = h.calls.threadUpdates.find((u) => u.$set && 'lastCompactionSeq' in u.$set);
    assert.ok(!('tokenEstimateAtCompaction' in upd.$set), 'partial bite must NOT reset the token baseline');
  } finally { h.restore(); restore(); }
});

test('review BUG-1(int): the keep boundary never starts with an assistant row', async () => {
  const restore = stubFlag(true);
  // 20 rows where candidates[12] (the would-be first keep) is 'assistant'.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i, i === 12 ? 'assistant' : (i % 2 === 0 ? 'user' : 'assistant'), `m${i}`));
  const h = harness({ threadDoc: bigThread(), candidates: rows });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r);
    // Base split = 12 rows; boundary alignment must PULL row 12 (assistant)
    // into the span so the kept window starts at a user row.
    assert.ok(r.coversThroughSeq >= 12, `boundary extended past the mid-pair assistant (coversThroughSeq=${r.coversThroughSeq})`);
    assert.notStrictEqual(rows[r.coversThroughSeq + 1]?.kind, 'assistant', 'first kept row is never assistant');
  } finally { h.restore(); restore(); }
});

test('review BUG-3(eng): truncated summary escalates maxTokens to 2000 ONCE within the pass', async () => {
  const restore = stubFlag(true);
  let calls = 0;
  const h = harness({
    threadDoc: bigThread(),
    candidates: manyCandidates(20),
    compactImpl: async (args) => {
      calls++;
      if (calls === 1) return { error: 'summary truncated at max tokens — rejected (would silently lose facts)', usage: { model: 'm', input_tokens: 100, output_tokens: 50 } };
      assert.strictEqual(args.maxTokens, 2000, 'escalated budget on retry');
      return { summary: 'escalated summary', usage: { model: 'm', input_tokens: 100, output_tokens: 900 } };
    },
  });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r, 'second attempt persisted');
    assert.strictEqual(calls, 2);
    // COGS for BOTH attempts (failed one flagged).
    assert.strictEqual(h.calls.cogs.length, 2);
    assert.strictEqual(h.calls.cogs[0].metadata.failed, true);
    assert.ok(!h.calls.cogs[1].metadata.failed);
  } finally { h.restore(); restore(); }
});

test('archived mid-flight: allocator miss → summary dropped, no bookkeeping, failed-COGS only', async () => {
  const restore = stubFlag(true);
  const h = harness({ threadDoc: bigThread(), candidates: manyCandidates(20) });
  AiThread.findOneAndUpdate = async () => null; // status:'active' filter misses
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.strictEqual(r, null);
    assert.strictEqual(h.calls.created.length, 0, 'no compaction row on an archived thread');
    assert.strictEqual(h.calls.threadUpdates.length, 0, 'no bookkeeping');
  } finally { h.restore(); restore(); }
});

test('mock-test review: LEGACY blank rows are filtered from the compact payload (anti-wedge)', async () => {
  const restore = stubFlag(true);
  const rows = manyCandidates(20);
  rows[3] = row(3, 'user', '   \n '); // persisted before the trim guard shipped
  const h = harness({ threadDoc: bigThread(), candidates: rows });
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.ok(r, 'compaction proceeds');
    const sent = h.calls.compact[0].messages;
    assert.ok(sent.every((m) => m.content.trim()), 'no blank message ships (engine would 400 the whole span forever)');
    assert.ok(r.coversThroughSeq >= 3, 'coverage advances PAST the blank row');
  } finally { h.restore(); restore(); }
});

test('mock-test review B4c: truncation note rides the pair when the tail has no user row', () => {
  // assistant-only tail + budget cut + compaction — the note used to vanish.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row(i, 'assistant', `reply ${i} ` + 'y'.repeat(12000)));
  const { shapeThreadForReplay } = threadService;
  const out = shapeThreadForReplay(rows, { compaction: { kind: 'compaction', text: 'the summary' } });
  assert.strictEqual(out[0].role, 'user');
  assert.match(out[0].content, /\[Note: some earlier messages in this conversation are not shown here\.\]/,
    'clip stays visible via the pair when no user tail message exists');
});

test('review BUG-2(lc): appendMessage refuses whitespace-only text (compact/seed wedge)', async () => {
  const saved = AiThread.findOneAndUpdate;
  AiThread.findOneAndUpdate = async () => { throw new Error('must not be reached'); };
  try {
    const r = await threadService.appendMessage({ _id: 't1', title: 't' }, { kind: 'user', text: '   \n  ' });
    assert.strictEqual(r, null, 'blank row must never persist');
  } finally { AiThread.findOneAndUpdate = saved; }
});

test('never throws: any unexpected model error is swallowed (fire-and-forget contract)', async () => {
  const restore = stubFlag(true);
  const saved = AiThread.findOne;
  AiThread.findOne = async () => { throw new Error('mongo down'); };
  try {
    const r = await threadService.maybeCompactThread(CONTENT);
    assert.strictEqual(r, null);
  } finally { AiThread.findOne = saved; restore(); }
});

// ─── Replay window contract (P3 correction of the P2 BUG-3 fix) ─────────

test('getReplayPayload windows on coversThroughSeq — keep-last rows appended BEFORE the compaction row survive', async () => {
  const restore = stubFlag(true);
  const savedTFindOne = AiThread.findOne;
  const savedMFindOne = AiThreadMessage.findOne;
  const savedMFind = AiThreadMessage.find;
  // Thread: rows 0..5 summarized (coversThroughSeq=5), rows 6..9 kept
  // verbatim, compaction row at seq 10, then rows 11..12 after it.
  AiThread.findOne = async () => ({ _id: 'T1', messageCount: 13, lastCompactionSeq: 10, status: 'active' });
  AiThreadMessage.findOne = async (filter) =>
    (filter.kind === 'compaction' ? row(10, 'compaction', 'the earlier summary', { coversThroughSeq: 5 }) : null);
  let seenFilter = null;
  AiThreadMessage.find = (filter) => {
    seenFilter = filter;
    // rows with seq > 5: the kept-verbatim 6..9, the compaction row 10, and 11..12
    const rows = [
      row(9, 'assistant', 'kept reply'), row(10, 'compaction', 'the earlier summary', { coversThroughSeq: 5 }),
      row(12, 'assistant', 'newest reply'), row(11, 'user', 'newest ask'),
      row(6, 'user', 'kept ask'), row(7, 'assistant', 'kept reply 2'), row(8, 'user', 'kept ask 2'),
    ].filter((r) => r.seq > filter.seq.$gt).sort((a, b) => b.seq - a.seq);
    return { sort: () => ({ limit: () => ({ lean: async () => rows }) }) };
  };
  try {
    const payload = await threadService.getReplayPayload('cid');
    assert.strictEqual(seenFilter.seq.$gt, 5, 'window = seq > coversThroughSeq, NOT > compaction row seq');
    const texts = payload.messages.map((m) => m.content).join(' | ');
    assert.match(texts, /kept ask/, 'keep-last verbatim rows (appended before the compaction row) survive replay');
    assert.match(texts, /newest reply/);
    assert.match(payload.messages[0].content, /\[Summary of the earlier conversation\]\nthe earlier summary/, 'summary leads');
    const summaryOccurrences = texts.split('the earlier summary').length - 1;
    assert.strictEqual(summaryOccurrences, 1, 'summary appears ONLY in the leading pair — the compaction row in the window is filtered, not duplicated into the tail');
    assert.strictEqual(payload.lastSeq, 12);
  } finally {
    AiThread.findOne = savedTFindOne;
    AiThreadMessage.findOne = savedMFindOne;
    AiThreadMessage.find = savedMFind;
    restore();
  }
});
