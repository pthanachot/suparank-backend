'use strict';

/**
 * Wave 5 Phase 2 — range resolution and the per-source horizon (plan §9.0).
 *
 * The rule under test: the data source decides the horizon, not the request.
 * Rollup-backed panels serve any window because those rows never expire; raw
 * ObservationEvent-backed panels can only see the last 90 days, and a longer
 * request must be reported as partial rather than silently under-reported.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveRange, RAW_HORIZON_DAYS } = require('../src/services/usageAnalyticsService');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-09T12:00:00.000Z');
const iso = (d) => d.toISOString();

test('days presets resolve to a window ending now', () => {
  const r = resolveRange({ days: 28, now: NOW });
  assert.equal(r.days, 28);
  assert.equal(+r.to, +NOW);
  assert.equal(+r.from, +new Date(NOW.getTime() - 28 * DAY_MS));
  assert.equal(r.truncated, false);
});

test('an explicit from/to pair is honoured', () => {
  const from = new Date('2026-07-01T00:00:00.000Z');
  const to = new Date('2026-07-31T23:59:59.999Z');
  const r = resolveRange({ from: iso(from), to: iso(to), now: NOW });
  assert.equal(+r.from, +from);
  assert.equal(+r.to, +to);
  assert.equal(r.truncated, false);
});

test('raw-backed windows are clamped at the 90-day horizon and flagged partial', () => {
  const r = resolveRange({ days: 365, source: 'raw', now: NOW });
  const horizon = new Date(NOW.getTime() - RAW_HORIZON_DAYS * DAY_MS);
  assert.equal(r.truncated, true, 'must announce the clamp');
  assert.equal(+r.from, +horizon, 'window starts at the horizon, not 365 days back');
  assert.equal(+r.requestedFrom, +new Date(NOW.getTime() - 365 * DAY_MS), 'the ask is preserved for the UI to explain');
  assert.equal(+r.rawAvailableFrom, +horizon);
});

test('rollup-backed windows are never clamped — those rows have no TTL', () => {
  const r = resolveRange({ days: 365, source: 'rollup', now: NOW });
  assert.equal(r.truncated, false);
  assert.equal(+r.from, +new Date(NOW.getTime() - 365 * DAY_MS));
  assert.equal(r.rawAvailableFrom, null);
});

test('a future end is clamped to now rather than inventing empty days', () => {
  const r = resolveRange({ from: '2026-08-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', now: NOW });
  assert.equal(+r.to, +NOW);
});

test('invalid ranges throw RangeError so the controller can answer 400', () => {
  // Silently defaulting would hand the caller numbers for a period they never
  // asked about — worse than an error.
  const bad = [
    { from: 'not-a-date', to: iso(NOW) },
    { from: iso(NOW), to: 'not-a-date' },
    { from: '2026-08-01T00:00:00.000Z' },                                  // half a pair
    { to: '2026-08-01T00:00:00.000Z' },                                    // the other half
    { from: '2026-08-05T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },  // reversed
    { from: '2027-01-01T00:00:00.000Z', to: '2027-02-01T00:00:00.000Z' },  // entirely future
  ];
  for (const args of bad) {
    assert.throws(() => resolveRange({ ...args, now: NOW }), RangeError, `should reject ${JSON.stringify(args)}`);
  }
});

test('a garbage days value falls back to the default window', () => {
  assert.equal(resolveRange({ days: 'abc', now: NOW }).days, 28);
  assert.equal(resolveRange({ days: -5, now: NOW }).days, 1);
});
