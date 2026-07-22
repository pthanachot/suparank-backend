'use strict';

// Phase 6b: the tier-info controller exposes a resolved, tier-aware credit-cost
// map built from ACTIVE_ACTIONS via resolveCredits. This pins that contract:
// paid tiers see standard prices; Free sees 0 for the fixed-bundle actions; no
// inactive/roadmap keys leak.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_ACTIONS } = require('../src/config/creditCosts');
const { resolveCredits } = require('../src/config/creditRules');

// Mirror of the controller's build (tierController.getTierInfo).
function buildCreditCosts(tier) {
  const out = {};
  for (const action of ACTIVE_ACTIONS) {
    try { out[action] = resolveCredits(action, { tier }); } catch { /* skip */ }
  }
  return out;
}

test('paid tier: editor actions carry their standard credit prices', () => {
  const c = buildCreditCosts('pro');
  assert.equal(c.articleGenerate, 100);
  assert.equal(c.fullDocPass, 25);
  assert.equal(c.inlineAction, 2);
  assert.equal(c.imageGenerate, 10);
  assert.equal(c.reScore, 10);
  assert.equal(c.aiChatMessage, 1); // base (no token ctx)
});

test('free tier: fixed-bundle actions resolve to 0, à-la-carte unchanged', () => {
  const c = buildCreditCosts('free');
  assert.equal(c.articleGenerate, 0); // bundle-gated separately by article slots
  assert.equal(c.fullDocPass, 25);
  assert.equal(c.inlineAction, 2);
});

test('map only contains active actions (no inactive/roadmap keys leak)', () => {
  const c = buildCreditCosts('pro');
  for (const k of Object.keys(c)) assert.ok(ACTIVE_ACTIONS.includes(k), `${k} should be active`);
  // A known inactive/roadmap action must never appear.
  assert.equal(c.fullDocRewrite, undefined);
  assert.equal(c.serpDeepDive, undefined);
});
