/**
 * Phase 6 — Organizations + Tenants + Brand configs audit.
 *
 * Locks in org credit/quota math (incl. the type-coercion fix), overrideOrgPlan
 * (DB-only planId write, no Stripe), resetOrgToFree (expires credits + resets
 * usage + flips the sub to free/canceled), and brand-config payload validation.
 * Models/services are monkey-patched — no database, no Stripe.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminController = require('../src/controllers/adminController');
const brandController = require('../src/controllers/brandController');
const Organization = require('../src/models/Organization');
const Credit = require('../src/models/Credit');
const CreditTransaction = require('../src/models/CreditTransaction');
const UsageTracker = require('../src/models/UsageTracker');
const Subscription = require('../src/models/Subscription');
const creditService = require('../src/services/creditService');
const brandService = require('../src/services/brandService');
const auditService = require('../src/services/auditService');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ── manageOrgCredits ───────────────────────────────────────────
describe('manageOrgCredits — math + type safety', () => {
  const real = { findById: Organization.findById, goc: Credit.getOrCreateForOrg, log: CreditTransaction.logTransaction };
  let credit;

  beforeEach(() => {
    credit = { subscriptionCredits: 10, generalCredits: 100, lowBalanceNotifiedAt: 1, save: async () => {} };
    Organization.findById = async () => ({ _id: 'o1' });
    Credit.getOrCreateForOrg = async () => credit;
    CreditTransaction.logTransaction = async () => {};
  });
  afterEach(() => {
    Organization.findById = real.findById;
    Credit.getOrCreateForOrg = real.goc;
    CreditTransaction.logTransaction = real.log;
  });

  const call = async (body) => {
    const res = mockRes();
    await adminController.manageOrgCredits({ params: { orgId: 'o1' }, body, user: { email: 'a@b.c' } }, res);
    return res;
  };

  it('add a STRING amount to the general pool stays numeric', async () => {
    const res = await call({ action: 'add', amount: '50', pool: 'general' });
    assert.equal(res.statusCode, 200);
    assert.strictEqual(credit.generalCredits, 150);
  });

  it('subtract floors at 0 on the subscription pool', async () => {
    await call({ action: 'subtract', amount: 999, pool: 'subscription' });
    assert.strictEqual(credit.subscriptionCredits, 0);
  });

  it('rejects a bad pool and a non-numeric amount', async () => {
    assert.equal((await call({ action: 'add', amount: 5, pool: 'bogus' })).statusCode, 400);
    assert.equal((await call({ action: 'add', amount: 'x', pool: 'general' })).statusCode, 400);
  });
});

// ── manageOrgQuota ─────────────────────────────────────────────
describe('manageOrgQuota — math + type safety', () => {
  const real = { findById: Organization.findById, get: UsageTracker.getCount, inc: UsageTracker.increment };
  let current, incCall;

  beforeEach(() => {
    current = 10; incCall = null;
    Organization.findById = async () => ({ _id: 'o1' });
    UsageTracker.getCount = async () => current;
    UsageTracker.increment = async (orgId, counter, period, delta) => { incCall = { delta }; };
  });
  afterEach(() => {
    Organization.findById = real.findById;
    UsageTracker.getCount = real.get;
    UsageTracker.increment = real.inc;
  });

  const call = async (body) => {
    const res = mockRes();
    await adminController.manageOrgQuota({ params: { orgId: 'o1' }, body, user: { email: 'a@b.c' } }, res);
    return res;
  };

  it('add a STRING amount increments numerically', async () => {
    const res = await call({ counter: 'articlesCreated', period: '2026-07', action: 'add', amount: '5' });
    assert.equal(res.statusCode, 200);
    assert.strictEqual(res.body.newValue, 15);
    assert.strictEqual(incCall.delta, 5);
  });

  it('rejects a malformed period', async () => {
    assert.equal((await call({ counter: 'articlesCreated', period: 'July', action: 'add', amount: 5 })).statusCode, 400);
  });
});

// ── overrideOrgPlan (DB-only) ──────────────────────────────────
describe('overrideOrgPlan — DB-only planId write', () => {
  const real = { findById: Organization.findById, subFind: Subscription.findOne };
  let saved;

  afterEach(() => {
    Organization.findById = real.findById;
    Subscription.findOne = real.subFind;
  });

  it('writes planId + active status on an existing sub, no Stripe', async () => {
    saved = null;
    Organization.findById = async () => ({ _id: 'o1', ownerId: 'u1' });
    Subscription.findOne = async () => ({
      planId: 'free', status: 'canceled',
      save: async function () { saved = { planId: this.planId, status: this.status }; },
    });
    const res = mockRes();
    await adminController.overrideOrgPlan({ params: { orgId: 'o1' }, body: { planId: 'pro-monthly' }, user: { email: 'a@b.c' } }, res);
    assert.equal(res.statusCode, 200);
    assert.strictEqual(saved.planId, 'pro-monthly');
    assert.strictEqual(saved.status, 'active');
  });

  it('rejects an invalid planId', async () => {
    Organization.findById = async () => ({ _id: 'o1' });
    const res = mockRes();
    await adminController.overrideOrgPlan({ params: { orgId: 'o1' }, body: { planId: 'enterprise-galaxy' }, user: { email: 'a@b.c' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

// ── resetOrgToFree (no-Stripe path) ────────────────────────────
describe('resetOrgToFree — expires credits, resets usage, flips to free', () => {
  const real = {
    findById: Organization.findById, subFind: Subscription.findOne,
    expire: creditService.expireSubscriptionCredits, del: UsageTracker.deleteMany, log: CreditTransaction.logTransaction,
  };
  let savedSub;

  beforeEach(() => {
    savedSub = null;
    Organization.findById = async () => ({ _id: 'o1' });
    // No stripeSubscriptionId → the Stripe branch is skipped entirely.
    Subscription.findOne = () => ({
      planId: 'pro-monthly',
      save: async function () { savedSub = { planId: this.planId, status: this.status }; },
      lean: async () => ({ planId: 'pro-monthly' }),
    });
    creditService.expireSubscriptionCredits = async () => ({ expired: 3 });
    UsageTracker.deleteMany = async () => ({});
    CreditTransaction.logTransaction = async () => {};
  });
  afterEach(() => {
    Organization.findById = real.findById;
    Subscription.findOne = real.subFind;
    creditService.expireSubscriptionCredits = real.expire;
    UsageTracker.deleteMany = real.del;
    CreditTransaction.logTransaction = real.log;
  });

  it('cancels the plan in the DB and reports the summary', async () => {
    const res = mockRes();
    await adminController.resetOrgToFree({ params: { orgId: 'o1' }, user: { email: 'a@b.c' } }, res);
    assert.equal(res.statusCode, 200);
    assert.strictEqual(res.body.summary.creditsExpired, 3);
    assert.strictEqual(res.body.summary.usageReset, true);
    assert.strictEqual(res.body.summary.stripeCanceled, false);
    assert.strictEqual(savedSub.planId, 'free');
    assert.strictEqual(savedSub.status, 'canceled');
  });

  it('400s when the org is already free', async () => {
    Subscription.findOne = () => ({ lean: async () => ({ planId: 'free' }) });
    const res = mockRes();
    await adminController.resetOrgToFree({ params: { orgId: 'o1' }, user: { email: 'a@b.c' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

// ── adminUpdateBrandConfig — payload validation ────────────────
describe('adminUpdateBrandConfig — payload validation + org check', () => {
  const real = { findById: Organization.findById, update: brandService.updateBrand, audit: auditService.record };

  beforeEach(() => {
    auditService.record = () => {};
    brandService.updateBrand = async () => ({ ok: true });
  });
  afterEach(() => {
    Organization.findById = real.findById;
    brandService.updateBrand = real.update;
    auditService.record = real.audit;
  });

  const call = async (orgId, body) => {
    const res = mockRes();
    await brandController.adminUpdateBrandConfig({ params: { orgId }, body, user: { userId: 'u1', email: 'a@b.c' }, ip: '1.1.1.1' }, res);
    return res;
  };

  it('rejects an invalid primaryColor (400)', async () => {
    Organization.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'o1' }) }) });
    assert.equal((await call('o1', { primaryColor: 'red' })).statusCode, 400);
  });

  it('rejects a javascript: logo URL (400)', async () => {
    Organization.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'o1' }) }) });
    assert.equal((await call('o1', { logoUrl: 'javascript:alert(1)' })).statusCode, 400);
  });

  it('404s an unknown org', async () => {
    Organization.findById = () => ({ select: () => ({ lean: async () => null }) });
    assert.equal((await call('o1', { productName: 'X' })).statusCode, 404);
  });

  it('accepts a valid patch (200)', async () => {
    Organization.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'o1' }) }) });
    const res = await call('o1', { productName: 'Acme', primaryColor: '#112233' });
    assert.equal(res.statusCode, 200);
  });
});
