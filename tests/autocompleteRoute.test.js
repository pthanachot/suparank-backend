'use strict';

// W5-b: ghost-text autocomplete route + handler.
// Covers (1) route wiring (registered POST, own per-user limiter, NO credit
// gate) and (2) the handler's validation, soft-fail contract (every failure →
// 200 {completion:''}, never an error), maxTokens clamp, bare-session reuse,
// 404 session recovery, and the free-but-metered COGS ledger call.
// setupSessionAutocomplete's engine calls are stubbed; mongoose buffering is
// disabled so any unstubbed DB call fails fast instead of hanging.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const router = require('../src/routes/workspaceRoutes');
const writingEngine = require('../src/services/writingEngine');
const Content = require('../src/models/Content');
const aiController = require('../src/controllers/aiController');
const costLedger = require('../src/services/costLedgerService');

// ─── Route wiring ────────────────────────────────────────────

function findRoute(fragment, method = 'post') {
  return router.stack.find(
    (l) => l.route && l.route.path && l.route.path.includes(fragment) && l.route.methods[method],
  );
}

test('autocomplete route is registered as POST', () => {
  const ac = findRoute('ai/autocomplete');
  assert.ok(ac, 'autocomplete route should be registered');
  // limiter + rwr + rf('aiChat') + rp('aiChat','use') + handler = 5.
  assert.strictEqual(ac.route.stack.length, 5, 'autocomplete should have 5 handlers (incl. its own limiter, no credit gate)');
});

test('autocomplete has one MORE handler than the credit-free upload-image route but is still gated', () => {
  // Sanity: it is NOT the wide-open pattern (upload-image = rwr + rp + handler = 3);
  // autocomplete adds a limiter and a feature gate on top.
  const ac = findRoute('ai/autocomplete');
  const upload = findRoute('ai/upload-image');
  assert.ok(ac && upload);
  assert.ok(ac.route.stack.length > upload.route.stack.length);
});

// ─── Handler paths ───────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}

function mockReq(body) {
  return {
    params: { contentNumber: '1' },
    body,
    workspace: { _id: 'w1' },
    user: { userId: 'u1' },
    on() {},   // req.on('close', …)
    off() {},  // req.off('close', …)
  };
}

const fakeContent = {
  _id: { toString: () => 'c-ac' },
  workspaceId: { toString: () => 'w1' },
  blocks: [],
  contentNumber: 1,
};

function withStubs({ complete, contentFn, createSession } = {}) {
  const savedCreate = writingEngine.createSession;
  const savedComplete = writingEngine.complete;
  const savedFind = Content.findByNumber;
  const savedCogs = costLedger.recordForWorkspace;
  let createCalls = 0;
  const cogsCalls = [];

  writingEngine.createSession = createSession || (async () => { createCalls++; return `sess-${createCalls}`; });
  writingEngine.complete = complete || (async () => ({ completion: 'the rest of the sentence.' }));
  Content.findByNumber = contentFn || (async () => fakeContent);
  costLedger.recordForWorkspace = (p) => { cogsCalls.push(p); return Promise.resolve(null); };

  return {
    createCalls: () => createCalls,
    cogsCalls,
    restore() {
      writingEngine.createSession = savedCreate;
      writingEngine.complete = savedComplete;
      Content.findByNumber = savedFind;
      costLedger.recordForWorkspace = savedCogs;
    },
  };
}

test('400 when textBefore is missing or empty', async () => {
  const s = withStubs();
  try {
    let res = mockRes();
    await aiController.autocomplete(mockReq({}), res);
    assert.strictEqual(res.statusCode, 400);

    res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: '   ' }), res);
    assert.strictEqual(res.statusCode, 400);
  } finally { s.restore(); }
});

test('200 returns { completion } on success', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-ok' } };
  const s = withStubs({ contentFn: async () => uniq, complete: async () => ({ completion: 'flows naturally.' }) });
  try {
    const res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: 'The sentence ' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { completion: 'flows naturally.' });
  } finally { s.restore(); }
});

