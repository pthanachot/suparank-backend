/**
 * QA Nov 2026 stress pass — credit settlement END TO END through the real
 * aiController.chat() / agent() with a mocked writing-engine SSE stream and a
 * mock LEDGER (not just "the last settle call"). Every scenario asserts the
 * three ledger invariants on top of its own expected charge:
 *
 *   I1  a reservation is closed EXACTLY ONCE (one settle or one refund, never
 *       both, never two) whenever one was opened;
 *   I2  the charge is within [0, reserved] (settle can only refund);
 *   I3  no close is attempted when nothing was reserved.
 *
 * Product rules under test (owner decisions, not relitigated here):
 *   - a run that writes nothing to the document charges 0 (chat and agent,
 *     images included);
 *   - chat is priced on the largest single-turn input (<=8K → 1, else 2);
 *   - an errored run that DID write keeps its class charge (computeSettlement).
 * No DB, no network.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const aiController = require('../src/controllers/aiController');
const writingEngine = require('../src/services/writingEngine');
const tierService = require('../src/services/tierService');
const creditService = require('../src/services/creditService');
const threadService = require('../src/services/threadService');
const systemSettings = require('../src/services/systemSettingsService');
const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const BrandVoice = require('../src/models/BrandVoice');
const Avatar = require('../src/models/Avatar');
const Plan = require('../src/models/Plan');
const UsageTracker = require('../src/models/UsageTracker');
const UserUsageTracker = require('../src/models/UserUsageTracker');

const tick = () => new Promise((r) => setImmediate(r));

// ─── fake engine stream ─────────────────────────────────────────

/**
 * script: an array of steps. A step is
 *   - an event object  → one SSE frame
 *   - { raw: '...' }   → raw bytes (malformed lines, split frames)
 *   - { throw: Error } → reader.read() rejects (transport failure)
 *   - { fn: () => {} } → side effect between frames (close the client, abort…)
 * After the script the stream ends ({done:true}) unless a step threw.
 */
function scriptedBody(script, signalRef) {
  let i = 0;
  let cancelled = false;
  return {
    getReader: () => ({
      read: async () => {
        while (i < script.length) {
          const step = script[i++];
          if (step && step.fn) { step.fn(); continue; }
          if (step && step.throw) throw step.throw;
          // A real fetch body errors as soon as its signal aborts.
          if (signalRef.signal?.aborted) {
            const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e;
          }
          if (cancelled) return { done: true };
          const raw = step && step.raw !== undefined ? step.raw : `data: ${JSON.stringify(step)}\n\n`;
          return { done: false, value: Buffer.from(raw) };
        }
        if (signalRef.signal?.aborted) {
          const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e;
        }
        return { done: true };
      },
      cancel: async () => { cancelled = true; },
    }),
  };
}

// ─── harness ────────────────────────────────────────────────────

function makeLedger() {
  const calls = [];
  let nextId = 1;
  const txs = new Map();
  return {
    calls,
    txs,
    preDeduct: async (_org, _user, amount) => {
      const id = `tx${nextId++}`;
      txs.set(id, { reserved: amount, status: 'pending', charged: null });
      calls.push({ op: 'preDeduct', id, amount });
      return { transactionId: id };
    },
    settle: async (id, actual) => {
      calls.push({ op: 'settle', id, actual });
      const tx = txs.get(id);
      if (!tx || tx.status !== 'pending') return { refunded: 0 };
      tx.status = 'settled';
      tx.charged = Math.min(actual, tx.reserved);
      return { refunded: tx.reserved - tx.charged };
    },
    refund: async (id) => {
      calls.push({ op: 'refund', id });
      const tx = txs.get(id);
      if (!tx || tx.status !== 'pending') return { refunded: 0 };
      tx.status = 'refunded';
      tx.charged = 0;
      return { refunded: tx.reserved };
    },
  };
}

