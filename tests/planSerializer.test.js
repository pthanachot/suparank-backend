const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toGoPlan } = require('../src/services/planSerializer');

describe('toGoPlan', () => {
  it('returns null for null/undefined', () => {
    assert.equal(toGoPlan(null), null);
    assert.equal(toGoPlan(undefined), null);
  });

  it('renames _id to id (string)', () => {
    const got = toGoPlan({ _id: 'abc123', status: 'draft' });
    assert.equal(got.id, 'abc123');
    assert.equal(got._id, undefined);
    assert.equal(got.status, 'draft');
  });

  it('coerces ObjectId-like values to strings', () => {
    // Mongoose ObjectId has a String() coercer that returns the hex.
    const fakeObjectId = { toString: () => '507f1f77bcf86cd799439011' };
    const got = toGoPlan({
      _id: fakeObjectId,
      contentId: fakeObjectId,
      workspaceId: fakeObjectId,
    });
    assert.equal(typeof got.id, 'string');
    assert.equal(got.id, '507f1f77bcf86cd799439011');
    assert.equal(got.contentId, '507f1f77bcf86cd799439011');
    assert.equal(got.workspaceId, '507f1f77bcf86cd799439011');
  });

  it('drops Mongoose __v bookkeeping', () => {
    const got = toGoPlan({ _id: 'a', __v: 3 });
    assert.equal(got.__v, undefined);
  });

  it('honors toObject() when present (Mongoose-style)', () => {
    const fake = {
      toObject() {
        return { _id: 'x', thesis: 'hello' };
      },
    };
    const got = toGoPlan(fake);
    assert.equal(got.id, 'x');
    assert.equal(got.thesis, 'hello');
  });

  it('is idempotent when id is already set', () => {
    const input = { id: 'preset', status: 'draft' };
    const got = toGoPlan(input);
    assert.equal(got.id, 'preset');
    assert.equal(got.status, 'draft');
  });

  it('leaves null contentId/workspaceId alone (not coerced to "null")', () => {
    const got = toGoPlan({ _id: 'a', contentId: null, workspaceId: null });
    assert.equal(got.contentId, null);
    assert.equal(got.workspaceId, null);
  });

  it('preserves nested plan fields (sections, evidenceMap, etc.)', () => {
    const input = {
      _id: 'p1',
      sections: [{ id: 'intro', heading: 'Intro' }],
      evidenceMap: { intro: [{ path: '/a.md' }] },
      alternatives: [{ label: 'x', chosen: true }],
    };
    const got = toGoPlan(input);
    assert.deepEqual(got.sections, [{ id: 'intro', heading: 'Intro' }]);
    assert.deepEqual(got.evidenceMap, { intro: [{ path: '/a.md' }] });
    assert.deepEqual(got.alternatives, [{ label: 'x', chosen: true }]);
  });
});
