/**
 * Phase 1 (v4.1 plan) — AI cost ledger core.
 *
 * Proves the reusable pieces that every LLM call site depends on:
 *  - modelRegistry prices every real model non-zero
 *  - costLedgerService.record() computes cost from tokens and writes one row
 *  - BYOK zeroes cost but keeps tokens
 *  - a pre-computed costUsdOverride (the Go engine's pipeline_cost) is used verbatim
 *  - unknown models record 0 and flag unknownModel for back-fill
 *
 * AiCostLedger.create is monkey-patched to capture rows — no DB/network, matching
 * the repo's unit-test convention (see creditGate.test.js).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AiCostLedger = require('../src/models/AiCostLedger');
const costLedger = require('../src/services/costLedgerService');
const { costFor } = require('../src/config/modelRegistry');

// Capture create() calls instead of hitting Mongo.
let created = [];
AiCostLedger.create = async (doc) => { created.push(doc); return { ...doc, _id: 'test' }; };

beforeEach(() => { created = []; });

// Every model id actually used across the app (AI-MODELS.md) must be priced.
const REAL_MODELS = [
  'gpt-4o-mini', 'gpt-4o-mini-search-preview', 'gemini-2.5-flash-lite', 'sonar',
  'claude-haiku-4-5-20251001', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite',
  'anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4:thinking', 'moonshotai/kimi-k2-0905',
  'moonshotai/kimi-k2.6', 'xiaomi/mimo-v2-flash', 'google/gemini-3-flash-preview', 'google/gemini-2.5-pro',
];

test('registry prices every real model non-zero', () => {
  for (const m of REAL_MODELS) {
    const r = costFor(m, 1000, 500);
    assert.ok(r.known, `model not in registry: ${m}`);
    assert.ok(r.costUsd > 0, `cost not > 0 for ${m}`);
    assert.ok(r.provider, `no provider for ${m}`);
  }
});

test('record() computes cost from tokens and writes one row', async () => {
  await costLedger.record({ action: 'tracker_scan', model: 'gpt-4o-mini', tokensIn: 1000, tokensOut: 500, tier: 'standard' });
  assert.equal(created.length, 1);
  const row = created[0];
  assert.equal(row.action, 'tracker_scan');
  assert.equal(row.provider, 'openai');
  assert.equal(row.tier, 'standard');
  // 1000/1e6*0.15 + 500/1e6*0.60 = 0.00045
  assert.ok(Math.abs(row.costUsd - 0.00045) < 1e-9, `costUsd was ${row.costUsd}`);
  assert.equal(row.unknownModel, false);
});

test('image flat pricing (per image, no tokens)', async () => {
  await costLedger.record({ action: 'image', model: 'google/gemini-2.5-flash-image', images: 1 });
  assert.equal(created.length, 1);
  assert.ok(Math.abs(created[0].costUsd - 0.039) < 1e-9, `costUsd was ${created[0].costUsd}`);
});

test('BYOK forces cost to 0 but keeps tokens', async () => {
  await costLedger.record({ action: 'chat', model: 'google/gemini-2.5-flash', tokensIn: 3000, tokensOut: 1000, byok: true });
  assert.equal(created[0].costUsd, 0);
  assert.equal(created[0].tokensIn, 3000);
  assert.equal(created[0].byok, true);
});

test('costUsdOverride (engine pipeline_cost) is used verbatim', async () => {
  await costLedger.record({ action: 'analyze', model: 'engine-pipeline', costUsdOverride: 0.1234 });
  assert.equal(created[0].costUsd, 0.1234);
  assert.equal(created[0].unknownModel, false); // override suppresses the unknown flag
});

test('unknown model without override records 0 and flags unknownModel', async () => {
  await costLedger.record({ action: 'x', model: 'no/such-model', tokensIn: 100, tokensOut: 100 });
  assert.equal(created[0].costUsd, 0);
  assert.equal(created[0].unknownModel, true);
});

test('missing action/model is skipped (no row)', async () => {
  const r = await costLedger.record({ model: 'gpt-4o-mini' });
  assert.equal(r, null);
  assert.equal(created.length, 0);
});