function assertLedgerInvariants(ledger, label = '') {
  const closes = ledger.calls.filter((c) => c.op === 'settle' || c.op === 'refund');
  if (ledger.txs.size === 0) {
    assert.equal(closes.length, 0, `${label} I3: closed a reservation that was never opened`);
    return;
  }
  for (const [id, tx] of ledger.txs) {
    const mine = closes.filter((c) => c.id === id);
    assert.equal(mine.length, 1, `${label} I1: tx ${id} closed ${mine.length} times (${JSON.stringify(mine)})`);
    assert.notEqual(tx.status, 'pending', `${label} I1: tx ${id} left pending`);
    const cap = Number(tx.reserved) || 0;
    assert.ok(tx.charged >= 0 && tx.charged <= cap, `${label} I2: charged ${tx.charged} of ${tx.reserved}`);
  }
}

const charged = (ledger) => {
  const [tx] = [...ledger.txs.values()];
  return tx ? tx.charged : null;
};

function makeRes() {
  const res = {
    statusCode: 200, jsonBody: null, headersSent: false, chunks: [], ended: false, writableEnded: false,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.jsonBody = b; res.ended = true; return res; },
    writeHead(c) { res.statusCode = c; res.headersSent = true; },
    write(c) { if (res.writableEnded) throw new Error('write after end'); res.chunks.push(String(c)); },
    end() { res.ended = true; res.writableEnded = true; },
  };
  return res;
}

const sseEvents = (res) => res.chunks.join('').split('\n')
  .filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return { unparsed: l }; } });

let current = null;

async function go(kind, {
  script = [], body = {}, content: contentOver = {}, creditContext = {}, env = {},
  quota = { tier: 'professional', limit: null, limitType: 'monthly', used: 0 },
  disabledCommands, revertIntent = false, ledgerOver = {},
} = {}) {
  const saved = [];
  const stub = (obj, key, fn) => { saved.push([obj, key, obj[key]]); obj[key] = fn; };
  const ledger = makeLedger();
  Object.assign(ledger, ledgerOver);
  const captured = { engineCalls: 0, appended: [], increments: 0, closeCb: null };
  const savedEnv = {};
  for (const [k, v] of Object.entries({ INTERNAL_API_KEY: 'k', ...env })) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const content = {
    _id: `c-${Math.floor(Math.random() * 1e9)}`, workspaceId: 'w1', contentNumber: 1, blocks: [],
    mode: 'chat', targetKeywords: [], articleGeneratedAt: new Date('2026-01-01'), ...contentOver,
  };

  if (disabledCommands) {
    const real = systemSettings.getSettings();
    stub(systemSettings, 'getSettings', () => ({ ...real, disabledAgentCommands: disabledCommands }));
  }
  stub(Content, 'findByNumber', async () => content);
  stub(Content, 'findByIdAndUpdate', async () => ({}));
  stub(Content, 'findOneAndUpdate', async (filter) => { (captured.claims ||= []).push(filter); return null; });
  stub(Workspace, 'findById', () => ({ select: () => ({ lean: async () => ({ workspaceNumber: 1, organizationId: 'org1' }) }), lean: async () => ({ workspaceNumber: 1 }) }));
  stub(BrandVoice, 'findOne', () => ({ lean: async () => null, select: () => ({ lean: async () => null }) }));
  stub(Avatar, 'findOne', () => ({ lean: async () => null }));
  stub(Plan, 'findProposed', async () => null);
  stub(Plan, 'findDraft', async () => null);
  stub(Plan, 'findById', async () => null);
  stub(UsageTracker, 'getCount', async () => quota.used);
  stub(UserUsageTracker, 'getCount', async () => quota.used);
  stub(tierService, 'getOrgTierConfig', async () => ({
    tier: quota.tier, config: { maxArticlesPerMonth: quota.limit, articleLimitType: quota.limitType },
  }));
  stub(tierService, 'incrementQuota', async () => { captured.increments++; });
  stub(creditService, 'preDeduct', ledger.preDeduct);
  stub(creditService, 'settle', (...a) => ledger.settle(...a));
  stub(creditService, 'refund', (...a) => ledger.refund(...a));
  stub(threadService, 'getActiveThreadStamp', async () => null);
  stub(threadService, 'getReplayPayload', async () => null);
  stub(threadService, 'getOrCreateActiveThread', async () => ({ _id: 't1' }));
  stub(threadService, 'appendMessage', async (_t, m) => { captured.appended.push(m); return { seq: captured.appended.length, threadId: 't1' }; });
  stub(threadService, 'recordTurns', async () => {});
  stub(threadService, 'maybeCompactThread', async () => {});
  stub(threadService, 'markSteersApplied', async () => {});
  for (const m of ['pushDocument', 'pushBrief', 'pushContextFiles', 'pushBrandVoice', 'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig']) {
    stub(writingEngine, m, async () => {});
  }
  stub(writingEngine, 'createSession', async () => `sess-${content._id}`);
  stub(writingEngine, 'getEngineCapabilities', async () => ({ imageStorage: 'b2' }));

  const signalRef = {};
  const startStream = (signal) => {
    captured.engineCalls++;
    signalRef.signal = signal;
    if (revertIntent) {
      const entry = aiController.activeAgentRuns.get(content._id.toString());
      if (entry) entry.revertIntent = true;
    }
    return { body: scriptedBody(script, signalRef) };
  };
  stub(writingEngine, 'sendChatMessageStream', async (_s, _p, signal, _preset, opts) => { captured.engineOpts = opts; return startStream(signal); });
  stub(writingEngine, 'startAgent', async (_s, _g, _t, _m, signal) => startStream(signal));

  const res = makeRes();
  const req = {
    params: { workspaceNumber: '1', contentNumber: '1' },
    workspace: { _id: 'w1', organizationId: 'org1' },
    user: { userId: 'u1' },
    body: kind === 'chat' ? { prompt: 'hello', ...body } : { goal: 'write it', mode: 'freeform', ...body },
    creditContext: {
      orgId: 'org1', workspaceId: 'w1', deductionEnabled: true, featureKey: kind === 'chat' ? 'aiChat' : 'aiAgent',
      tier: quota.tier, estimatedCredits: kind === 'chat' ? 2 : 10, ...creditContext,
    },
    on: (ev, cb) => { if (ev === 'close') captured.closeCb = cb; },
  };
  // Script steps (clientCloses / explicitStop) reach this run through `current`.
  current = { captured, content };
  try {
    await (kind === 'chat' ? aiController.chat(req, res) : aiController.agent(req, res));
    await tick(); await tick();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) { const [o, k, v] = saved[i]; o[k] = v; }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { res, ledger, captured, content };
}

