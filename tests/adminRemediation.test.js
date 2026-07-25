/**
 * Phase 11 remediation.
 *
 * cancelStripeSubscription (HIGH-5.8/6.2): success / resource_missing / real
 * failure decision logic. Self-target guards (LOW-5.7): an admin can't delete or
 * suspend their own account. Models monkey-patched — no DB.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminController = require('../src/controllers/adminController');
const User = require('../src/models/User');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const fakeStripe = (cancelImpl) => ({ subscriptions: { cancel: cancelImpl } });

describe('cancelStripeSubscription — the HIGH-5.8/6.2 decision logic', () => {
  it('ok when the cancel succeeds', async () => {
    const r = await adminController.cancelStripeSubscription('sub_1', fakeStripe(async () => ({})));
    assert.deepEqual(r, { ok: true, alreadyGone: false });
  });

  it('ok + alreadyGone on resource_missing (desired end state reached)', async () => {
    const r = await adminController.cancelStripeSubscription('sub_1', fakeStripe(async () => {
      const e = new Error('No such subscription'); e.code = 'resource_missing'; throw e;
    }));
    assert.deepEqual(r, { ok: true, alreadyGone: true });
  });

  it('NOT ok on a real failure — caller must not pretend billing stopped', async () => {
    const r = await adminController.cancelStripeSubscription('sub_1', fakeStripe(async () => {
      throw new Error('network down');
    }));
    assert.equal(r.ok, false);
    assert.match(r.error, /network down/);
  });
});

describe('self-target guards (LOW-5.7)', () => {
  const realFindOne = User.findOne;
  afterEach(() => { User.findOne = realFindOne; });

  const deleteUser = async (targetId, meId) => {
    User.findOne = () => ({ lean: async () => ({ _id: targetId, email: 'a@b.c' }) });
    const res = mockRes();
    await adminController.adminDeleteUser({ params: { userId: '1' }, user: { userId: meId, email: 'a@b.c' } }, res);
    return res;
  };

  const updateStatus = async (targetId, meId, status) => {
    User.findOne = async () => ({ _id: targetId, email: 'a@b.c', status: 'active', save: async () => {} });
    const res = mockRes();
    await adminController.updateUser({ params: { userId: '1' }, body: { status }, user: { userId: meId, email: 'a@b.c' } }, res);
    return res;
  };

  it('adminDeleteUser refuses deleting your OWN account (400, before any deletion)', async () => {
    assert.equal((await deleteUser('me', 'me')).statusCode, 400);
  });

  it('updateUser refuses suspending your OWN account', async () => {
    assert.equal((await updateStatus('me', 'me', 'suspended')).statusCode, 400);
    assert.equal((await updateStatus('me', 'me', 'deleted')).statusCode, 400);
  });

  it('updateUser ALLOWS re-activating your own account', async () => {
    assert.equal((await updateStatus('me', 'me', 'active')).statusCode, 200);
  });

  it('updateUser ALLOWS suspending ANOTHER user', async () => {
    assert.equal((await updateStatus('other', 'me', 'suspended')).statusCode, 200);
  });
});
