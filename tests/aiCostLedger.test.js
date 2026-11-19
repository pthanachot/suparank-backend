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
  // Current Claude IDs (balanced/premium presets, engine fallbacks), and the
  // engine's classify model. Unpriced, every premium run booked $0 COGS.
  'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5',
  'openai/gpt-5.4-nano', 'xiaomi/mimo-v2.5',
];

// Every model the writing engine can actually be configured with (base roles,
// every preset, and its reporting-only modelPricing map) must be in the
// registry, and at the same price, or the ledger books it as $0 or at a stale
// rate. Reads the sibling repo's models.json when it is checked out next to
// this one (skips otherwise, e.g. in a lone backend checkout).
test('registry covers and agrees with writing-engine models.json', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '..', 'writing-engine', 'models.json');
  if (!fs.existsSync(file)) { t.skip('writing-engine checkout not present'); return; }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prices = {};
  for (const role of Object.values(cfg.models || {})) {
    if (role && role.model && role.priceInputPerM != null) {
      prices[role.model] = { in: role.priceInputPerM, out: role.priceOutputPerM };
    }
  }
  for (const [id, p] of Object.entries(cfg.modelPricing || {})) {
    prices[id] = { in: p.priceInputPerM, out: p.priceOutputPerM };
  }
  const used = new Set(Object.keys(prices));
  for (const role of Object.values(cfg.models || {})) if (role && role.model) used.add(role.model);
  for (const preset of Object.values(cfg.presets || {})) {
    for (const [k, v] of Object.entries(preset)) if (!k.startsWith('$') && typeof v === 'string') used.add(v);
  }
  for (const id of used) {
    const r = costFor(id, 1_000_000, 1_000_000, id.includes('image') ? { images: 1 } : {});
    assert.ok(r.known, `writing-engine model ${id} is not in the backend registry`);
    const p = prices[id];
    if (p && !id.includes('image')) {
      const want = p.in + p.out;
      assert.ok(Math.abs(r.costUsd - want) < 1e-9, `${id}: registry prices 1M/1M at $${r.costUsd}, models.json at $${want}`);
    }
  }
});

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