// Late-bound side effects: the close callback / registry entry exist only once
// the handler is running, so the script steps look them up at call time on the
// run in flight (tests run sequentially within this file).
const clientCloses = () => ({ fn: () => current.captured.closeCb?.() });
const explicitStop = () => ({
  fn: () => {
    // What POST /ai/stop does: abort via the registry entry, then the socket closes.
    const entry = aiController.activeAgentRuns.get(current.content._id.toString());
    entry?.abort();
    current.captured.closeCb?.();
  },
});
// ═══ chat ═══════════════════════════════════════════════════════

const U = (input, output = 50) => ({ type: 'usage', usage: { input_tokens: input, output_tokens: output } });
const DIFF = { type: 'document_diff', patches: [{ op: 'replace' }] };
const DONE = { type: 'complete', completion: { stopReason: 'done' } };

test('chat: answer-only run (no document_diff) → refund, 0 charged', async () => {
  const { ledger } = await go('chat', { script: [U(20000), { type: 'text_delta', textDelta: 'answer' }, DONE] });
  assertLedgerInvariants(ledger, 'answer-only');
  assert.equal(charged(ledger), 0);
  assert.equal(ledger.calls.filter((c) => c.op === 'refund').length, 1);
});

test('chat: document_update / draft events are not writes → 0', async () => {
  const { ledger } = await go('chat', { script: [U(100), { type: 'document_update' }, { type: 'draft', blocks: [] }, DONE] });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 0);
});

test('chat: a write priced on the largest single turn (two 6K turns → 1; one 9K turn → 2)', async () => {
  const a = await go('chat', { script: [U(6000), DIFF, U(6000), DONE] });
  assertLedgerInvariants(a.ledger);
  assert.equal(charged(a.ledger), 1);
  const b = await go('chat', { script: [U(1000), DIFF, U(9000), DONE] });
  assertLedgerInvariants(b.ledger);
  assert.equal(charged(b.ledger), 2);
});

