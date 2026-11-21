/**
 * QA Nov 2026 (B43, N3) — the thread history API returns a client DTO, never
 * the stored row: no engineered prompt, no model/tokens, no author userId.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const threadService = require('../src/services/threadService');
const AiThread = require('../src/models/AiThread');
const AiThreadMessage = require('../src/models/AiThreadMessage');

const { toClientThreadMessage } = threadService;

const ENGINEERED = 'You are running /auto-optimize. RULES: 1) never ... [2,000 chars of internal instructions]';

test('user row: the label the bubble showed, never the engineered prompt', () => {
  const dto = toClientThreadMessage({
    seq: 1, kind: 'user', text: ENGINEERED, displayText: '/auto-optimize',
    meta: { runId: 'r', sessionId: 's', userId: 'u-author', channel: 'agent', commandName: 'auto-optimize' },
    createdAt: new Date(0),
  }, 'u-viewer');
  assert.equal(dto.text, '/auto-optimize');
  assert.equal(dto.displayText, '/auto-optimize');
  assert.doesNotMatch(JSON.stringify(dto), /RULES|internal instructions/);
  assert.equal(dto.mine, false);
  assert.equal(dto.meta.userId, undefined);
});

test('typed chat prompt (no label) is what the bubble showed, so it is returned', () => {
  const dto = toClientThreadMessage({ seq: 2, kind: 'user', text: 'make the intro shorter', displayText: '', meta: { userId: 'me' } }, 'me');
  assert.equal(dto.text, 'make the intro shorter');
  assert.equal(dto.mine, true);
});

test('assistant row: reply text kept, meta reduced to the allowlist', () => {
  const dto = toClientThreadMessage({
    seq: 3, kind: 'assistant', text: 'Done.',
    meta: {
      runId: 'r', sessionId: 's', channel: 'chat', model: 'google/gemini-2.5-flash',
      tokensIn: 12000, tokensOut: 400, costUsd: 0.01, docWrites: 2, stopReason: 'done', turns: 3, userId: 'u',
    },
  });
  assert.equal(dto.text, 'Done.');
  assert.deepEqual(dto.meta, { channel: 'chat', docWrites: 2, stopReason: 'done', turns: 3, runId: 'r', sessionId: 's' });
});

test('compaction summary is model-facing and not returned', () => {
  const dto = toClientThreadMessage({ seq: 4, kind: 'compaction', text: 'SUMMARY: user prefers...', meta: {} });
  assert.equal(dto.text, '');
});

test('getThreadHistory maps every row through the DTO', async () => {
  const saved = [[AiThread, 'findOne', AiThread.findOne], [AiThreadMessage, 'find', AiThreadMessage.find]];
  AiThread.findOne = async () => ({ _id: 't1', title: 'x', messageCount: 2, turnsUsed: 0 });
  const rows = [
    { seq: 2, kind: 'assistant', text: 'ok', meta: { model: 'm', tokensIn: 5, userId: 'u1' } },
    { seq: 1, kind: 'user', text: ENGINEERED, displayText: '/facts', meta: { userId: 'u1' } },
  ];
  const chain = { sort: () => chain, skip: () => chain, limit: () => chain, lean: async () => rows.slice() };
  AiThreadMessage.find = () => chain;
  try {
    const h = await threadService.getThreadHistory('c1', { viewerUserId: 'u1' });
    const json = JSON.stringify(h.messages);
    assert.doesNotMatch(json, /RULES|"model"|tokensIn|"userId"/);
    assert.equal(h.messages[0].text, '/facts');
    assert.equal(h.messages[0].mine, true);
  } finally {
    for (const [o, k, v] of saved) o[k] = v;
  }
});

// ── QA B43 follow-up (Nov 21): legacy rows and the data export ──

test('legacy command row with no displayText shows /<command>, never the engineered goal', () => {
  const dto = toClientThreadMessage({
    seq: 4, kind: 'user', text: ENGINEERED, displayText: '',
    meta: { userId: 'u-author', channel: 'agent', commandName: 'auto-optimize' },
  }, 'u-viewer');
  assert.equal(dto.text, '/auto-optimize');
  assert.equal(dto.displayText, '/auto-optimize');
  assert.doesNotMatch(JSON.stringify(dto), /RULES|internal instructions/);
});

test('a commandName that already carries the slash is not doubled', () => {
  const dto = toClientThreadMessage({ seq: 5, kind: 'user', text: ENGINEERED, displayText: '', meta: { commandName: '/title' } });
  assert.equal(dto.text, '/title');
});

test('a typed agent prompt (empty commandName) is returned as typed', () => {
  const dto = toClientThreadMessage({ seq: 6, kind: 'user', text: 'tighten the intro', displayText: '', meta: { commandName: '' } });
  assert.equal(dto.text, 'tighten the intro');
});

test('workspace export: conversations use the client shape (no engineered prompt, model, tokens or userIds)', async () => {
  const exportService = require('../src/services/exportService');
  const Content = require('../src/models/Content');
  const Workspace = require('../src/models/Workspace');
  const AiTracker = require('../src/models/AiTracker');
  const ReportSnapshot = require('../src/models/ReportSnapshot');
  const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');
  const BrandVoice = require('../src/models/BrandVoice');
  const saved = [
    [Workspace, 'findById', Workspace.findById], [Content, 'find', Content.find], [AiThread, 'find', AiThread.find],
    [AiThreadMessage, 'find', AiThreadMessage.find], [AiTracker, 'find', AiTracker.find], [ReportSnapshot, 'find', ReportSnapshot.find],
    [KeywordResearchHistory, 'find', KeywordResearchHistory.find], [BrandVoice, 'find', BrandVoice.find],
  ];
  const lean = (val) => ({ select() { return this; }, sort() { return this; }, lean: async () => val });
  Workspace.findById = () => lean({ _id: 'w1', workspaceNumber: 42, name: 'WS' });
  Content.find = (f) => lean(f && f.locked === true ? [] : [{ _id: 'c1', contentNumber: 7, title: 'My Post', blocks: [] }]);
  AiThread.find = () => lean([{
    _id: 'T1', contentId: 'c1', title: 'Optimize', status: 'active', messageCount: 3,
    ownerUserId: null, tokenEstimate: 52000, engineSessionId: 'sess-internal', createdAt: new Date(0), lastMessageAt: new Date(1),
  }]);
  AiThreadMessage.find = () => lean([
    { seq: 0, kind: 'user', text: ENGINEERED, displayText: '/auto-optimize', meta: { userId: 'u-other', commandName: 'auto-optimize', model: 'm' } },
    { seq: 1, kind: 'assistant', text: 'Optimized.', meta: { userId: 'u-other', model: 'google/gemini-2.5-flash', tokensIn: 9000, tokensOut: 300, costUsd: 0.02 } },
    { seq: 2, kind: 'user', text: 'thanks, now shorten it', displayText: '', meta: { userId: 'u-me' } },
  ]);
  AiTracker.find = () => lean([]); ReportSnapshot.find = () => lean([]);
  KeywordResearchHistory.find = () => lean([]); BrandVoice.find = () => lean([]);
  try {
    const entries = await exportService.serializeWorkspace('w1', '', { viewerUserId: 'u-me' });
    const conv = entries.find((e) => e.name.startsWith('conversations/'));
    assert.ok(conv, 'conversation still exported (portability)');
    const raw = conv.data.toString();
    for (const leak of [/RULES|internal instructions/, /gemini|"model"/, /tokensIn|tokensOut|costUsd|tokenEstimate/, /u-other|u-me|userId/, /sess-internal|engineSessionId/]) {
      assert.doesNotMatch(raw, leak);
    }
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.messages.map((m) => m.text), ['/auto-optimize', 'Optimized.', 'thanks, now shorten it']);
    assert.deepEqual(parsed.messages.map((m) => m.mine), [false, false, true], 'the exporter can still tell their own prompts apart');
    assert.equal(parsed.thread.title, 'Optimize');
    assert.equal(parsed.thread.messageCount, 3);
  } finally {
    for (const [o, k, v] of saved) o[k] = v;
  }
});

test('export controller passes the requesting user as the viewer', async () => {
  const exportService = require('../src/services/exportService');
  const exportController = require('../src/controllers/exportController');
  const real = exportService.exportWorkspaceArchive;
  let seen = null;
  exportService.exportWorkspaceArchive = async (id, opts) => { seen = { id, opts }; return { filename: 'f.tar.gz', buffer: Buffer.from('x') }; };
  const res = { setHeader() {}, status() { return this; }, json() { return this; }, send() { return this; } };
  try {
    await exportController.exportWorkspace({ workspace: { _id: 'w1' }, user: { userId: 'u-me' }, headers: {}, ip: '127.0.0.1' }, res);
    assert.deepEqual(seen, { id: 'w1', opts: { viewerUserId: 'u-me' } });
  } finally {
    exportService.exportWorkspaceArchive = real;
  }
});
