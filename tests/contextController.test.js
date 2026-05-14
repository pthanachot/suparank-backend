const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { pickLatestHistoricalVersion } = require('../src/controllers/contextController');

// Prefer-superseded behavior. Surfaced as INDEX.md's "prior plan" link;
// archived plans were rejected experiments, superseded plans were once
// approved decisions. The agent should be pointed at the decision.
describe('pickLatestHistoricalVersion', () => {
  it('returns 0 for empty history', () => {
    assert.equal(pickLatestHistoricalVersion([]), 0);
    assert.equal(pickLatestHistoricalVersion(null), 0);
    assert.equal(pickLatestHistoricalVersion(undefined), 0);
  });

  it('returns max superseded version when both kinds present', () => {
    // v1 approved → reopened (superseded) → v2 approved → reopened (superseded)
    //   → v3 draft → rejected (archived). Most-recent decision is v2.
    const history = [
      { version: 1, status: 'superseded' },
      { version: 2, status: 'superseded' },
      { version: 3, status: 'archived' },
    ];
    assert.equal(pickLatestHistoricalVersion(history), 2);
  });

  it('returns max archived when no superseded plans exist', () => {
    // No real prior decision — every plan was rejected before approval.
    const history = [
      { version: 1, status: 'archived' },
      { version: 2, status: 'archived' },
      { version: 3, status: 'archived' },
    ];
    assert.equal(pickLatestHistoricalVersion(history), 3);
  });

  it('does not pick archived when superseded is older', () => {
    // Edge case the prior implementation got wrong: v2 superseded, v3 archived.
    // Prefer v2 (decision) over v3 (rejected experiment).
    const history = [
      { version: 2, status: 'superseded' },
      { version: 3, status: 'archived' },
    ];
    assert.equal(pickLatestHistoricalVersion(history), 2);
  });

  it('handles sparse version sequences', () => {
    const history = [
      { version: 1, status: 'archived' },
      { version: 5, status: 'superseded' },
      { version: 7, status: 'archived' },
    ];
    assert.equal(pickLatestHistoricalVersion(history), 5);
  });

  it('handles unknown statuses gracefully (treats as not-superseded)', () => {
    const history = [
      { version: 1, status: 'mystery' },
      { version: 2, status: 'superseded' },
    ];
    assert.equal(pickLatestHistoricalVersion(history), 2);
  });

  it('ignores null entries defensively', () => {
    const history = [null, { version: 3, status: 'superseded' }, null];
    assert.equal(pickLatestHistoricalVersion(history), 3);
  });
});
