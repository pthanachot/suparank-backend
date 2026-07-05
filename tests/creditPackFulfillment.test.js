/**
 * Tests for the credit-pack fulfillment path in webhookController.
 *
 * Covers the money-critical guarantees:
 *   - idempotency: a redelivered checkout.session.completed (same session.id)
 *     grants credits at most once,
 *   - routing: mode:'payment' + creditPackId branches to fulfillment and never
 *     touches subscription logic,
 *   - grant amount: grantGeneralCredits is called with the pack's credit total.
 *
 * Stripe is faked via require-cache injection (BEFORE requiring the controller);
 * CreditTransaction / creditService / auditService are monkey-patched. No DB or
 * network access. Same stubbed-model style as adminUpdateSubscription.test.js.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Fake Stripe (installed BEFORE requiring the controller) ────
const stripeState = { subscriptionRetrieveCalls: [] };

class FakeStripe {
  constructor() {
    this.webhooks = { constructEvent: () => ({}) };
    this.subscriptions = {
      // Flag if the subscription path is ever reached during a payment event.
      retrieve: async (id) => {
        stripeState.subscriptionRetrieveCalls.push(id);
        return { id, items: { data: [{ price: { id: 'price_x' } }] }, status: 'active' };
      },
    };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const webhookController = require('../src/controllers/webhookController');
const CreditTransaction = require('../src/models/CreditTransaction');
const Subscription = require('../src/models/Subscription');
const creditService = require('../src/services/creditService');
const auditService = require('../src/services/auditService');

// ── Save originals for restoration ─────────────────────────────
const real = {
  grantIdempotent: creditService.grantGeneralCreditsIdempotent,
  auditRecord: auditService.record,
  subFindOneAndUpdate: Subscription.findOneAndUpdate,
  grantSubscriptionCredits: creditService.grantSubscriptionCredits,
};

after(() => {
  creditService.grantGeneralCreditsIdempotent = real.grantIdempotent;
  auditService.record = real.auditRecord;
  Subscription.findOneAndUpdate = real.subFindOneAndUpdate;
  creditService.grantSubscriptionCredits = real.grantSubscriptionCredits;
});

// ── Shared in-memory state ─────────────────────────────────────
// The atomic idempotency primitive (grantGeneralCreditsIdempotent) is unit-
// tested directly in creditIdempotentGrant.test.js. Here we stub it as a
// collaborator and simulate its keyed-once behavior so the webhook's routing,
// validation, audit, and redelivery handling are what's under test.
let fulfilledKeys; // Set of idempotencyKeys already granted (simulates the marker)
let grantCalls; // [{ orgId, amount, description, opts }]
let auditCalls; // [{ action, meta, ... }]
let subUpsertCalls; // flags any subscription upsert (should stay empty for payment)
let subGrantCalls; // flags subscription credit grants

beforeEach(() => {
  fulfilledKeys = new Set();
  grantCalls = [];
  auditCalls = [];
  subUpsertCalls = [];
  subGrantCalls = [];

  creditService.grantGeneralCreditsIdempotent = async (orgId, amount, description, opts = {}) => {
    const key = opts.idempotencyKey;
    if (fulfilledKeys.has(key)) {
      return { granted: false, alreadyFulfilled: true, balanceAfter: 0 };
    }
    fulfilledKeys.add(key);
    grantCalls.push({ orgId, amount, description, opts });
    return { granted: true, alreadyFulfilled: false, balanceAfter: amount };
  };

  auditService.record = (entry) => {
    auditCalls.push(entry);
  };

  // If the subscription path is ever reached, these fire and fail the routing test.
  Subscription.findOneAndUpdate = async () => {
    subUpsertCalls.push(true);
    return {};
  };
  creditService.grantSubscriptionCredits = async () => {
    subGrantCalls.push(true);
  };
});

function makePaymentSession(overrides = {}) {
  return {
    id: 'cs_test_123',
    mode: 'payment',
    metadata: {
      organizationId: 'org-1',
      userId: 'user-1',
      creditPackId: 'credits-5k',
      credits: '5000',
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('fulfillCreditPackPurchase — happy path', () => {
  it('grants general credits with the pack amount and the session idempotency key', async () => {
    await webhookController.fulfillCreditPackPurchase(makePaymentSession());

    assert.equal(grantCalls.length, 1);
    assert.equal(grantCalls[0].orgId, 'org-1');
    assert.equal(grantCalls[0].amount, 5000);
    assert.match(grantCalls[0].description, /Credit pack: 5,000 credits/);

    // The grant must carry the session id as its idempotency key + pack meta.
    assert.equal(grantCalls[0].opts.idempotencyKey, 'cs_test_123');
    assert.equal(grantCalls[0].opts.userId, 'user-1');
    assert.equal(grantCalls[0].opts.meta.creditPackId, 'credits-5k');
    assert.equal(grantCalls[0].opts.meta.credits, 5000);
  });

  it('records a billing.credits_purchased audit entry', async () => {
    await webhookController.fulfillCreditPackPurchase(makePaymentSession());
    const audit = auditCalls.find((a) => a.action === 'billing.credits_purchased');
    assert.ok(audit, 'audit entry recorded');
    assert.equal(audit.meta.credits, 5000);
    assert.equal(audit.meta.packId, 'credits-5k');
    assert.equal(audit.meta.sessionId, 'cs_test_123');
  });
});

describe('fulfillCreditPackPurchase — idempotency (Stripe redelivery)', () => {
  it('a second delivery of the same session.id grants NOTHING', async () => {
    const session = makePaymentSession();

    await webhookController.fulfillCreditPackPurchase(session);
    assert.equal(grantCalls.length, 1, 'first delivery grants once');

    // Same session redelivered by Stripe.
    await webhookController.fulfillCreditPackPurchase(session);
    assert.equal(grantCalls.length, 1, 'redelivery must NOT grant again');
  });

  it('does not record a second audit entry on redelivery', async () => {
    const session = makePaymentSession();
    await webhookController.fulfillCreditPackPurchase(session);
    await webhookController.fulfillCreditPackPurchase(session);
    const purchases = auditCalls.filter((a) => a.action === 'billing.credits_purchased');
    assert.equal(purchases.length, 1, 'audit only on the first fulfillment');
  });
});

describe('fulfillCreditPackPurchase — permanent failures return without granting', () => {
  it('skips when org cannot be resolved', async () => {
    const session = makePaymentSession({ metadata: { creditPackId: 'credits-5k', credits: '5000' } });
    await webhookController.fulfillCreditPackPurchase(session);
    assert.equal(grantCalls.length, 0);
  });

  it('skips when credits amount is invalid', async () => {
    const session = makePaymentSession({
      metadata: { organizationId: 'org-1', creditPackId: 'credits-5k', credits: 'not-a-number' },
    });
    await webhookController.fulfillCreditPackPurchase(session);
    assert.equal(grantCalls.length, 0);
  });
});

describe('handleCheckoutCompleted — routing', () => {
  it('mode:payment + creditPackId fulfills credits and NEVER touches subscription logic', async () => {
    await webhookController.handleCheckoutCompleted(makePaymentSession());

    assert.equal(grantCalls.length, 1, 'credit pack fulfilled');
    assert.equal(subUpsertCalls.length, 0, 'no Subscription upsert');
    assert.equal(subGrantCalls.length, 0, 'no subscription credit grant');
    assert.equal(stripeState.subscriptionRetrieveCalls.length, 0, 'no Stripe subscription retrieve');
  });

  it('mode:payment WITHOUT creditPackId is ignored (no fulfillment, no subscription path)', async () => {
    await webhookController.handleCheckoutCompleted({
      id: 'cs_test_x',
      mode: 'payment',
      metadata: { organizationId: 'org-1' },
    });
    assert.equal(grantCalls.length, 0);
    assert.equal(subUpsertCalls.length, 0);
  });
});
