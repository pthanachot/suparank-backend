'use strict';

/**
 * Phase 14 — margin report core + tail-risk cohort telemetry.
 * Pure/monkey-patched; no DB, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeTierMargins, planIdToTier, MARGIN_TARGETS, MARGIN_TOLERANCE } = require('../src/services/marginReport');
const UsageTracker = require('../src/models/UsageTracker');
const { countHighVolumeOrgs, currentPeriod, ARTICLE_TAIL_RISK_THRESHOLD } = require('../src/services/tailRiskService');

// ─── Margin report core ────────────────────────────────────────────────────

test('margin targets match the v4.1 pricing doc (74/63/58)', () => {
  assert.deepStrictEqual(MARGIN_TARGETS, { standard: 0.74, professional: 0.63, agency: 0.58 });
});

test('computeTierMargins: at/above target passes, below target flags', () => {
  const m = computeTierMargins({
    revenueByTier: { standard: 1000, professional: 1000, agency: 1000 },
    cogsByTier: { standard: 200, professional: 500, agency: 420 },
  });
  // Standard 80% ≥ 74% → ok
  assert.strictEqual(m.standard.marginPct, 0.8);
  assert.strictEqual(m.standard.belowTarget, false);
  // Professional 50% < (63−3)% → below
  assert.strictEqual(m.professional.marginPct, 0.5);
  assert.strictEqual(m.professional.belowTarget, true);
  // Agency 58% == target → not below
  assert.ok(Math.abs(m.agency.marginPct - 0.58) < 1e-9);
  assert.strictEqual(m.agency.belowTarget, false);
});

test('computeTierMargins: zero revenue → marginPct null, belowTarget null (nothing to measure)', () => {
  const m = computeTierMargins({ revenueByTier: {}, cogsByTier: { standard: 10 } });
  assert.strictEqual(m.standard.marginPct, null);
  assert.strictEqual(m.standard.belowTarget, null);
  assert.strictEqual(m.standard.revenue, 0);
});

test('computeTierMargins: tolerance band — just under target is not flagged', () => {
  // Standard target 74%, tolerance 3% → 72% margin is within tolerance.
  const m = computeTierMargins({ revenueByTier: { standard: 100 }, cogsByTier: { standard: 28 } }); // 72%
  assert.ok(Math.abs(m.standard.marginPct - 0.72) < 1e-9);
  assert.strictEqual(m.standard.belowTarget, false, `72% within ${MARGIN_TOLERANCE} of 74%`);
});

test('computeTierMargins: non-finite inputs coerce to 0', () => {
  const m = computeTierMargins({ revenueByTier: { standard: NaN }, cogsByTier: { standard: undefined } });
  assert.strictEqual(m.standard.revenue, 0);
  assert.strictEqual(m.standard.cogs, 0);
  assert.strictEqual(m.standard.marginPct, null);
});

test('planIdToTier maps monthly/yearly + pro alias', () => {
  assert.strictEqual(planIdToTier('standard-monthly'), 'standard');
  assert.strictEqual(planIdToTier('standard-yearly'), 'standard');
  assert.strictEqual(planIdToTier('pro-monthly'), 'professional');
  assert.strictEqual(planIdToTier('professional-yearly'), 'professional');
  assert.strictEqual(planIdToTier('agency-monthly'), 'agency');
  assert.strictEqual(planIdToTier('free'), null);
  assert.strictEqual(planIdToTier(null), null);
});

// ─── Tail-risk cohort ────────────────────────────────────────────────────────

test('tail-risk threshold is 200 and period is UTC YYYY-MM', () => {
  assert.strictEqual(ARTICLE_TAIL_RISK_THRESHOLD, 200);
  assert.strictEqual(currentPeriod(new Date(Date.UTC(2026, 0, 5))), '2026-01');
  assert.strictEqual(currentPeriod(new Date(Date.UTC(2026, 11, 31))), '2026-12');
});

test('countHighVolumeOrgs queries the right period + >threshold', async () => {
  const real = UsageTracker.countDocuments;
  let captured;
  UsageTracker.countDocuments = async (q) => { captured = q; return 4; };
  try {
    const n = await countHighVolumeOrgs({ period: '2026-07' });
    assert.strictEqual(n, 4);
    assert.strictEqual(captured.period, '2026-07');
    assert.deepStrictEqual(captured.articlesCreated, { $gt: 200 });
  } finally {
    UsageTracker.countDocuments = real;
  }
});

test('countHighVolumeOrgs honors a custom threshold', async () => {
  const real = UsageTracker.countDocuments;
  let captured;
  UsageTracker.countDocuments = async (q) => { captured = q; return 0; };
  try {
    await countHighVolumeOrgs({ period: '2026-07', threshold: 300 });
    assert.deepStrictEqual(captured.articlesCreated, { $gt: 300 });
  } finally {
    UsageTracker.countDocuments = real;
  }
});
