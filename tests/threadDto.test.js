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
