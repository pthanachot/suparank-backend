/**
 * Phase 2 — fixed-rate scheduler property tests (fast-check) + tables.
 *
 * Targets the pure seams extracted from executeScan:
 *   freqMsOf / cronToleranceMs / isPromptDue / advanceLastScannedAt
 * (aiTrackerController.__test). These encode the CURRENT, post-dossier
 * semantics: F4-27 is fixed (future-dated lastScannedAt normalizes to now),
 * single-prompt refresh anchors to now, catch-up jumps whole intervals.
 *
 * Pure math — no DB, no network. Run: node --test tests/aiTracker/unit-scheduler.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { __test } = require('../../src/controllers/aiTrackerController');
const { FREQ_DAYS, freqMsOf, cronToleranceMs, isPromptDue, advanceLastScannedAt } = __test;

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1); // fixed anchor — properties never read the clock

// Time scales chosen so freqMs stays an integer (86_400_000 divides cleanly),
// keeping grid assertions float-noise-free. These mirror real dev usage.
const timeScaleArb = fc.constantFrom(1, 24, 200, 10000);
const freqArb = fc.constantFrom('Daily', 'Weekly', 'Bi-weekly', 'Monthly', 'Bogus');

const RUNS = { numRuns: 10000 };

describe('freqMsOf', () => {
  it('unknown frequency falls back to Weekly', () => {
    assert.equal(freqMsOf('Bogus', 1), freqMsOf('Weekly', 1));
    assert.equal(freqMsOf(undefined, 1), 7 * DAY);
  });
  it('table: all four frequencies at scale 1', () => {
    assert.equal(freqMsOf('Daily', 1), 1 * DAY);
    assert.equal(freqMsOf('Weekly', 1), 7 * DAY);
    assert.equal(freqMsOf('Bi-weekly', 1), 14 * DAY);
    assert.equal(freqMsOf('Monthly', 1), 30 * DAY);
  });
  it('property: scaled interval equals days/scale days within 1 ms', () => {
    // Discovered by this property (twice): IEEE-754 makes the exact value
    // depend on multiplication order — the implementation's chained
    // `x * 24 * 60 * 60 * 1000` rounds differently from `x * 86_400_000`,
    // and 7/10000-style divisions aren't binary-exact to begin with. The
    // CONTRACT is "days/scale days, sub-ms noise irrelevant to scheduling",
    // so assert with a 1 ms tolerance; a wrong fallback or unit bug would be
    // off by orders of magnitude and still fail loudly.
    fc.assert(
      fc.property(freqArb, timeScaleArb, (freq, scale) => {
        const days = FREQ_DAYS[freq] || 7;
        return Math.abs(freqMsOf(freq, scale) - (days * DAY) / scale) <= 1;
      }),
      RUNS,
    );
  });
});

describe('advanceLastScannedAt — fixed-rate grid properties', () => {
  it('property: past-dated history lands ON the grid (old + k·freq, integer k ≥ 1)', () => {
    fc.assert(
      fc.property(
        freqArb,
        timeScaleArb,
        fc.integer({ min: 0, max: 400 * DAY }), // elapsed since lastScannedAt
        fc.integer({ min: 0, max: 60_000 }), // now = scanStart + small delta
        (freq, scale, elapsed, nowDelta) => {
          const lastScannedAt = new Date(BASE);
          const scanStart = new Date(BASE + elapsed);
          const now = new Date(BASE + elapsed + nowDelta);
          const advanced = advanceLastScannedAt(
            { frequency: freq, lastScannedAt },
            { scanStart, now, timeScale: scale, singlePrompt: false },
          );
          const freqMs = freqMsOf(freq, scale);
          // Discovered by this property: at dev time scales (1/200, 7/10000…)
          // freqMs carries sub-ms IEEE-754 noise, and the Date constructor
          // truncates it — so grid points are integer-ms approximations of
          // k·freqMs. Assert "on the grid" with a ≤1 ms truncation tolerance;
          // sub-ms drift is invisible to scheduling (cron granularity is 1 min).
          const delta = advanced.getTime() - lastScannedAt.getTime();
          const k = Math.round(delta / freqMs);
          return k >= 1 && Math.abs(delta - k * freqMs) <= 1;
        },
      ),
      RUNS,
    );
  });

  it('property: drift is bounded by one interval — advanced ∈ (scanStart − freq, scanStart + freq]', () => {
    fc.assert(
      fc.property(
        freqArb,
        timeScaleArb,
        fc.integer({ min: 0, max: 400 * DAY }),
        (freq, scale, elapsed) => {
          const lastScannedAt = new Date(BASE);
          const scanStart = new Date(BASE + elapsed);
          const advanced = advanceLastScannedAt(
            { frequency: freq, lastScannedAt },
            { scanStart, now: scanStart, timeScale: scale, singlePrompt: false },
          );
          const freqMs = freqMsOf(freq, scale);
          // ±1 ms tolerance: at fractional dev-scale intervals, Date truncation
          // can land the boundary 1 ms outside the exact float bound (caught by
          // fast-check at ~1-in-40k draws — Weekly@10000× with elapsed on a
          // deep grid multiple). Sub-ms is meaningless at cron granularity.
          return (
            advanced.getTime() > scanStart.getTime() - freqMs - 1 &&
            advanced.getTime() <= scanStart.getTime() + freqMs + 1
          );
        },
      ),
      RUNS,
    );
  });

  it('property: next due (advanced + freq) is always after scanStart — no double-charge in the same instant', () => {
    fc.assert(
      fc.property(
        freqArb,
        timeScaleArb,
        fc.integer({ min: 0, max: 400 * DAY }),
        (freq, scale, elapsed) => {
          const lastScannedAt = new Date(BASE);
          const scanStart = new Date(BASE + elapsed);
          const advanced = advanceLastScannedAt(
            { frequency: freq, lastScannedAt },
            { scanStart, now: scanStart, timeScale: scale, singlePrompt: false },
          );
          // Same ±1 ms Date-truncation tolerance as the drift bound above.
          return advanced.getTime() + freqMsOf(freq, scale) > scanStart.getTime() - 1;
        },
      ),
      RUNS,
    );
  });

  it('property (F4-27 semantics): FUTURE-dated lastScannedAt normalizes to now — never pushed further out', () => {
    fc.assert(
      fc.property(
        freqArb,
        timeScaleArb,
        fc.integer({ min: 1, max: 40 * DAY }), // lastScannedAt AHEAD of scanStart
        (freq, scale, ahead) => {
          const scanStart = new Date(BASE);
          const now = new Date(BASE + 5_000);
          const advanced = advanceLastScannedAt(
            { frequency: freq, lastScannedAt: new Date(BASE + ahead) },
            { scanStart, now, timeScale: scale, singlePrompt: false },
          );
          return advanced.getTime() === now.getTime();
        },
      ),
      RUNS,
    );
  });

  it('property: single-prompt refresh ALWAYS anchors to now (past, future, or missing history)', () => {
    fc.assert(
      fc.property(
        freqArb,
        timeScaleArb,
        fc.option(fc.integer({ min: -400 * DAY, max: 40 * DAY }), { nil: undefined }),
        (freq, scale, offset) => {
          const scanStart = new Date(BASE);
          const now = new Date(BASE + 3_000);
          const p = {
            frequency: freq,
            lastScannedAt: offset === undefined ? undefined : new Date(BASE + offset),
          };
          const advanced = advanceLastScannedAt(p, { scanStart, now, timeScale: scale, singlePrompt: true });
          return advanced.getTime() === now.getTime();
        },
      ),
      RUNS,
    );
  });

  it('table: the dossier worked example — Weekly prompt scanned 15.58 days late jumps 2 intervals', () => {
    // lastScannedAt = Mar 1 00:00 UTC; server down; scan runs Mar 16 14:00 UTC.
    const last = new Date(Date.UTC(2026, 2, 1, 0, 0));
    const scanStart = new Date(Date.UTC(2026, 2, 16, 14, 0));
    const advanced = advanceLastScannedAt(
      { frequency: 'Weekly', lastScannedAt: last },
      { scanStart, now: scanStart, timeScale: 1, singlePrompt: false },
    );
    assert.equal(advanced.getTime(), Date.UTC(2026, 2, 15, 0, 0), 'jumps to Mar 15 (2 whole intervals)');
    assert.equal(advanced.getTime() + freqMsOf('Weekly', 1), Date.UTC(2026, 2, 22, 0, 0), 'next due Mar 22');
  });

  it('table: no history → now', () => {
    const scanStart = new Date(BASE);
    const now = new Date(BASE + 1000);
    const advanced = advanceLastScannedAt(
      { frequency: 'Daily' },
      { scanStart, now, timeScale: 1, singlePrompt: false },
    );
    assert.equal(advanced.getTime(), now.getTime());
  });
});

describe('isPromptDue', () => {
  it('property: never-scanned prompts are ALWAYS due', () => {
    fc.assert(
      fc.property(freqArb, timeScaleArb, fc.integer({ min: 0, max: 400 * DAY }), (freq, scale, t) => {
        return isPromptDue({ frequency: freq }, new Date(BASE + t), scale, 0) === true;
      }),
      RUNS,
    );
  });

  it('property: due-ness is monotone in time — once due, stays due', () => {
    fc.assert(
      fc.property(
        freqArb,
        timeScaleArb,
        fc.integer({ min: 0, max: 60 * DAY }),
        fc.integer({ min: 0, max: 60 * DAY }),
        fc.integer({ min: 0, max: 120_000 }),
        (freq, scale, t1, later, tol) => {
          const p = { frequency: freq, lastScannedAt: new Date(BASE) };
          const dueAtT1 = isPromptDue(p, new Date(BASE + t1), scale, tol);
          const dueLater = isPromptDue(p, new Date(BASE + t1 + later), scale, tol);
          return !dueAtT1 || dueLater;
        },
      ),
      RUNS,
    );
  });

  it('table: due exactly at the boundary, and within tolerance before it', () => {
    const p = { frequency: 'Daily', lastScannedAt: new Date(BASE) };
    const tol = 120_000;
    assert.equal(isPromptDue(p, new Date(BASE + DAY), 1, tol), true, 'exactly at boundary');
    assert.equal(isPromptDue(p, new Date(BASE + DAY - tol), 1, tol), true, 'tolerance early — inclusive');
    assert.equal(isPromptDue(p, new Date(BASE + DAY - tol - 1), 1, tol), false, '1ms before tolerance window');
  });
});

describe('cronToleranceMs', () => {
  it('property: 0 ≤ tolerance ≤ min(2 min, 10% of the shortest interval)', () => {
    fc.assert(
      fc.property(
        fc.array(freqArb, { minLength: 1, maxLength: 10 }),
        timeScaleArb,
        (freqs, scale) => {
          const prompts = freqs.map((f) => ({ frequency: f }));
          const tol = cronToleranceMs(prompts, scale);
          const shortest = Math.min(...prompts.map((p) => freqMsOf(p.frequency, scale)));
          return tol >= 0 && tol <= 120_000 && tol <= shortest * 0.1;
        },
      ),
      RUNS,
    );
  });

  it('table: high dev time scale shrinks tolerance below the 2-min cap (the 10000× Daily case)', () => {
    // Daily at 10000× = 8640 ms interval → tolerance must be 864 ms, not 2 min.
    assert.equal(cronToleranceMs([{ frequency: 'Daily' }], 10000), 864);
  });

  it('table: at real time the 2-min cap wins', () => {
    assert.equal(cronToleranceMs([{ frequency: 'Daily' }, { frequency: 'Weekly' }], 1), 120_000);
  });

  it('table: empty prompt list degrades to the 2-min cap (Infinity shortest)', () => {
    assert.equal(cronToleranceMs([], 1), 120_000);
  });
});
