'use strict';

/**
 * Express half of the plan-completeness parity suite.
 *
 * planValidator.js and writing-engine's plan_completeness.go are hand-mirrored
 * implementations of one rule set — Express owns the authoritative gate at
 * /plan/approve, Go runs the same rules in-loop every turn so the model gets
 * feedback without an HTTP round-trip. Nothing in either language forces them
 * to agree, and drift is nasty in both directions: the in-loop feedback tells
 * the model it is finished while Express rejects the plan, or the model burns
 * its turn budget chasing a bar Express would never have enforced.
 *
 * Both suites read the same cases and assert the same expected rule ids. The
 * Go half is TestPlanCompletenessParity in plan_completeness_parity_test.go;
 * the fixture is duplicated at writing-engine/internal/engine/testdata/ because
 * the two live in separate git repos and neither can read the other's tree.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const planValidator = require('../src/services/planValidator');

const FIXTURE = path.join(__dirname, 'fixtures', 'planCompleteness', 'parity-cases.json');
const { brief, cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('parity fixture is non-trivial', () => {
  // Guards against a truncated or half-written fixture quietly passing every
  // case below by iterating nothing.
  assert.ok(cases.length >= 8, `expected a real case list, got ${cases.length}`);
  assert.ok(
    cases.some((c) => c.expectedRules.length === 0),
    'at least one case must be a PASS, or the suite only proves failures fire',
  );
  assert.ok(
    cases.some((c) => c.expectedRules.length > 0),
    'at least one case must FAIL, or the suite only proves passes pass',
  );
});

for (const c of cases) {
  test(`parity: ${c.name}`, () => {
    const result = planValidator.validateCompleteness(c.plan, brief);
    const actual = result.failures.map((f) => f.rule).sort();
    const expected = [...c.expectedRules].sort();
    assert.deepStrictEqual(
      actual,
      expected,
      `rule set drifted.\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n` +
      `  messages: ${JSON.stringify(result.failures.map((f) => f.message), null, 2)}`,
    );
    // ok must agree with the rule list — a validator that reported failures but
    // still said ok would pass the check above and break the approve gate.
    assert.strictEqual(result.ok, expected.length === 0, 'result.ok disagrees with the failure list');
  });
}
