/**
 * Tests for the credit-pack PURCHASE half of Phase 15 (the fulfillment half is
 * covered by creditPackFulfillment.test.js / creditIdempotentGrant.test.js).
 *
 * Covers:
 *   - the catalog endpoint exposes display fields only (never the Stripe price id),
 *   - createCreditPackCheckout validates packId + org ownership,
 *   - an unconfigured pack (no Stripe price wired) dark-ships as 503,
 *   - a valid purchase creates a ONE-TIME (mode:'payment') session with the
 *     fulfillment metadata the webhook needs, and reuses/creates one per-org
 *     Stripe customer (persisting it so repeat buys don't mint duplicates).
 *
 * Stripe faked via require-cache; models monkey-patched. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
// Wire ONLY the small pack's price so we can assert both the happy path and the
// dark-ship 503 for an unconfigured pack in the same run.
process.env.STRIPE_CREDIT_PACK_SMALL_PRICE_ID = 'price_pack_small';
delete process.env.STRIPE_CREDIT_PACK_MEDIUM_PRICE_ID;

const stripeState = { sessions: [], customersCreated: [] };
class FakeStripe {
  constructor() {
    this.checkout = { sessions: { create: async (params) => { stripeState.sessions.push(params); return { url: 'https://checkout.stripe/pack', id: 'cs_pack_1' }; } } };
    this.customers = { create: async (p) => { stripeState.customersCreated.push(p); return { id: 'cus_new' }; } };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const billingController = require('../src/controllers/billingController');
const Organization = require('../src/models/Organization');
const Subscription = require('../src/models/Subscription');
const User = require('../src/models/User');

const real = { orgFB: Organization.findById, orgUpdate: Organization.updateOne, subFO: Subscription.findOne, userFB: User.findById };
after(() => {
  Organization.findById = real.orgFB;
  Organization.updateOne = real.orgUpdate;
  Subscription.findOne = real.subFO;
  User.findById = real.userFB;
  delete process.env.STRIPE_CREDIT_PACK_SMALL_PRICE_ID;
});

let orgPersists;
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const ownerReq = (body) => ({ user: { userId: 'u1' }, body });

beforeEach(() => {
  stripeState.sessions = [];
  stripeState.customersCreated = [];
  orgPersists = [];
  // Org owned by u1, no customer yet → forces create + persist path.
  Organization.findById = () => ({ lean: async () => ({ _id: 'org-1', ownerId: { equals: (id) => id === 'u1' }, name: 'Acme', stripeCustomerId: null }) });
  Organization.updateOne = async (f, u) => { orgPersists.push(u); return {}; };
  Subscription.findOne = async () => null;
  User.findById = async () => ({ _id: 'u1', email: 'owner@x.io', profile: { name: 'Owner' } });
});

describe('credit pack catalog', () => {
  it('exposes display fields only — never the Stripe price id', async () => {
    const r = res();
    await billingController.getCreditPacks({}, r);
    assert.ok(Array.isArray(r.body.packs) && r.body.packs.length >= 3);
    for (const p of r.body.packs) {
      assert.ok(p.id && p.label && p.credits && p.priceUsd, 'display fields present');
      assert.equal('stripePriceId' in p, false, 'price id NOT leaked to client');
    }
  });
});

describe('createCreditPackCheckout', () => {
  it('400s without a packId', async () => {
    const r = res();
    await billingController.createCreditPackCheckout(ownerReq({ orgId: 'org-1' }), r);
    assert.equal(r.statusCode, 400);
  });

  it('400s on an invalid packId', async () => {
    const r = res();
    await billingController.createCreditPackCheckout(ownerReq({ orgId: 'org-1', packId: 'nope' }), r);
    assert.equal(r.statusCode, 400);
  });

  it('403s when the caller is not the org owner', async () => {
    Organization.findById = () => ({ lean: async () => ({ _id: 'org-1', ownerId: { equals: () => false }, name: 'Acme' }) });
    const r = res();
    await billingController.createCreditPackCheckout(ownerReq({ orgId: 'org-1', packId: 'credits-5k' }), r);
    assert.equal(r.statusCode, 403);
  });

  it('503s (dark-ship) for a pack whose Stripe price is not wired up', async () => {
    const r = res();
    await billingController.createCreditPackCheckout(ownerReq({ orgId: 'org-1', packId: 'credits-15k' }), r);
    assert.equal(r.statusCode, 503);
    assert.equal(stripeState.sessions.length, 0);
  });

  it('creates a one-time payment session with fulfillment metadata, and persists the new customer', async () => {
    const r = res();
    await billingController.createCreditPackCheckout(ownerReq({ orgId: 'org-1', packId: 'credits-5k' }), r);
    assert.equal(r.body.url, 'https://checkout.stripe/pack');
    const s = stripeState.sessions[0];
    assert.equal(s.mode, 'payment', 'ONE-TIME charge, not a subscription');
    assert.equal(s.line_items[0].price, 'price_pack_small');
    assert.equal(s.metadata.creditPackId, 'credits-5k');
    assert.equal(s.metadata.credits, '5000', 'credits carried for the webhook to grant');
    assert.equal(s.metadata.organizationId, 'org-1');
    assert.equal(s.customer, 'cus_new', 'attaches the per-org customer');
    assert.equal(stripeState.customersCreated.length, 1, 'created one customer');
    assert.equal(orgPersists[0].stripeCustomerId, 'cus_new', 'persisted so repeat buys reuse it');
  });

  it('reuses an existing per-org customer (no duplicate create)', async () => {
    Organization.findById = () => ({ lean: async () => ({ _id: 'org-1', ownerId: { equals: () => true }, name: 'Acme', stripeCustomerId: 'cus_existing' }) });
    const r = res();
    await billingController.createCreditPackCheckout(ownerReq({ orgId: 'org-1', packId: 'credits-5k' }), r);
    assert.equal(stripeState.sessions[0].customer, 'cus_existing');
    assert.equal(stripeState.customersCreated.length, 0, 'no duplicate customer');
  });
});
