/**
 * QA Nov 2026 (B04, B38, B42) — computeSettlement truth table, plus the usage
 * tap's per-turn max that chat pricing now reads.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeSettlement, isErrorStop } = require('../src/services/billing/computeSettlement');
const aiController = require('../src/controllers/aiController');

const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n`);

test('nothing written → 0 for every kind and class, errored or not', () => {
  const cases = [
    { kind: 'chat', reserved: 2 },
    { kind: 'agent', billingClass: 'articleGenerate', reserved: 100 },
    { kind: 'agent', billingClass: 'fullDocPass', reserved: 25 },
    { kind: 'agent', billingClass: 'inlineAction', reserved: 2 },
    { kind: 'agent', billingClass: 'imageGenerate', reserved: 42, images: 3 },
    { kind: 'agent', billingClass: 'inlineAction', reserved: 2, reverted: true },
  ];
  for (const c of cases) {
    for (const stopReason of ['done', 'api_error', 'token_budget', '']) {
      const r = computeSettlement({ ...c, wrote: false, stopReason, tier: 'professional' });
      assert.equal(r.credits, 0, `${JSON.stringify(c)} stop=${stopReason}`);
      assert.equal(r.reason, 'no_write');
    }
  }
});

test('nothing reserved → 0 even when written', () => {
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'fullDocPass', reserved: 0, wrote: true }).credits, 0);
  assert.equal(computeSettlement({ kind: 'chat', reserved: NaN, wrote: true }).credits, 0);
});

test('chat that wrote: priced on the largest single turn, 1 at or under 8K, 2 above', () => {
  const small = computeSettlement({ kind: 'chat', reserved: 2, wrote: true, tokens: 7999, tier: 'professional' });
  assert.equal(small.credits, 1);
  const edge = computeSettlement({ kind: 'chat', reserved: 2, wrote: true, tokens: 8000, tier: 'professional' });
  assert.equal(edge.credits, 1, '8000 is not above 8K');
  const big = computeSettlement({ kind: 'chat', reserved: 2, wrote: true, tokens: 8001, tier: 'professional' });
  assert.equal(big.credits, 2);
});

test('errored run that wrote keeps the charge its class would have had', () => {
  const chat = computeSettlement({ kind: 'chat', reserved: 2, wrote: true, tokens: 100, stopReason: 'api_error' });
  assert.equal(chat.credits, 1);
  assert.equal(chat.errored, true);
  assert.equal(chat.reason, 'chat_errored');
  const agent = computeSettlement({ kind: 'agent', billingClass: 'fullDocPass', reserved: 25, wrote: true, stopReason: 'token_budget' });
  assert.equal(agent.credits, 25);
  assert.equal(agent.reason, 'reserved_errored');
});

test('agent classes: flat reservation, image count, revert floor', () => {
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'articleGenerate', reserved: 100, wrote: true }).credits, 100);
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'imageGenerate', reserved: 42, wrote: true, images: 1 }).credits, 12);
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'imageGenerate', reserved: 42, wrote: true, images: 0 }).credits, 2);
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'articleGenerate', reserved: 100, wrote: true, reverted: true }).credits, 2);
  // An image revert still pays for images (they cannot be un-bought).
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'imageGenerate', reserved: 42, wrote: true, images: 2, reverted: true }).credits, 22);
});

test('never exceeds the reservation (settle can only refund)', () => {
  assert.equal(computeSettlement({ kind: 'chat', reserved: 1, wrote: true, tokens: 50000 }).credits, 1);
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'imageGenerate', reserved: 10, wrote: true, images: 4 }).credits, 10);
});

test('Free tier fixed-bundle article write prices at 0 (Option B)', () => {
  assert.equal(computeSettlement({ kind: 'agent', billingClass: 'articleGenerate', reserved: 0, wrote: true, tier: 'free' }).credits, 0);
});

test('isErrorStop: clean completions are not errors, coded engine errors are', () => {
  for (const s of ['done', 'nudges_exhausted', 'stale', 'max_turns', '']) assert.equal(isErrorStop(s), false, s);
  for (const s of ['api_error', 'token_budget', 'output_limit', 'busy']) assert.equal(isErrorStop(s), true, s);
});

test('usage tap: keeps the per-turn max input alongside the sum', () => {
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 6000, output_tokens: 100 } }));
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 7000, output_tokens: 200 } }));
  tap.addChunk(sse({ type: 'usage', usage: { inputTokens: 6500, outputTokens: 50 } }));
  const s = tap.snapshot();
  assert.equal(s.inputTokens, 19500, 'the sum stays for analytics');
  assert.equal(s.maxTurnInputTokens, 7000);
  // Before the fix this run priced on 19,850 tokens → 2 credits.
  assert.equal(computeSettlement({ kind: 'chat', reserved: 2, wrote: true, tokens: s.maxTurnInputTokens }).credits, 1);
});
