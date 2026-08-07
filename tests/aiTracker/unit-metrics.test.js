/**
 * Phase 2 — metrics + position-formula unit tests.
 *
 * Targets:
 *   - computePosition (engine export): the 1-10 rank mapping table from the
 *     F03 dossier §2 Phase E, plus range/monotonicity properties.
 *   - computeWeightedVisibility (controller.__test): S71 error exclusion,
 *     empty/all-errored inputs, the null-position 50-default.
 *   - computeMetrics (controller.__test): carry-forward precedence,
 *     share-of-voice bounds (F6-01), sentiment filtering, hostname-exact
 *     citation counting (F6-02).
 *
 * Pure math — no DB, no network. Run: node --test tests/aiTracker/unit-metrics.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { computePosition } = require('../../src/services/aiTrackerScanEngine');
const { __test, generatePromptSuggestions } = require('../../src/controllers/aiTrackerController');
const { computeWeightedVisibility, computeMetrics } = __test;

// ─── generatePromptSuggestions runtime export (report layer seam) ──────────
// reportService (client report "What's next") consumes this at snapshot
// generation time — it must stay a runtime export, not just a __test seam.
describe('generatePromptSuggestions export', () => {
  it('is a runtime export returning the 6 generic suggestions for a never-scanned prompt', () => {
    assert.equal(typeof generatePromptSuggestions, 'function');
    const generic = generatePromptSuggestions(null, null);
    assert.equal(generic.length, 6);
    assert.ok(generic.every((s) => typeof s === 'string' && s.length > 0));
  });
});

describe('computePosition (F03 §2 Phase E table)', () => {
  it('table: dossier scenarios', () => {
    assert.equal(computePosition(1, 1), 1, 'only brand → perfect');
    assert.equal(computePosition(1, 2), 1);
    assert.equal(computePosition(2, 2), 10);
    assert.equal(computePosition(3, 5), 6, 'round(5.5) rounds away from zero in JS');
    assert.equal(computePosition(5, 10), 5);
    assert.equal(computePosition(5, 20), 3, 'top 25% of a crowded field');
    assert.equal(computePosition(10, 100), 2, 'top 10% of a very crowded field');
    assert.equal(computePosition(50, 100), 5);
  });

  it('property: result is always in [1, 10] for any valid rank/total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 499 }),
        (total, rankOffset) => {
          const rank = Math.min(1 + rankOffset, total);
          const pos = computePosition(rank, total);
          return pos >= 1 && pos <= 10;
        },
      ),
      { numRuns: 10000 },
    );
  });

  it('property: monotone in rank — a worse rank never yields a better position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 500 }),
        fc.integer({ min: 1, max: 499 }),
        (total, r) => {
          const rank = Math.min(r, total - 1);
          return computePosition(rank, total) <= computePosition(rank + 1, total);
        },
      ),
      { numRuns: 10000 },
    );
  });
});

// ── computeWeightedVisibility ───────────────────────────────────────────────

function pr(over = {}) {
  return { mentioned: false, cited: false, position: null, error: false, ...over };
}

describe('computeWeightedVisibility (0.4·mention + 0.3·position + 0.3·citation)', () => {
  it('empty / null input → 0', () => {
    assert.equal(computeWeightedVisibility([]), 0);
    assert.equal(computeWeightedVisibility(null), 0);
  });

  it('all-errored input → 0 (never counts as "not mentioned")', () => {
    assert.equal(computeWeightedVisibility([pr({ error: true }), pr({ error: true })]), 0);
  });

  it('perfect single platform: mentioned + position 1 + cited → 100', () => {
    assert.equal(computeWeightedVisibility([pr({ mentioned: true, cited: true, position: 1 })]), 100);
  });

  it('not mentioned anywhere → 0', () => {
    assert.equal(computeWeightedVisibility([pr(), pr()]), 0);
  });

  it('null position (fallback-analyzed scans) defaults the position score to 50', () => {
    // mentionRate 100·0.4 + positionScore 50·0.3 + citationRate 0·0.3 = 55
    assert.equal(computeWeightedVisibility([pr({ mentioned: true })]), 55);
  });

  it('S71: an errored platform is excluded — rates computed over valid platforms only', () => {
    const clean = pr({ mentioned: true, cited: true, position: 1 });
    assert.equal(
      computeWeightedVisibility([clean, pr({ error: true })]),
      computeWeightedVisibility([clean]),
      'adding an errored platform must not change the score',
    );
  });

  it('position 10 scores 0 on the position component', () => {
    // mention 100·0.4 + position 0·0.3 + citation 0·0.3 = 40
    assert.equal(computeWeightedVisibility([pr({ mentioned: true, position: 10 })]), 40);
  });

  it('citation rate is relative to MENTIONED platforms, not all platforms', () => {
    // 2 valid: one mentioned+cited (pos 1), one unmentioned.
    // mentionRate 50·0.4 + positionScore 100·0.3 + citationRate 100·0.3 = 80
    assert.equal(
      computeWeightedVisibility([pr({ mentioned: true, cited: true, position: 1 }), pr()]),
      80,
    );
  });
});

// ── computeMetrics ──────────────────────────────────────────────────────────

function scanWith(results, competitorResults = []) {
  return { results, competitorResults };
}

function resultFor(promptId, platforms) {
  return { promptId, platforms };
}

describe('computeMetrics', () => {
  it('null scan → null', () => {
    assert.equal(computeMetrics(null, 0, null, 'suparank.com'), null);
  });

  it('S71: errored platforms are excluded from mention/citation totals', () => {
    const scan = scanWith([
      resultFor('p1', [
        pr({ mentioned: true, cited: true, position: 1 }),
        pr({ error: true, mentioned: true, cited: true }), // must be ignored
      ]),
    ]);
    const m = computeMetrics(scan, 1, null, 'suparank.com');
    assert.equal(m.mentionRate, 100, 'errored platform not in the denominator');
    assert.equal(m.citationRate, 100);
  });

  it('empty results → zero rates, null averages', () => {
    const m = computeMetrics(scanWith([]), 0, null, 'suparank.com');
    assert.equal(m.mentionRate, 0);
    assert.equal(m.citationRate, 0);
    assert.equal(m.visibility, 0);
    assert.equal(m.avgSentiment, null);
    assert.equal(m.averagePosition, null);
  });

  it('carry-forward: FIRST scan in carryScans wins per prompt (callers pass newest first)', () => {
    const newest = scanWith([resultFor('p1', [pr({ mentioned: true, position: 1 })])]);
    const older = scanWith([resultFor('p1', [pr({ mentioned: false })])]);
    const m = computeMetrics(newest, 1, [newest, older], 'suparank.com');
    assert.equal(m.mentionRate, 100, 'newest-first result must win the carry-forward merge');
  });

  it('F6-01: share of voice is bounded ≤ 100 even when no isOwn competitor entry exists', () => {
    const scan = scanWith(
      [resultFor('p1', [pr({ mentioned: true, position: 1 })])],
      [{ name: 'Rival', isOwn: false, mentions: 1 }], // legacy: no own entry
    );
    const m = computeMetrics(scan, 1, null, 'suparank.com');
    assert.ok(m.shareOfVoice >= 0 && m.shareOfVoice <= 100);
    // own(1) / (comp 1 + own 1) = 50
    assert.equal(m.shareOfVoice, 50);
  });

  it('share of voice uses the isOwn entry when present', () => {
    const scan = scanWith(
      [resultFor('p1', [pr({ mentioned: true })])],
      [
        { name: 'suparank', isOwn: true, mentions: 3 },
        { name: 'Rival', isOwn: false, mentions: 1 },
      ],
    );
    const m = computeMetrics(scan, 1, null, 'suparank.com');
    assert.equal(m.shareOfVoice, 75, '3 of 4 total mentions');
  });

  it('avgSentiment averages only mentioned, non-errored platforms with a score', () => {
    const scan = scanWith([
      resultFor('p1', [
        pr({ mentioned: true, sentimentScore: 80 }),
        pr({ mentioned: true, sentimentScore: 40, error: true }), // excluded
        pr({ mentioned: false, sentimentScore: 0 }), // excluded (not mentioned)
        pr({ mentioned: true, sentimentScore: null }), // excluded (no score)
      ]),
    ]);
    assert.equal(computeMetrics(scan, 1, null, 'suparank.com').avgSentiment, 80);
  });

  it('F6-02: totalCitationCount counts hostname-exact matches only (no substring lookalikes)', () => {
    const scan = scanWith([
      resultFor('p1', [
        pr({
          mentioned: true,
          cited: true,
          citedUrls: [
            'https://suparank.com/a',
            'https://www.suparank.com/b',
            'https://realsuparank.com/lookalike', // must NOT count
            'https://suparank.com.evil.com/x', // must NOT count
          ],
        }),
      ]),
    ]);
    assert.equal(computeMetrics(scan, 1, null, 'suparank.com').totalCitationCount, 2);
  });

  it('returns the full metric shape', () => {
    const m = computeMetrics(scanWith([]), 5, null, 'suparank.com');
    assert.deepEqual(
      Object.keys(m).sort(),
      ['averagePosition', 'avgSentiment', 'citationRate', 'mentionRate', 'promptCount', 'shareOfVoice', 'totalCitationCount', 'visibility'],
    );
    assert.equal(m.promptCount, 5);
  });
});
