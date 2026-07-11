/**
 * Phase 6 — credit cost table + rules (spec-oracle).
 *
 * EXPECTED_PAID is transcribed DIRECTLY from GEO-PRICING-v4.md Table 2. If a cost
 * here disagrees with creditCosts.js, fix the config, not this fixture. Pins the
 * "each existing action deducts its exact cost" acceptance test, plus Option B,
 * the zero-credit list, variable/per-unit costs, caps, and the policy constants.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CREDIT_COSTS, ACTIVE_ACTIONS, FIXED_BUNDLE_ACTIONS } = require('../src/config/creditCosts');
const {
  resolveCredits, isActive, DEDUCTION_ORDER, REFUND_ORDER, CHARGE_POLICY, MARKUP_CLASSES,
} = require('../src/config/creditRules');

// v4.1 Table 2 — credit cost of each ACTIVE (exists-today) action, paid tier,
// default single-unit context.
const EXPECTED_PAID = {
  articleGenerate: 100,
  // fullDocRewrite (50) is DEFERRED/inactive — the /rewrite full-regenerate action
  // is unshipped; full-doc rewrites bill fullDocPass/articleGenerate. See the
  // "roadmap / not-built" test below. (Phase-14 review.)
  aiChatMessage: 1, // tokens 0 → 1
  inlineAction: 2,
  fullDocPass: 25,
  imageGenerate: 10,
  reScore: 10,
  briefOutline: 20,
  importUrl: 5,
  keywordLookup: 1, // 1 row
  promptResearch: 10,
  trackerRefreshAll: 5, // 1 active prompt
  trackerRefreshSingle: 5, // Phase 8: on-demand single-prompt refresh (flat 5)
  contentAudit: 5,
  internalLinks: 10,
  // voiceExtraction is INACTIVE (Phase 6): no distinct endpoint — voice use during
  // a rewrite is already billed via the agent/chat path. See creditCosts note.
  avatarCreate: 10,   // billed on the avatar preview regen (real AI path)
  brandVoiceTest: 2,  // ~150-word test preview (re-costed from 3)
  avatarTest: 2,
};

test('every active action deducts its exact Table-2 cost (paid tier)', () => {
  // The set of active actions is exactly what we priced — no drift either way.
  assert.deepEqual(ACTIVE_ACTIONS.slice().sort(), Object.keys(EXPECTED_PAID).sort());
  for (const [action, cost] of Object.entries(EXPECTED_PAID)) {
    assert.equal(resolveCredits(action, { tier: 'professional' }), cost, `${action} paid cost`);
  }
});

test('roadmap / not-built actions are inactive and never wired', () => {
  for (const a of ['serpDeepDive', 'clusteringRun', 'relatedIdeasReport',
    'scheduledReAudit', 'extraPromptSlotDaily', 'extraPromptSlotWeekly',
    'voiceExtraction', // Phase 6: no distinct endpoint → inactive (already billed via rewrite)
    'fullDocRewrite']) { // Phase 14: DEFERRED — /rewrite full-regenerate unwired; bills fullDocPass/articleGenerate
    assert.equal(isActive(a), false, `${a} must be inactive`);
    assert.equal(CREDIT_COSTS[a].active, false);
  }
});

test('Option B — Free fixed-bundle actions deduct 0 (count-gated elsewhere)', () => {
  // article, audit, keyword lookup, tracker check.
  assert.deepEqual(FIXED_BUNDLE_ACTIONS.slice().sort(),
    ['articleGenerate', 'contentAudit', 'keywordLookup'].sort());
  for (const a of FIXED_BUNDLE_ACTIONS) {
    assert.equal(resolveCredits(a, { tier: 'free' }), 0, `${a} is 0 for Free`);
    assert.ok(resolveCredits(a, { tier: 'professional' }) > 0, `${a} is >0 for paid`);
  }
});

test('Option B — Free à-la-carte actions still cost full price (drawn from sample pool)', () => {
  // Not in the fixed bundle → Free pays from its 200 sample pool, same as paid.
  for (const a of ['aiChatMessage', 'inlineAction', 'imageGenerate',
    'fullDocPass', 'briefOutline', 'reScore', 'importUrl']) {
    assert.equal(resolveCredits(a, { tier: 'free' }), resolveCredits(a, { tier: 'professional' }),
      `${a} costs the same for Free (à-la-carte)`);
  }
});

test('zero-credit variant — caller signal forces 0 even on a paid tier', () => {
  assert.equal(resolveCredits('imageGenerate', { tier: 'professional', zeroCredit: true }), 0);
  assert.equal(resolveCredits('trackerRefreshAll', { tier: 'agency', zeroCredit: true, activePrompts: 20 }), 0);
});

test('variable cost — AI chat: ≤8K tokens = 1, above = 2', () => {
  assert.equal(resolveCredits('aiChatMessage', { tier: 'standard', tokens: 0 }), 1);
  assert.equal(resolveCredits('aiChatMessage', { tier: 'standard', tokens: 8000 }), 1);
  assert.equal(resolveCredits('aiChatMessage', { tier: 'standard', tokens: 8001 }), 2);
  assert.equal(resolveCredits('aiChatMessage', { tier: 'standard', tokens: 50000 }), 2);
});

test('per-row cost — keyword lookup: 1/row, capped at 50', () => {
  assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 1 }), 1);
  assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 30 }), 30);
  assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 50 }), 50);
  assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 80 }), 50); // capped
  assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 0 }), 0);
});

test('per-prompt cost — refresh-all: 5 × active prompts', () => {
  assert.equal(resolveCredits('trackerRefreshAll', { tier: 'agency', activePrompts: 1 }), 5);
  assert.equal(resolveCredits('trackerRefreshAll', { tier: 'agency', activePrompts: 12 }), 60);
  assert.equal(resolveCredits('trackerRefreshAll', { tier: 'agency', activePrompts: 0 }), 0);
});

test('unknown action throws (catches typos at wiring time)', () => {
  assert.throws(() => resolveCredits('notAThing', { tier: 'free' }), /Unknown credit action/);
});

test('accounting policy constants match the estimate→settle→refund design', () => {
  assert.deepEqual(DEDUCTION_ORDER, ['subscription', 'general', 'user_free']);
  assert.deepEqual(REFUND_ORDER, ['user_free', 'general', 'subscription']);
  assert.equal(CHARGE_POLICY.refundOverestimate, true);
  assert.equal(CHARGE_POLICY.chargeCap, 'estimate');
});

test('three markup classes exist and every active action maps to one', () => {
  assert.deepEqual(Object.keys(MARKUP_CLASSES).sort(), ['infra', 'licensed_data', 'platform_ai']);
  for (const a of ACTIVE_ACTIONS) {
    assert.ok(MARKUP_CLASSES[CREDIT_COSTS[a].markupClass], `${a} has a valid markupClass`);
  }
});

test('exact markup class per action (keyword=licensed_data, import+internal-links=infra, rest=platform_ai)', () => {
  assert.equal(CREDIT_COSTS.keywordLookup.markupClass, 'licensed_data');
  assert.equal(CREDIT_COSTS.importUrl.markupClass, 'infra');
  assert.equal(CREDIT_COSTS.internalLinks.markupClass, 'infra'); // algorithmic, no LLM
  for (const a of ACTIVE_ACTIONS) {
    if (['keywordLookup', 'importUrl', 'internalLinks'].includes(a)) continue;
    assert.equal(CREDIT_COSTS[a].markupClass, 'platform_ai', `${a} should be platform_ai`);
  }
});

// ── Robustness (Phase-6 review hardening) ──────────────────────────────

test('resolving an INACTIVE action throws — never bill a not-wired action', () => {
  for (const a of ['serpDeepDive', 'clusteringRun', 'scheduledReAudit']) {
    assert.throws(() => resolveCredits(a, { tier: 'professional' }), /not active/, `${a} must not resolve`);
  }
});

test('non-numeric / NaN / negative unit counts never leak a NaN or negative credit', () => {
  for (const bad of ['x', NaN, undefined, null, -5, -1]) {
    const kw = resolveCredits('keywordLookup', { tier: 'standard', rows: bad });
    assert.ok(Number.isFinite(kw) && kw >= 0, `keyword rows=${bad} → finite ≥0 (got ${kw})`);
    const rf = resolveCredits('trackerRefreshAll', { tier: 'agency', activePrompts: bad });
    assert.ok(Number.isFinite(rf) && rf >= 0, `refresh activePrompts=${bad} → finite ≥0 (got ${rf})`);
  }
  assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: -5 }), 0);
  assert.equal(resolveCredits('trackerRefreshAll', { tier: 'agency', activePrompts: -1 }), 0);
});

test('ctx may be omitted entirely (defaults to a single paid unit)', () => {
  assert.equal(resolveCredits('articleGenerate'), 100);
  assert.equal(resolveCredits('keywordLookup'), 1);
  assert.equal(resolveCredits('trackerRefreshAll'), 5);
});

test('Free + variable chat above 8K still costs 2 (à-la-carte from sample pool)', () => {
  assert.equal(resolveCredits('aiChatMessage', { tier: 'free', tokens: 8001 }), 2);
  assert.equal(resolveCredits('aiChatMessage', { tier: 'free', tokens: 100 }), 1);
});

test('zeroCredit overrides a per-row cost (stock-image-style zero-rating)', () => {
  assert.equal(resolveCredits('keywordLookup', { tier: 'professional', zeroCredit: true, rows: 80 }), 0);
});

test('à-la-carte set is exactly ACTIVE − FIXED_BUNDLE (no action escapes Option-B coverage)', () => {
  const alaCarte = ACTIVE_ACTIONS.filter((a) => !FIXED_BUNDLE_ACTIONS.includes(a));
  // Every à-la-carte action costs the SAME for Free as paid (drawn from sample pool),
  // and every fixed-bundle action is 0 for Free — together covering all active actions.
  for (const a of alaCarte) {
    const ctx = a === 'aiChatMessage' ? { tokens: 100 } : {};
    assert.equal(resolveCredits(a, { tier: 'free', ...ctx }), resolveCredits(a, { tier: 'professional', ...ctx }),
      `${a} (à-la-carte) same for Free`);
  }
  for (const a of FIXED_BUNDLE_ACTIONS) {
    assert.equal(resolveCredits(a, { tier: 'free' }), 0, `${a} (bundle) is 0 for Free`);
  }
});
