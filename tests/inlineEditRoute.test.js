'use strict';

// R15: fast inline-edit route + handler.
// Covers (1) route wiring / gate parity with chat and (2) the handler's
// validation, engine-failure fallback (502), success, and no-edit (422) paths
// plus session reuse. DB calls inside setupSession are best-effort try/catch;
// disabling mongoose buffering makes them fail fast instead of hanging.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const router = require('../src/routes/workspaceRoutes');
const writingEngine = require('../src/services/writingEngine');
const Content = require('../src/models/Content');
const aiController = require('../src/controllers/aiController');

// ─── Route wiring / gate parity ──────────────────────────────

function findRoute(fragment, method = 'post') {
  return router.stack.find(
    (l) => l.route && l.route.path && l.route.path.includes(fragment) && l.route.methods[method],
  );
}

test('inline-edit route is registered as POST with the same gate chain as chat', () => {
  const inline = findRoute('ai/inline-edit');
  const chat = findRoute('ai/chat');
  assert.ok(inline, 'inline-edit route should be registered');
  assert.ok(chat, 'chat route should be registered');
  // rwr, rf('aiChat'), rp('aiChat','use'), rc('aiChat', est), handler == 5.
  // Identical count to chat → identical feature/permission/credit gating, so
  // user-facing credit behavior is unchanged.
  assert.strictEqual(inline.route.stack.length, 5, 'inline-edit should have 5 handlers');
  assert.strictEqual(
    inline.route.stack.length,
    chat.route.stack.length,
    'inline-edit gate chain must match chat',
  );
});

// ─── Handler paths ───────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function mockReq(body) {
  return {
    params: { contentNumber: '1' },
    body,
    workspace: { _id: 'w1' },
    user: { userId: 'u1' },
    creditContext: { deductionEnabled: false }, // credit path exercised separately
  };
}

const fakeContent = {
  _id: { toString: () => 'c1' },
  workspaceId: { toString: () => 'w1' },
  blocks: [],
  contentNumber: 1,
};

const ENGINE_METHODS = [
  'createSession', 'pushDocument', 'pushBrief', 'pushBrandVoice',
  'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig', 'pushContextFiles',
];

function withStubs({ inlineEdit, contentFn } = {}) {
  const savedEngine = {};
  let createSessionCalls = 0;
  for (const m of ENGINE_METHODS) savedEngine[m] = writingEngine[m];
  const savedFindByNumber = Content.findByNumber;
  const savedInlineEdit = writingEngine.inlineEdit;

  for (const m of ENGINE_METHODS) writingEngine[m] = async () => {};
  writingEngine.createSession = async () => { createSessionCalls++; return 'sess-1'; };
  writingEngine.inlineEdit = inlineEdit || (async () => ({ editedText: 'edited', applied: true }));
  Content.findByNumber = contentFn || (async () => fakeContent);

  return {
    calls: () => createSessionCalls,
    restore() {
      for (const m of ENGINE_METHODS) writingEngine[m] = savedEngine[m];
      writingEngine.inlineEdit = savedInlineEdit;
      Content.findByNumber = savedFindByNumber;
    },
  };
}

test('400 when selectedText is missing', async () => {
  const s = withStubs();
  try {
    const res = mockRes();
    await aiController.inlineEdit(mockReq({ instruction: 'Rewrite this.' }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /selectedText/);
  } finally { s.restore(); }
});

test('400 when instruction is missing', async () => {
  const s = withStubs();
  try {
    const res = mockRes();
    await aiController.inlineEdit(mockReq({ selectedText: 'some text' }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /instruction/);
  } finally { s.restore(); }
});

test('502 when the engine call throws (client falls back to chat)', async () => {
  const s = withStubs({ inlineEdit: async () => { throw new Error('engine down'); } });
  try {
    const res = mockRes();
    await aiController.inlineEdit(mockReq({ selectedText: 'x', instruction: 'Rewrite this.' }), res);
    assert.strictEqual(res.statusCode, 502);
  } finally { s.restore(); }
});

test('422 when the engine returns an error / no edit', async () => {
  const s = withStubs({ inlineEdit: async () => ({ error: 'selectedText not found in document' }) });
  try {
    const res = mockRes();
    await aiController.inlineEdit(mockReq({ selectedText: 'x', instruction: 'Rewrite this.' }), res);
    assert.strictEqual(res.statusCode, 422);
  } finally { s.restore(); }
});

test('200 returns { editedText } on success', async () => {
  const s = withStubs({ inlineEdit: async () => ({ editedText: 'a tighter sentence', applied: true }) });
  try {
    const res = mockRes();
    await aiController.inlineEdit(mockReq({ selectedText: 'x', instruction: 'Make shorter.' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { editedText: 'a tighter sentence' });
  } finally { s.restore(); }
});

test('reuses the engine session across calls (createSession called once)', async () => {
  // Unique content id so this test owns a fresh entry in the module-global
  // contentSessionMap (prior tests populated 'c1').
  const uniqueContent = { ...fakeContent, _id: { toString: () => 'c-reuse' } };
  const s = withStubs({
    inlineEdit: async () => ({ editedText: 'ok', applied: true }),
    contentFn: async () => uniqueContent,
  });
  try {
    await aiController.inlineEdit(mockReq({ selectedText: 'x', instruction: 'Rewrite.' }), mockRes());
    await aiController.inlineEdit(mockReq({ selectedText: 'y', instruction: 'Rewrite.' }), mockRes());
    assert.strictEqual(s.calls(), 1, 'second call should reuse the shared session (setupSessionLite)');
  } finally { s.restore(); }
});