test('chat: exactly 8K single-turn input is still the small price', async () => {
  const { ledger } = await go('chat', { script: [U(8000), DIFF, DONE] });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 1);
});

test('chat: in-band engine error AFTER a write keeps the charge; BEFORE any write is free', async () => {
  const after = await go('chat', { script: [U(100), DIFF, { type: 'error', code: 'api_error', error: 'x' }] });
  assertLedgerInvariants(after.ledger);
  assert.equal(charged(after.ledger), 1);
  const before = await go('chat', { script: [U(100), { type: 'error', code: 'api_error', error: 'x' }] });
  assertLedgerInvariants(before.ledger);
  assert.equal(charged(before.ledger), 0);
});

test('chat: transport failure mid-stream after a write → full refund, SSE error, stream ended', async () => {
  const { ledger, res } = await go('chat', { script: [U(100), DIFF, { throw: new Error('socket hang up') }] });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 0);
  assert.equal(res.ended, true);
  assert.ok(sseEvents(res).some((e) => e.type === 'error'));
});

test('chat: client disconnect mid-stream → refund once, no settle, no write after end', async () => {
  const { ledger } = await go('chat', { script: [U(100), DIFF, clientCloses(), { type: 'text_delta', textDelta: 'late' }] });
  assertLedgerInvariants(ledger, 'disconnect');
  assert.equal(charged(ledger), 0);
  assert.equal(ledger.calls.filter((c) => c.op === 'settle').length, 0);
});

test('chat: malformed SSE (garbage, partial JSON, no-space data:, [DONE], CRLF) never throws or double-closes', async () => {
  const { ledger, res } = await go('chat', {
    script: [
      { raw: 'garbage line\n\n' },
      { raw: 'data: {"type":"usage","usage":{"input_tokens":\n\n' }, // truncated JSON
      { raw: 'data: [DONE]\n\n' },
      { raw: 'data:{"type":"document_diff"}\n\n' }, // no space → ignored by the tap
      { raw: 'data: not-json\n\n' },
      { raw: 'event: ping\r\ndata: {"type":"text_delta","textDelta":"ok"}\r\n\r\n' },
      { raw: ': comment\n\n' },
      DONE,
    ],
  });
  assertLedgerInvariants(ledger, 'malformed');
  assert.equal(charged(ledger), 0, 'nothing parsed as a write');
  assert.equal(res.ended, true);
});

test('chat: a document_diff frame split across chunks is still counted (CRLF too)', async () => {
  const { ledger } = await go('chat', {
    script: [
      { raw: 'data: {"type":"usage","usage":{"input_tokens":9500,' },
      { raw: '"output_tokens":5}}\r\n\r\ndata: {"type":"docu' },
      { raw: 'ment_diff","patches":[]}\r\n\r\n' },
      DONE,
    ],
  });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 2, 'diff seen across the split, priced on the 9.5K turn');
});

test('chat: settle/refund that REJECT never escape as unhandled rejections and are not retried', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const failing = makeLedger();
    const { ledger } = await go('chat', {
      script: [U(100), DIFF, DONE],
      ledgerOver: {
        settle: async (id, actual) => { failing.calls.push({ op: 'settle', id, actual }); throw new Error('db down'); },
      },
    });
    await tick();
    assert.equal(unhandled.length, 0);
    assert.equal(ledger.calls.filter((c) => c.op === 'refund').length, 0, 'no fallback refund after a failed settle (the orphan sweep owns it)');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('chat: deduction disabled → no ledger traffic at all', async () => {
  const { ledger } = await go('chat', { script: [U(100), DIFF, DONE], creditContext: { deductionEnabled: false } });
  assertLedgerInvariants(ledger);
  assert.equal(ledger.calls.length, 0);
});

test('chat: estimatedCredits missing → nothing reserved → refunded, never settled above 0', async () => {
  const { ledger } = await go('chat', { script: [U(100), DIFF, DONE], creditContext: { estimatedCredits: undefined } });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 0);
});

