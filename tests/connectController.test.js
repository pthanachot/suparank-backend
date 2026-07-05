/**
 * Tests for the Connect onboarding controller (Phase 16) — the agency-facing
 * half of the money flow: onboard → status → disconnect.
 *
 * Covers:
 *   - onboard creates a Standard connected account when none exists, atomically
 *     claims it onto the org, and returns a Stripe-hosted onboarding link,
 *   - onboard reuses an existing connected account (no duplicate create),
 *   - onboard survives the concurrent-claim race (keeps the winner's account),
 *   - status retrieves + syncs charges/payouts/details flags,
 *   - disconnect REFUSES while a client sub is live (incl. past_due), and
 *     otherwise unlinks locally (never deletes the account) + deactivates plans.
 *
 * Stripe faked via require-cache; models/services monkey-patched. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const stripeState = { accountsCreated: [], links: [], retrieve: null };
class FakeStripe {
  constructor() {
    this.accounts = {
      create: async (params) => {
        const acct = { id: `acct_${stripeState.accountsCreated.length + 1}`, ...params };
        stripeState.accountsCreated.push(acct);
        return acct;
      },
      retrieve: async (id) => stripeState.retrieve || { id, charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: [] } },
    };
    this.accountLinks = {
      create: async (p) => { stripeState.links.push(p); return { url: 'https://connect.stripe/onboard' }; },
    };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const connectController = require('../src/controllers/connectController');
const stripeService = require('../src/services/stripeService');
const brandService = require('../src/services/brandService');
const orgMemberController = require('../src/controllers/orgMemberController');
const Organization = require('../src/models/Organization');
const ClientSubscription = require('../src/models/ClientSubscription');
const AgencyPlan = require('../src/models/AgencyPlan');
const User = require('../src/models/User');
const auditService = require('../src/services/auditService');

const real = {
  isConfigured: stripeService.isConfigured,
  isSaas: brandService.isSaasModeEntitled,
  resolveOrg: orgMemberController.resolveOrgWithAccess,
  orgFOU: Organization.findOneAndUpdate,
  orgFBI: Organization.findByIdAndUpdate,
  orgFB: Organization.findById,
  csFindOne: ClientSubscription.findOne,
  planUpdateMany: AgencyPlan.updateMany,
  userFB: User.findById,
  audit: auditService.record,
};
after(() => {
  stripeService.isConfigured = real.isConfigured;
  brandService.isSaasModeEntitled = real.isSaas;
  orgMemberController.resolveOrgWithAccess = real.resolveOrg;
  Organization.findOneAndUpdate = real.orgFOU;
  Organization.findByIdAndUpdate = real.orgFBI;
  Organization.findById = real.orgFB;
  ClientSubscription.findOne = real.csFindOne;
  AgencyPlan.updateMany = real.planUpdateMany;
  User.findById = real.userFB;
  auditService.record = real.audit;
});

let claims, orgUpdates, planDeactivations;
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqFor = (org) => ({ params: { orgId: String(org._id) }, user: { userId: 'u1', email: 'admin@x.io' }, ip: '1.2.3.4' });

function gate(org) {
  orgMemberController.resolveOrgWithAccess = async () => ({ org, callerRole: 'owner', accessScope: 'all' });
  brandService.isSaasModeEntitled = async () => true;
  stripeService.isConfigured = () => true;
}

beforeEach(() => {
  stripeState.accountsCreated = [];
  stripeState.links = [];
  stripeState.retrieve = null;
  claims = [];
  orgUpdates = [];
  planDeactivations = [];
  auditService.record = () => {};
  User.findById = () => ({ select: () => ({ lean: async () => ({ email: 'owner@x.io' }) }) });
  Organization.findByIdAndUpdate = async (id, update) => { orgUpdates.push(update); return {}; };
  AgencyPlan.updateMany = async (f, u) => { planDeactivations.push(u); return {}; };
  ClientSubscription.findOne = async () => null;
});

// ── onboard ────────────────────────────────────────────────────

describe('connect onboarding', () => {
  it('creates a Standard account, atomically claims it, and returns an onboarding link', async () => {
    gate({ _id: 'org-1', ownerId: 'owner-1', stripeConnectAccountId: null });
    Organization.findOneAndUpdate = async (filter, update) => { claims.push({ filter, update }); return { _id: 'org-1', stripeConnectAccountId: update.stripeConnectAccountId }; };
    const r = res();
    await connectController.startConnectOnboarding(reqFor({ _id: 'org-1' }), r);
    assert.equal(stripeState.accountsCreated.length, 1, 'one account created');
    assert.equal(stripeState.accountsCreated[0].type, 'standard', 'Standard type');
    assert.equal(claims.length, 1, 'atomic claim attempted');
    assert.ok(claims[0].filter.$or, 'claim guarded on null account id');
    assert.equal(stripeState.links[0].account, 'acct_1', 'onboarding link for the new account');
    assert.equal(r.body.url, 'https://connect.stripe/onboard');
  });

  it('reuses an existing connected account (no duplicate create)', async () => {
    gate({ _id: 'org-1', ownerId: 'owner-1', stripeConnectAccountId: 'acct_existing' });
    const r = res();
    await connectController.startConnectOnboarding(reqFor({ _id: 'org-1' }), r);
    assert.equal(stripeState.accountsCreated.length, 0, 'no new account');
    assert.equal(stripeState.links[0].account, 'acct_existing');
    assert.equal(r.body.url, 'https://connect.stripe/onboard');
  });

  it('survives the concurrent-claim race — keeps the winner\'s account', async () => {
    gate({ _id: 'org-1', ownerId: 'owner-1', stripeConnectAccountId: null });
    // Another request already claimed a different account → our atomic update matches nothing.
    Organization.findOneAndUpdate = async () => null;
    Organization.findById = () => ({ select: () => ({ lean: async () => ({ stripeConnectAccountId: 'acct_winner' }) }) });
    const r = res();
    await connectController.startConnectOnboarding(reqFor({ _id: 'org-1' }), r);
    assert.equal(stripeState.links[0].account, 'acct_winner', 'links the winner, not our orphan');
    assert.equal(r.body.url, 'https://connect.stripe/onboard');
  });
});

// ── status ─────────────────────────────────────────────────────

describe('connect status', () => {
  it('returns not-connected when the org has no account', async () => {
    gate({ _id: 'org-1', stripeConnectAccountId: null });
    const r = res();
    await connectController.getConnectStatus(reqFor({ _id: 'org-1' }), r);
    assert.equal(r.body.connected, false);
  });

  it('retrieves + syncs the account flags', async () => {
    gate({ _id: 'org-1', stripeConnectAccountId: 'acct_1', connectOnboardedAt: null });
    stripeState.retrieve = { id: 'acct_1', charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } };
    const r = res();
    await connectController.getConnectStatus(reqFor({ _id: 'org-1' }), r);
    assert.equal(r.body.connected, true);
    assert.equal(r.body.chargesEnabled, true);
    assert.equal(r.body.payoutsEnabled, true);
    assert.equal(orgUpdates[0].connectChargesEnabled, true, 'synced to DB');
    assert.ok(orgUpdates[0].connectOnboardedAt, 'stamps onboardedAt when charges first go live');
  });
});

// ── disconnect ─────────────────────────────────────────────────

describe('connect disconnect', () => {
  it('REFUSES (409) while a client subscription is live — including past_due', async () => {
    gate({ _id: 'org-1', stripeConnectAccountId: 'acct_1' });
    ClientSubscription.findOne = async (filter) => {
      assert.deepEqual(filter.status.$in.sort(), ['active', 'past_due', 'trialing'], 'past_due counts as live');
      return { _id: 'sub-1', status: 'past_due' };
    };
    const r = res();
    await connectController.disconnect(reqFor({ _id: 'org-1' }), r);
    assert.equal(r.statusCode, 409);
    assert.equal(orgUpdates.length, 0, 'nothing unlinked');
  });

  it('unlinks locally (never deletes the account) and deactivates plans when no live subs', async () => {
    gate({ _id: 'org-1', stripeConnectAccountId: 'acct_1' });
    ClientSubscription.findOne = async () => null;
    const r = res();
    await connectController.disconnect(reqFor({ _id: 'org-1' }), r);
    assert.equal(r.body.success, true);
    assert.equal(orgUpdates[0].stripeConnectAccountId, null, 'account id cleared locally');
    assert.equal(orgUpdates[0].connectChargesEnabled, false);
    assert.equal(planDeactivations[0].active, false, 'plans deactivated');
  });
});
