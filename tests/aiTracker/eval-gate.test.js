/**
 * Phase 6 — analyzer eval gate.
 *
 * Replays the recorded Kimi outputs through the REAL analyzeResponse and
 * enforces per-field floors against the ground-truth labels.
 *
 * As of the D1 live recording pass (2026-08-02) recorded/kimi.json holds
 * REAL model outputs, so this is now a MODEL-QUALITY gate: it measures how
 * well Kimi actually extracts brands/citations/sentiment, on top of the
 * pipeline correctness it always covered. Deterministic replay means a
 * score change is a real change (prompt, parser, or model), never noise.
 *
 * The degradation check proves the gate can FAIL: the no-key regex
 * fallback must score far below the floors on the fields it degrades.
 *
 * Run: node --test tests/aiTracker/eval-gate.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { runEval, RECORDED_FILE } = require('./eval/run.js');

// Floors calibrated against REAL Kimi output (D1 live recording pass,
// 2026-08-02): mentioned 92.3 · cited 100 · sentiment 86.2 · brandRecall 100
// · brandPrecision 85.3 · positionPresent 100. Set a few points below each
// observed value: replays are deterministic, so any drift means the PROMPT,
// the PARSER, or the model changed — not noise. Re-calibrate (never silently
// lower) after a deliberate prompt/model change.
const FLOORS = {
  mentionedAcc: 88,
  citedAcc: 97,
  sentimentAcc: 80,
  brandRecall: 95,
  brandPrecision: 80,
  positionPresent: 97,
};

const hasRecordings = fs.existsSync(RECORDED_FILE);

// Phase 9 review (F6): this used to SKIP the whole suite when the recordings
// were absent. A skipped node:test suite reports `# pass 0 # fail 0` and exits
// 0, so a missing (and currently untracked) 55 KB corpus file turned the
// analyzer gate into a green no-op — the exact "reports green without running"
// pattern the engine's eval gate was hardened against in Phase C1.
// A GATE must fail when it cannot run. EVAL_ALLOW_MISSING=1 restores the old
// behaviour for a genuinely corpus-less checkout, and says so loudly.
describe('analyzer eval gate — corpus present', () => {
  it('recorded/kimi.json exists (the gate cannot run without it)', () => {
    if (!hasRecordings && process.env.EVAL_ALLOW_MISSING === '1') {
      console.log('# WARNING: eval corpus missing and EVAL_ALLOW_MISSING=1 — the analyzer gate is NOT enforcing');
      return;
    }
    assert.ok(
      hasRecordings,
      `missing ${RECORDED_FILE}. The analyzer eval gate cannot run, so a green suite would prove nothing. `
      + 'Restore the corpus (run.js --live --record), or set EVAL_ALLOW_MISSING=1 to acknowledge an unguarded build.',
    );
  });
});

describe('analyzer eval gate', { skip: !hasRecordings && 'no recorded/kimi.json — see the corpus-present test above' }, () => {
  let report;
  let fallbackReport;

  before(async () => {
    report = await runEval({ mode: 'mocked' });
    fallbackReport = await runEval({ mode: 'fallback' });
  });

  it('scores a meaningful corpus (labeled, recorded, non-draft)', () => {
    assert.ok(report.scored >= 35, `only ${report.scored} rows scored — corpus shrank or recordings are stale`);
    assert.equal(report.skippedNoRecording, 0, 'every labeled row must have a recording (regenerate after adding rows)');
  });

  it('holds every per-field floor', () => {
    for (const [field, floor] of Object.entries(FLOORS)) {
      const got = report.scores[field];
      assert.ok(
        got !== null && got >= floor,
        `${field} = ${got} < floor ${floor}; sample failures: ${JSON.stringify(report.failures.slice(0, 5))}`,
      );
    }
  });

  it('ZERO unsafe citation URLs survive the pipeline (hard security floor)', () => {
    assert.equal(
      report.scores.unsafeLeakRows,
      0,
      `unsafe citedUrls leaked: ${JSON.stringify(report.failures.filter((f) => f.field === 'unsafeCitationLeak'))}`,
    );
  });

  it('reports known limitations without letting them poison the floors', () => {
    // adv-05 (slice-8000) is live-mode-only; in mocked mode it has no
    // recording by design and must not appear in the scored set.
    assert.ok(!report.failures.some((f) => f.id === 'adv-05'));
  });

  it('DEGRADATION PROOF: the regex fallback scores far below the floors — the gate can actually fail', () => {
    const s = fallbackReport.scores;
    assert.ok(s.brandRecall === 0 || s.brandRecall < 20, `fallback brandRecall ${s.brandRecall} should collapse`);
    assert.ok(s.sentimentAcc === 0 || s.sentimentAcc < 20, `fallback sentimentAcc ${s.sentimentAcc} should collapse`);
    assert.ok(s.positionPresent === 0 || s.positionPresent < 20, `fallback positionPresent ${s.positionPresent} should collapse`);
    // And the fallback's mentioned accuracy stays decent — that asymmetry is
    // exactly why F3-13's fallback logging matters in production.
    assert.ok(s.mentionedAcc >= 70, `fallback mentionedAcc ${s.mentionedAcc} — regex should still catch most names`);
  });
});