test('chat replyOnly: forwarded only when strictly true; a stray diff bills 0', async () => {
  const on = await go('chat', { body: { replyOnly: true }, script: [U(100), DIFF, DONE] });
  assert.deepEqual(on.captured.engineOpts, { replyOnly: true });
  assertLedgerInvariants(on.ledger);
  assert.equal(charged(on.ledger), 0);
  for (const v of [false, 'true', 1, null, undefined]) {
    const off = await go('chat', { body: { replyOnly: v }, script: [U(100), DIFF, DONE] });
    assert.deepEqual(off.captured.engineOpts, { replyOnly: false }, `replyOnly=${JSON.stringify(v)}`);
    assert.equal(charged(off.ledger), 1, `replyOnly=${JSON.stringify(v)} is a normal turn`);
  }
});

test('chat: context_unavailable warning precedes the engine stream; run still billed by its writes', async () => {
  const { res, ledger } = await go('chat', { env: { INTERNAL_API_KEY: undefined }, script: [U(100), DIFF, DONE] });
  const ev = sseEvents(res);
  assert.equal(ev[0].type, 'warning');
  assert.equal(ev[0].code, 'context_unavailable');
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 1);
});

test('chat: plan mode with CFS down → one SSE error, stream closed, no reservation opened', async () => {
  const { res, ledger, captured } = await go('chat', { content: { mode: 'plan' }, env: { INTERNAL_API_KEY: undefined } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.ended, true);
  const ev = sseEvents(res);
  assert.deepEqual(ev.map((e) => [e.type, e.code]), [['error', 'context_unavailable']]);
  assert.equal(captured.engineCalls, 0);
  assertLedgerInvariants(ledger);
  assert.equal(ledger.calls.length, 0);
});

// ═══ agent ══════════════════════════════════════════════════════

test('agent: freeform answer-only (no write) → 0', async () => {
  const { ledger } = await go('agent', { script: [U(100), { type: 'agent_commentary', textDelta: 'thinking' }, DONE] });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 0);
});

test('agent: a run that wrote settles at the flat reservation', async () => {
  const { ledger } = await go('agent', { script: [U(100), DIFF, DONE], creditContext: { estimatedCredits: 10 } });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 10);
});

test('agent: in-band error after a write keeps the charge; before any write → 0', async () => {
  const after = await go('agent', { script: [U(100), DIFF, { type: 'error', code: 'token_budget', error: 'cap' }] });
  assertLedgerInvariants(after.ledger);
  assert.equal(charged(after.ledger), 10);
  const before = await go('agent', { script: [U(100), { type: 'error', code: 'api_error', error: 'x' }] });
  assertLedgerInvariants(before.ledger);
  assert.equal(charged(before.ledger), 0);
});

test('agent: transport failure after a write (non-image) → full refund, registry freed', async () => {
  const { ledger, content } = await go('agent', { script: [U(100), DIFF, { throw: new Error('ECONNRESET') }] });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 0);
  assert.equal(aiController.activeAgentRuns.has(content._id.toString()), false);
});

test('agent: stop-and-revert where the stream completes after a write → inlineAction price', async () => {
  const { ledger } = await go('agent', { script: [U(100), DIFF, DONE], revertIntent: true, creditContext: { estimatedCredits: 10 } });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 2);
});

test('agent: explicit stop (abort) after a write without revert keeps the charge; without a write is free', async () => {
  const wrote = await go('agent', { script: [U(100), DIFF, explicitStop(), U(1)] });
  assertLedgerInvariants(wrote.ledger, 'stop after write');
  assert.equal(charged(wrote.ledger), 10);
  const idle = await go('agent', { script: [U(100), explicitStop(), U(1)] });
  assertLedgerInvariants(idle.ledger, 'stop before write');
  assert.equal(charged(idle.ledger), 0);
});

// Pinned as CURRENT behaviour, flagged in the QA report: an explicit
// stop-and-revert that ABORTS the stream after a write is refunded in full
// (abort path, pre-existing on main), while the same revert landing as the
// stream completes is charged inlineAction (computeSettlement rule 5). A client
// can therefore keep a streamed article for 0 by firing stop-revert after the
// last document_diff. Changing it is a pricing decision, not a bug fix.
test('agent: stop-and-revert that aborts the stream after a write → full refund (pre-existing loophole)', async () => {
  const revertAndStop = {
    fn: () => {
      const entry = aiController.activeAgentRuns.get(current.content._id.toString());
      entry.revertIntent = true;
      entry.abort();
      current.captured.closeCb?.();
    },
  };
  const { ledger } = await go('agent', { script: [U(100), DIFF, revertAndStop, U(1)] });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 0);
});

