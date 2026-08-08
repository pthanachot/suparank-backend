'use strict';

// Phase 7.3 / Wave 0: the analytics event registry (src/config/analyticsEvents)
// is the enforcement point — only registered event names are stored. Pin the
// contract (plan events + product metrics + Wave 0 additions) so a rename on
// either side is caught, and assert the controller serves the registry's set
// (not a drifted copy).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_EVENTS } = require('../src/controllers/observeController');
const registry = require('../src/config/analyticsEvents');

test('controller allow-set IS the registry set (no drifted copy)', () => {
  assert.equal(ALLOWED_EVENTS, registry.ALLOWED_EVENTS);
  // And the set is derived from the registry's keys.
  assert.deepEqual([...ALLOWED_EVENTS].sort(), Object.keys(registry.EVENTS).sort());
});

test('whitelist admits the plan-mode events', () => {
  for (const e of ['plan_proposed', 'drift_observed', 'time_to_approval', 'plan_approval_rate']) {
    assert.ok(ALLOWED_EVENTS.has(e), `${e} should be allowed`);
  }
});

test('whitelist admits the Phase 7 product metrics', () => {
  for (const e of ['ai_edit_applied', 'ai_edit_reverted', 'time_to_first_word', 'analysis_recovered']) {
    assert.ok(ALLOWED_EVENTS.has(e), `${e} should be allowed`);
  }
});

test('Wave 0: ai_removed_restored is registered (was emitted but silently dropped)', () => {
  assert.ok(ALLOWED_EVENTS.has('ai_removed_restored'));
});

test('whitelist rejects unknown / arbitrary event names', () => {
  for (const e of ['', 'drop_table', 'ai_edit', 'random_event', 'plan_turn_count']) {
    assert.equal(ALLOWED_EVENTS.has(e), false, `${e} must NOT be allowed`);
  }
});

test('every registry entry declares a lane and description', () => {
  for (const [name, def] of Object.entries(registry.EVENTS)) {
    assert.ok(['client', 'server'].includes(def.lane), `${name} lane`);
    assert.ok(typeof def.description === 'string' && def.description.length > 0, `${name} description`);
  }
});
