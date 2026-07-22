'use strict';

// Phase 7.3: the observe controller's ALLOWED_EVENTS is the enforcement point —
// only known event names are stored. Pin the contract (the 5 plan events + the
// 4 product metrics) so a rename on either side is caught.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_EVENTS } = require('../src/controllers/observeController');

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

test('whitelist rejects unknown / arbitrary event names', () => {
  for (const e of ['', 'drop_table', 'ai_edit', 'random_event', 'plan_turn_count']) {
    assert.equal(ALLOWED_EVENTS.has(e), false, `${e} must NOT be allowed`);
  }
});