test('agent: passive client detach keeps draining and settles once at the end', async () => {
  const { ledger, res } = await go('agent', { script: [U(100), clientCloses(), DIFF, DONE] });
  assertLedgerInvariants(ledger, 'detach');
  assert.equal(charged(ledger), 10, 'the run finished server-side and wrote');
  assert.equal(res.chunks.some((c) => c.includes('document_diff')), false, 'nothing forwarded after the detach');
});

const IMAGE = { body: { goal: 'illustrate', mode: 'sequential', commandName: 'image' }, disabledCommands: [], creditContext: { estimatedCredits: 42 } };
const imageUsage = (n) => ({ type: 'image_usage', fullText: JSON.stringify({ images: n, model: 'm' }) });

test('agent /image: wrote with 2 images → base + 2 images; no write → 0 even with images bought', async () => {
  const wrote = await go('agent', { ...IMAGE, script: [U(100), imageUsage(2), DIFF, DONE] });
  assertLedgerInvariants(wrote.ledger);
  assert.equal(charged(wrote.ledger), 2 + 2 * 10);
  const none = await go('agent', { ...IMAGE, script: [U(100), imageUsage(3), DONE] });
  assertLedgerInvariants(none.ledger);
  assert.equal(charged(none.ledger), 0);
});

test('agent /image: transport failure after write+images → images kept; without a write → refund', async () => {
  const wrote = await go('agent', { ...IMAGE, script: [U(100), imageUsage(1), DIFF, { throw: new Error('boom') }] });
  assertLedgerInvariants(wrote.ledger);
  assert.equal(charged(wrote.ledger), 12);
  const none = await go('agent', { ...IMAGE, script: [U(100), imageUsage(1), { throw: new Error('boom') }] });
  assertLedgerInvariants(none.ledger);
  assert.equal(charged(none.ledger), 0);
});

test('agent /image: revert after a write with images bought → still pays for the images', async () => {
  const { ledger } = await go('agent', { ...IMAGE, script: [U(100), imageUsage(2), DIFF, DONE], revertIntent: true });
  assertLedgerInvariants(ledger);
  assert.equal(charged(ledger), 22);
});

test('agent: context_unavailable warning is sent right after session_init', async () => {
  const { res, ledger } = await go('agent', { env: { INTERNAL_API_KEY: undefined }, script: [U(100), DONE] });
  const ev = sseEvents(res);
  assert.equal(ev[0].type, 'session_init');
  assert.equal(ev[1].type, 'warning');
  assert.equal(ev[1].code, 'context_unavailable');
  assertLedgerInvariants(ledger);
});

test('agent: plan mode with CFS down → SSE error, closed, nothing reserved, and the document is not left busy', async () => {
  const first = await go('agent', { content: { mode: 'plan' }, env: { INTERNAL_API_KEY: undefined } });
  assert.equal(first.res.ended, true);
  assert.deepEqual(sseEvents(first.res).map((e) => [e.type, e.code]), [['error', 'context_unavailable']]);
  assertLedgerInvariants(first.ledger);
  assert.equal(first.ledger.calls.length, 0);
  assert.equal(aiController.activeAgentRuns.has(first.content._id.toString()), false, 'registry slot released');
});

