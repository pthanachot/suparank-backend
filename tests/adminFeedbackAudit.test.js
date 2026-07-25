/**
 * Phase 9 — feedback status validation.
 *
 * updateFeedback now passes runValidators:true (so the model status enum is
 * enforced) and maps a ValidationError to 400. Feedback model monkey-patched.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const controller = require('../src/controllers/feedbackController');
const Feedback = require('../src/models/Feedback');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const real = Feedback.findByIdAndUpdate;
afterEach(() => { Feedback.findByIdAndUpdate = real; });

const call = async (body) => {
  const res = mockRes();
  await controller.updateFeedback({ params: { id: 'f1' }, body }, res);
  return res;
};

describe('updateFeedback — status validation', () => {
  it('passes runValidators:true so the model enum is enforced', async () => {
    let opts;
    Feedback.findByIdAndUpdate = async (id, upd, o) => { opts = o; return { _id: id, status: upd.status }; };
    const res = await call({ status: 'resolved', adminNote: 'ok' });
    assert.equal(res.statusCode, 200);
    assert.equal(opts.runValidators, true);
  });

  it('maps a schema ValidationError to 400 (rejects an invalid status)', async () => {
    Feedback.findByIdAndUpdate = async () => {
      const e = new Error('`banana` is not a valid enum value');
      e.name = 'ValidationError';
      throw e;
    };
    assert.equal((await call({ status: 'banana' })).statusCode, 400);
  });

  it('404s an unknown feedback id', async () => {
    Feedback.findByIdAndUpdate = async () => null;
    assert.equal((await call({ status: 'resolved' })).statusCode, 404);
  });
});