test('soft-fails to 200 {completion:""} when the engine throws', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-throw' } };
  const s = withStubs({ contentFn: async () => uniq, complete: async () => { throw new Error('engine down'); } });
  try {
    const res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: 'hello ' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { completion: '' });
  } finally { s.restore(); }
});

test('soft-fails to 200 {completion:""} when the engine reports an error', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-err' } };
  const s = withStubs({ contentFn: async () => uniq, complete: async () => ({ error: 'empty completion' }) });
  try {
    const res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: 'hello ' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { completion: '' });
  } finally { s.restore(); }
});

test('clamps maxTokens to 200 and forwards trimmed context', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-clamp' } };
  let seen = null;
  const s = withStubs({
    contentFn: async () => uniq,
    complete: async (_sid, args) => { seen = args; return { completion: 'ok.' }; },
  });
  try {
    const res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: 'x ', textAfter: 'y', maxTokens: 999 }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.maxTokens, 200, 'maxTokens clamped to 200');
    assert.strictEqual(seen.textAfter, 'y');
  } finally { s.restore(); }
});

test('reuses the bare session across calls (createSession called once)', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-reuse-ac' } };
  const s = withStubs({ contentFn: async () => uniq });
  try {
    await aiController.autocomplete(mockReq({ textBefore: 'a ' }), mockRes());
    await aiController.autocomplete(mockReq({ textBefore: 'b ' }), mockRes());
    assert.strictEqual(s.createCalls(), 1, 'second call reuses the shared bare session');
  } finally { s.restore(); }
});

test('recreates the session and retries once on a 404 from the engine', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-404-ac' } };
  let completeCalls = 0;
  const s = withStubs({
    contentFn: async () => uniq,
    complete: async () => {
      completeCalls++;
      if (completeCalls === 1) { const e = new Error('session gone'); e.status = 404; throw e; }
      return { completion: 'recovered.' };
    },
  });
  try {
    const res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: 'seed ' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.completion, 'recovered.');
    assert.strictEqual(completeCalls, 2, 'retried once after the 404');
    assert.strictEqual(s.createCalls(), 2, 'minted a fresh bare session for the retry');
  } finally { s.restore(); }
});

test('logs a free COGS row (no credit charge) when the engine reports a model', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-cogs' } };
  const s = withStubs({
    contentFn: async () => uniq,
    complete: async () => ({ completion: 'billed nothing.', usage: { model: 'google/gemini-2.5-flash-lite', input_tokens: 40, output_tokens: 12 } }),
  });
  try {
    await aiController.autocomplete(mockReq({ textBefore: 'meter ' }), mockRes());
    assert.strictEqual(s.cogsCalls.length, 1, 'one COGS ledger row');
    const row = s.cogsCalls[0];
    assert.strictEqual(row.action, 'autocomplete');
    assert.strictEqual(row.model, 'google/gemini-2.5-flash-lite');
    assert.strictEqual(row.tokensIn, 40);
    assert.strictEqual(row.tokensOut, 12);
  } finally { s.restore(); }
});

test('does NOT log COGS when the engine reports no model (priced at 0 otherwise)', async () => {
  const uniq = { ...fakeContent, _id: { toString: () => 'c-nocogs' } };
  const s = withStubs({ contentFn: async () => uniq, complete: async () => ({ completion: 'no usage.' }) });
  try {
    await aiController.autocomplete(mockReq({ textBefore: 'x ' }), mockRes());
    assert.strictEqual(s.cogsCalls.length, 0);
  } finally { s.restore(); }
});

test('403 when the content is locked (no engine call)', async () => {
  let completeCalled = false;
  const locked = { ...fakeContent, _id: { toString: () => 'c-locked' }, locked: true };
  const s = withStubs({ contentFn: async () => locked, complete: async () => { completeCalled = true; return {}; } });
  try {
    const res = mockRes();
    await aiController.autocomplete(mockReq({ textBefore: 'x ' }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(completeCalled, false);
  } finally { s.restore(); }
});