test('agent: a settle that rejects is contained (no unhandled rejection, no second close)', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { ledger } = await go('agent', {
      script: [U(100), DIFF, DONE],
      ledgerOver: { settle: async () => { throw new Error('db down'); } },
    });
    await tick();
    assert.equal(unhandled.length, 0);
    assert.equal(ledger.calls.filter((c) => c.op === 'refund').length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('agent: a late/duplicate settle on a closed reservation is a ledger no-op (no double refund)', async () => {
  const { ledger } = await go('agent', { script: [U(100), DIFF, DONE] });
  const [id] = [...ledger.txs.keys()];
  // e.g. the orphan sweep or a second handler path firing after the close.
  await creditServiceShape(ledger).refund(id);
  await creditServiceShape(ledger).settle(id, 0);
  assert.equal(ledger.txs.get(id).charged, 10, 'the first close stands');
});

function creditServiceShape(ledger) { return { settle: ledger.settle, refund: ledger.refund }; }

// ═══ QA B24 follow-up: uncounted drafts written by chat / freeform ═════
// A never-analyzed draft (articleQuotaState 'pending') must pass the article
// limit before a run that can write it, and count its slot only when the run
// actually wrote. replyOnly chat and counted docs are never gated.

const PENDING = {
  articleQuotaState: 'pending',
  articleQuotaCtx: { orgId: 'org1', userId: 'u1', isUserLevel: true, orgCounted: true, lifetime: true, quotaSource: 'free' },
  articleGeneratedAt: undefined,
};
const FREE_AT_LIMIT = { tier: 'free', limit: 3, limitType: 'lifetime', used: 3 };
const FREE_UNDER = { tier: 'free', limit: 3, limitType: 'lifetime', used: 1 };
const slotClaims = (captured) => (captured.claims || []).filter((f) => f && f.articleQuotaState === 'pending');

test('B24: chat on a pending draft at the limit → 429, no engine call, nothing reserved', async () => {
  const { res, ledger, captured } = await go('chat', { content: PENDING, quota: FREE_AT_LIMIT, script: [DIFF, DONE] });
  assert.equal(res.statusCode, 429);
  assert.equal(res.jsonBody.code, 'ARTICLE_LIMIT_REACHED');
  assert.equal(captured.engineCalls, 0);
  assert.equal(ledger.txs.size, 0);
});

test('B24: replyOnly chat on a pending draft at the limit is allowed (it cannot write)', async () => {
  const { res, captured } = await go('chat', { content: PENDING, quota: FREE_AT_LIMIT, body: { replyOnly: true }, script: [DONE] });
  assert.equal(res.statusCode, 200);
  assert.equal(captured.engineCalls, 1);
  assert.equal(slotClaims(captured).length, 0);
});

test('B24: chat that writes a pending draft under the limit claims the slot once', async () => {
  const { res, captured } = await go('chat', { content: PENDING, quota: FREE_UNDER, script: [U(100), DIFF, DONE] });
  assert.equal(res.statusCode, 200);
  assert.equal(slotClaims(captured).length, 1);
});

test('B24: chat that only answers a pending draft does not claim', async () => {
  const { captured } = await go('chat', { content: PENDING, quota: FREE_UNDER, script: [U(100), { type: 'text_delta', textDelta: 'hi' }, DONE] });
  assert.equal(slotClaims(captured).length, 0);
});

test('B24: chat on a COUNTED doc at the limit is not gated', async () => {
  const { res, captured } = await go('chat', { content: { articleQuotaState: 'counted' }, quota: FREE_AT_LIMIT, script: [DIFF, DONE] });
  assert.equal(res.statusCode, 200);
  assert.equal(slotClaims(captured).length, 0);
});

test('B24: chat on a legacy doc (no quota state) at the limit is not gated', async () => {
  const { res } = await go('chat', { quota: FREE_AT_LIMIT, script: [DIFF, DONE] });
  assert.equal(res.statusCode, 200);
});

test('B24: freeform agent on a pending draft at the limit → 429 and the registry slot is freed', async () => {
  const { res, captured, content } = await go('agent', { content: PENDING, quota: FREE_AT_LIMIT, script: [DIFF, DONE] });
  assert.equal(res.statusCode, 429);
  assert.equal(captured.engineCalls, 0);
  assert.equal(aiController.activeAgentRuns.has(content._id.toString()), false);
});

test('B24: freeform agent that writes a pending draft under the limit claims the slot', async () => {
  const { res, captured } = await go('agent', { content: PENDING, quota: FREE_UNDER, script: [U(100), DIFF, DONE] });
  assert.equal(res.statusCode, 200);
  assert.ok(slotClaims(captured).length >= 1);
});

test('B24: freeform agent that writes nothing on a pending draft does not claim', async () => {
  const { captured } = await go('agent', { content: PENDING, quota: FREE_UNDER, script: [U(100), DONE] });
  assert.equal(slotClaims(captured).length, 0);
});
