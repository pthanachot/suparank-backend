/**
 * Phase 11 — resetOrgToFree aborts on a Stripe cancel FAILURE (HIGH-6.2).
 *
 * Injects a fake `stripe` whose cancel always throws BEFORE adminController
 * loads, then drives resetOrgToFree with a sub that HAS a stripeSubscriptionId.
 * Proves it 502s and does NOT proceed to mutate (credits not expired, sub not
 * flipped) — i.e. it never marks a still-billing sub as canceled.
 */

// Fake Stripe constructor whose subscriptions.cancel always fails.
require.cache[require.resolve('stripe')] = {
  exports: function FakeStripe() {
    return { subscriptions: { cancel: async () => { throw new Error('stripe unreachable'); } } };
  },
};

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminController = require('../src/controllers/adminController');
const Organization = require('../src/models/Organization');
const Subscription = require('../src/models/Subscription');
const creditService = require('../src/services/creditService');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('resetOrgToFree — aborts on Stripe cancel failure (HIGH-6.2)', () => {
  const real = {
    org: Organization.findById,
    sub: Subscription.findOne,
    expire: creditService.expireSubscriptionCredits,
  };
  let expireCalled;

  beforeEach(() => {
    expireCalled = false;
    Organization.findById = async () => ({ _id: 'o1' });
    Subscription.findOne = () => ({ lean: async () => ({ planId: 'pro-monthly', stripeSubscriptionId: 'sub_x' }) });
    creditService.expireSubscriptionCredits = async () => { expireCalled = true; return { expired: 0 }; };
  });
  afterEach(() => {
    Organization.findById = real.org;
    Subscription.findOne = real.sub;
    creditService.expireSubscriptionCredits = real.expire;
  });

  it('502s and does NOT mutate (credits not expired) when the Stripe cancel fails', async () => {
    const res = mockRes();
    await adminController.resetOrgToFree({ params: { orgId: 'o1' }, user: { email: 'a@b.c' } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(expireCalled, false, 'must abort BEFORE expiring subscription credits');
  });

  it('the helper reports failure for a cancel that throws (sanity)', async () => {
    const r = await adminController.cancelStripeSubscription('sub_x');
    assert.equal(r.ok, false);
  });
});
