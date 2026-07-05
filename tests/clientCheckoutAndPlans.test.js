/**
 * Tests for the Phase 16 tenant client checkout + agency plan pricing rotation.
 *
 *   - checkout is a no-leak 404 when saasMode isn't live/entitled,
 *   - checkout requires planId + workspaceId + a valid email,
 *   - checkout refuses a workspace that already has an occupying sub (409),
 *   - checkout builds the session ON the connected account with NO application
 *     fee (agency keeps 100%),
 *   - createPlan is refused until Connect onboarding completes (409),
 *   - updatePlan rotates the Stripe Price (new price + archive old) only when
 *     pricing changes, and never mutates it otherwise.
 *
 * Stripe faked via require-cache; models/services monkey-patched. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// stripeService.isConfigured() reads STRIPE_SECRET_KEY at call time; the
// checkout path 503s without it. Set a dummy for this file, restore after.
const _hadStripeKey = 'STRIPE_SECRET_KEY' in process.env;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ── Fake Stripe (BEFORE requiring controllers) ────
const stripeState = { sessionCreateArgs: null, priceCreates: [], priceUpdates: [], productCreates: [] };
class FakeStripe {
  constructor() {
    this.checkout = {
      sessions: {
        create: async (params, opts) => {
          stripeState.sessionCreateArgs = { params, opts };
          return { url: 'https://checkout.stripe/x' };
        },
      },
    };
    this.products = { create: async (p, o) => { stripeState.productCreates.push({ p, o }); return { id: 'prod_1' }; } };
    this.prices = {
      create: async (p, o) => { stripeState.priceCreates.push({ p, o }); return { id: `price_${stripeState.priceCreates.length}` }; },
      update: async (id, p, o) => { stripeState.priceUpdates.push({ id, p, o }); return { id }; },
    };
    this.webhooks = { constructEvent: () => ({}) };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const clientCheckout = require('../src/controllers/clientCheckoutController');
const agencyPlan = require('../src/controllers/agencyPlanController');
const flagService = require('../src/services/flagService');
const brandService = require('../src/services/brandService');
const domainService = require('../src/services/domainService');
const AgencyPlan = require('../src/models/AgencyPlan');
const ClientSubscription = require('../src/models/ClientSubscription');
const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const orgMemberController = require('../src/controllers/orgMemberController');
const auditService = require('../src/services/auditService');

const real = {
  isFlagLive: flagService.isFlagLive,
  isSaas: brandService.isSaasModeEntitled,
  resolveHost: domainService.resolveOrgByHost,
  resolveBase: domainService.resolveBaseUrl,
  getBrand: brandService.getBrandForOrg,
  planFindOne: AgencyPlan.findOne,
  planFind: AgencyPlan.find,
  csFindOne: ClientSubscription.findOne,
  wsFindOne: Workspace.findOne,
  orgFindById: Organization.findById,
  resolveOrg: orgMemberController.resolveOrgWithAccess,
  audit: auditService.record,
};
after(() => { if (!_hadStripeKey) delete process.env.STRIPE_SECRET_KEY; });
after(() => Object.assign(flagService, { isFlagLive: real.isFlagLive }) && Object.assign(brandService, { isSaasModeEntitled: real.isSaas, getBrandForOrg: real.getBrand }) && Object.assign(domainService, { resolveOrgByHost: real.resolveHost, resolveBaseUrl: real.resolveBase }) && Object.assign(AgencyPlan, { findOne: real.planFindOne, find: real.planFind }) && Object.assign(ClientSubscription, { findOne: real.csFindOne }) && Object.assign(Workspace, { findOne: real.wsFindOne }) && Object.assign(Organization, { findById: real.orgFindById }) && Object.assign(orgMemberController, { resolveOrgWithAccess: real.resolveOrg }) && Object.assign(auditService, { record: real.audit }));

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

beforeEach(() => {
  stripeState.sessionCreateArgs = null;
  stripeState.priceCreates = [];
  stripeState.priceUpdates = [];
  stripeState.productCreates = [];
  auditService.record = () => {};
  flagService.isFlagLive = async () => true;
  brandService.isSaasModeEntitled = async () => true;
  domainService.resolveOrgByHost = async () => 'org-1';
  domainService.resolveBaseUrl = async () => 'https://agency.com';
  brandService.getBrandForOrg = async () => ({ brand: { productName: 'Acme' } });
});

// ── Client checkout ────────────────────────────────────────────

describe('client checkout — gating + validation', () => {
  it('404s when saasMode is not live (no leak)', async () => {
    flagService.isFlagLive = async () => false;
    const r = res();
    await clientCheckout.createClientCheckout({ headers: { 'x-tenant-host': 'agency.com' }, body: { planId: 'p', workspaceId: 'w', email: 'a@b.co' } }, r);
    assert.equal(r.statusCode, 404);
  });

  it('400s without a workspaceId (Phase 16 binds to an existing workspace)', async () => {
    const r = res();
    await clientCheckout.createClientCheckout({ headers: { 'x-tenant-host': 'agency.com' }, body: { planId: 'p', email: 'a@b.co' } }, r);
    assert.equal(r.statusCode, 400);
  });
});

describe('client checkout — session creation', () => {
  beforeEach(() => {
    Organization.findById = () => ({ lean: async () => ({ _id: 'org-1', stripeConnectAccountId: 'acct_1', connectChargesEnabled: true }) });
    AgencyPlan.findOne = () => ({ lean: async () => ({ _id: 'plan-1', stripePriceId: 'price_1', trialDays: 14 }) });
    // Workspace belongs to org-1 by default (ownership check passes).
    Workspace.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'ws-1' }) }) });
    ClientSubscription.findOne = () => ({ lean: async () => null });
  });

  it('creates the session ON the connected account with NO application fee', async () => {
    const r = res();
    await clientCheckout.createClientCheckout({ headers: { 'x-tenant-host': 'agency.com' }, body: { planId: 'plan-1', workspaceId: 'ws-1', email: 'a@b.co' } }, r);
    assert.equal(r.body.url, 'https://checkout.stripe/x');
    const { params, opts } = stripeState.sessionCreateArgs;
    assert.equal(opts.stripeAccount, 'acct_1', 'session created on the connected account');
    assert.equal(params.mode, 'subscription');
    assert.equal(params.subscription_data.trial_period_days, 14);
    assert.equal(params.metadata.workspaceId, 'ws-1');
    assert.equal(params.application_fee_percent, undefined, 'NO application fee');
    assert.equal(params.transfer_data, undefined, 'NO transfer_data — agency keeps 100%');
    assert.match(params.success_url, /^https:\/\/agency\.com\//, 'stays on the agency domain (I1)');
  });

  it('409s when the workspace already has an occupying subscription', async () => {
    ClientSubscription.findOne = () => ({ lean: async () => ({ _id: 'existing', status: 'active' }) });
    const r = res();
    await clientCheckout.createClientCheckout({ headers: { 'x-tenant-host': 'agency.com' }, body: { planId: 'plan-1', workspaceId: 'ws-1', email: 'a@b.co' } }, r);
    assert.equal(r.statusCode, 409);
    assert.equal(stripeState.sessionCreateArgs, null, 'no session created');
  });

  it('404s (no leak) when the workspace does not belong to the agency org (cross-tenant guard)', async () => {
    // Unauthenticated caller passes a workspaceId owned by a different org.
    Workspace.findOne = () => ({ select: () => ({ lean: async () => null }) });
    const r = res();
    await clientCheckout.createClientCheckout({ headers: { 'x-tenant-host': 'agency.com' }, body: { planId: 'plan-1', workspaceId: 'ws-foreign', email: 'a@b.co' } }, r);
    assert.equal(r.statusCode, 404);
    assert.equal(stripeState.sessionCreateArgs, null, 'no session created for a foreign workspace');
  });
});

// ── Agency plan pricing ────────────────────────────────────────

describe('agency plan — connect-ready guard + price rotation', () => {
  function gate(connectReady) {
    orgMemberController.resolveOrgWithAccess = async () => ({
      org: { _id: 'org-1', stripeConnectAccountId: 'acct_1', connectChargesEnabled: connectReady },
      callerRole: 'owner',
      accessScope: 'all',
    });
    brandService.isSaasModeEntitled = async () => true;
  }

  it('refuses createPlan until Connect onboarding is complete (409)', async () => {
    gate(false);
    const r = res();
    await agencyPlan.createPlan({ params: {}, user: { userId: 'u1' }, body: { name: 'Pro', amount: 4900 } }, r);
    assert.equal(r.statusCode, 409);
    assert.equal(stripeState.priceCreates.length, 0);
  });

  it('rotates the Stripe Price (new price + archive old) only when pricing changes', async () => {
    gate(true);
    const saved = [];
    AgencyPlan.findOne = async () => ({
      _id: 'plan-1', organizationId: 'org-1', amount: 4900, interval: 'month', currency: 'usd',
      stripeProductId: 'prod_1', stripePriceId: 'price_old', limits: {},
      save: async function () { saved.push({ amount: this.amount, priceId: this.stripePriceId }); },
    });
    const r = res();
    await agencyPlan.updatePlan({ params: { planId: 'plan-1' }, user: { userId: 'u1' }, body: { amount: 9900 } }, r);
    assert.equal(stripeState.priceCreates.length, 1, 'new price created');
    assert.equal(stripeState.priceCreates[0].p.unit_amount, 9900);
    assert.deepEqual(stripeState.priceUpdates[0], { id: 'price_old', p: { active: false }, o: { stripeAccount: 'acct_1' } }, 'old price archived');
    assert.equal(saved[0].amount, 9900);
  });

  it('does NOT touch Stripe when only metadata changes', async () => {
    gate(true);
    AgencyPlan.findOne = async () => ({
      _id: 'plan-1', organizationId: 'org-1', amount: 4900, interval: 'month', currency: 'usd',
      stripeProductId: 'prod_1', stripePriceId: 'price_old', limits: {}, save: async () => {},
    });
    const r = res();
    await agencyPlan.updatePlan({ params: { planId: 'plan-1' }, user: { userId: 'u1' }, body: { name: 'Renamed' } }, r);
    assert.equal(stripeState.priceCreates.length, 0, 'no price rotation on a name-only edit');
  });
});
