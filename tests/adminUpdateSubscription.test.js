/**
 * Tests for adminController.updateSubscription — the Stripe-synced admin
 * subscription actions (cancel_at_period_end / reactivate / cancel_immediately).
 *
 * Stripe is faked via require-cache injection (must happen before the
 * controller is required); models and creditService are monkey-patched.
 * No database or network access.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Fake Stripe (installed BEFORE requiring the controller) ────
const stripeState = { updateCalls: [], cancelCalls: [], error: null };

class FakeStripe {
  constructor() {
    this.subscriptions = {
      update: async (id, params) => {
        if (stripeState.error) throw stripeState.error;
        stripeState.updateCalls.push([id, params]);
        return { id };
      },
      cancel: async (id) => {
        if (stripeState.error) throw stripeState.error;
        stripeState.cancelCalls.push(id);
        return { id };
      },
    };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const adminController = require('../src/controllers/adminController');
const Subscription = require('../src/models/Subscription');
const creditService = require('../src/services/creditService');

// ── Helpers ────────────────────────────────────────────────────

const realFindById = Subscription.findById;
const realExpire = creditService.expireSubscriptionCredits;

after(() => {
  Subscription.findById = realFindById;
  creditService.expireSubscriptionCredits = realExpire;
});

function makeSub(overrides = {}) {
  return {
    _id: 'sub-1',
    stripeSubscriptionId: 'sub_stripe_1',
    status: 'active',
    cancelAtPeriodEnd: false,
    canceledAt: null,
    organizationId: 'org-1',
    saved: false,
    async save() {
      this.saved = true;
    },
    ...overrides,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

let expireCalls;

async function callAction(sub, action) {
  Subscription.findById = async () => sub;
  const req = { params: { subId: 'sub-1' }, body: { action } };
  const res = mockRes();
  await adminController.updateSubscription(req, res);
  return res;
}

beforeEach(() => {
  stripeState.updateCalls = [];
  stripeState.cancelCalls = [];
  stripeState.error = null;
  expireCalls = [];
  creditService.expireSubscriptionCredits = async (orgId) => {
    expireCalls.push(orgId);
    return { expired: 0 };
  };
});

// ── Tests ──────────────────────────────────────────────────────

describe('updateSubscription — validation', () => {
  it('rejects unknown actions with 400', async () => {
    const res = await callAction(makeSub(), 'explode');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /invalid action/i);
  });

  it('returns 404 when the subscription does not exist', async () => {
    Subscription.findById = async () => null;
    const req = { params: { subId: 'nope' }, body: { action: 'reactivate' } };
    const res = mockRes();
    await adminController.updateSubscription(req, res);
    assert.equal(res.statusCode, 404);
  });
});

describe('updateSubscription — Stripe-backed', () => {
  it('cancel_at_period_end calls Stripe and does NOT set canceledAt (webhook owns it)', async () => {
    const sub = makeSub();
    const res = await callAction(sub, 'cancel_at_period_end');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(stripeState.updateCalls, [['sub_stripe_1', { cancel_at_period_end: true }]]);
    assert.equal(sub.cancelAtPeriodEnd, true);
    assert.equal(sub.canceledAt, null);
    assert.equal(sub.saved, true);
  });

  it('reactivate on a fully canceled sub returns 409 without touching Stripe', async () => {
    const sub = makeSub({ status: 'canceled' });
    const res = await callAction(sub, 'reactivate');
    assert.equal(res.statusCode, 409);
    assert.equal(stripeState.updateCalls.length, 0);
    assert.equal(sub.saved, false);
  });

  it('reactivate clears a scheduled cancellation via Stripe', async () => {
    const sub = makeSub({ cancelAtPeriodEnd: true, canceledAt: new Date() });
    const res = await callAction(sub, 'reactivate');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(stripeState.updateCalls, [['sub_stripe_1', { cancel_at_period_end: false }]]);
    assert.equal(sub.cancelAtPeriodEnd, false);
    assert.equal(sub.canceledAt, null);
    assert.equal(sub.saved, true);
  });

  it('cancel_immediately cancels at Stripe and leaves credit expiry to the webhook', async () => {
    const sub = makeSub();
    const res = await callAction(sub, 'cancel_immediately');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(stripeState.cancelCalls, ['sub_stripe_1']);
    assert.equal(sub.status, 'canceled');
    assert.ok(sub.canceledAt instanceof Date);
    assert.equal(expireCalls.length, 0, 'credit expiry belongs to the subscription.deleted webhook');
    assert.equal(sub.saved, true);
  });

  it('resource_missing on a cancel reconciles the DB and reports success', async () => {
    stripeState.error = Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    const sub = makeSub();
    const res = await callAction(sub, 'cancel_immediately');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(sub.status, 'canceled');
    assert.equal(sub.saved, true);
  });

  it('resource_missing on reactivate returns 409 and reconciles to canceled', async () => {
    stripeState.error = Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    const sub = makeSub({ status: 'active', cancelAtPeriodEnd: true });
    const res = await callAction(sub, 'reactivate');
    assert.equal(res.statusCode, 409);
    assert.equal(sub.status, 'canceled');
    assert.equal(sub.saved, true);
  });

  it('any other Stripe error returns 502 and persists nothing (no drift)', async () => {
    stripeState.error = new Error('Stripe is down');
    const sub = makeSub();
    const res = await callAction(sub, 'cancel_at_period_end');
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /stripe/i);
    assert.equal(sub.saved, false);
  });
});

describe('updateSubscription — manual (non-Stripe) subscriptions', () => {
  it('cancel_immediately stays DB-only and expires credits inline', async () => {
    const sub = makeSub({ stripeSubscriptionId: null });
    const res = await callAction(sub, 'cancel_immediately');
    assert.equal(res.statusCode, 200);
    assert.equal(stripeState.cancelCalls.length, 0);
    assert.equal(sub.status, 'canceled');
    assert.deepEqual(expireCalls, ['org-1']);
    assert.equal(sub.saved, true);
  });

  it('reactivate restores a canceled manual subscription', async () => {
    const sub = makeSub({ stripeSubscriptionId: null, status: 'canceled', cancelAtPeriodEnd: true });
    const res = await callAction(sub, 'reactivate');
    assert.equal(res.statusCode, 200);
    assert.equal(sub.status, 'active');
    assert.equal(sub.cancelAtPeriodEnd, false);
    assert.equal(sub.saved, true);
  });
});
