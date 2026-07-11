/**
 * R9 — the agent handler clamps client-supplied maxIterations/targetScore
 * before calling the writing engine, so a single flat-priced (10-credit)
 * request cannot buy an unbounded engine turn budget (MaxTurns derives from
 * maxIterations). The 16 ceiling matches the highest value any real slash
 * command sends (/research, /facts), so legitimate commands are unaffected.
 *
 * Pure function; no DB/network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { clampAgentBudget } = require('../src/controllers/aiController');

describe('clampAgentBudget', () => {
  it('clamps abusive iterations to the 16 ceiling', () => {
    const { safeIterations, safeTargetScore } = clampAgentBudget(100, 999);
    assert.equal(safeIterations, 16);
    assert.equal(safeTargetScore, 90);
  });

  it('passes the highest legitimate command value (16) unchanged', () => {
    assert.equal(clampAgentBudget(16, 80).safeIterations, 16);
    assert.equal(clampAgentBudget(16, 80).safeTargetScore, 80);
  });

  it('applies defaults when values are missing', () => {
    const { safeIterations, safeTargetScore } = clampAgentBudget(undefined, undefined);
    assert.equal(safeIterations, 5);
    assert.equal(safeTargetScore, 75);
  });

  it('floors negative iterations to at least 1 (0/missing use the default 5)', () => {
    assert.equal(clampAgentBudget(-3, 75).safeIterations, 1); // -3 is truthy, so no default; Math.max(-3,1)=1
    assert.equal(clampAgentBudget(0, 75).safeIterations, 5); // 0 is falsy -> default 5
  });

  it('floors targetScore to the minimum band', () => {
    assert.equal(clampAgentBudget(5, 10).safeTargetScore, 50);
  });

  it('coerces numeric strings', () => {
    const { safeIterations, safeTargetScore } = clampAgentBudget('12', '80');
    assert.equal(safeIterations, 12);
    assert.equal(safeTargetScore, 80);
  });
});
