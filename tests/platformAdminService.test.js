/**
 * Phase 19B — platform-admin fleet views (platformAdminService).
 *
 * Tenant list: per-org client rollup REUSES Part A's primary-collapse + MRR
 * rules (trial excluded, one row per workspace), domain bucketing, tier from the
 * platform sub. Health board: exact counts (countDocuments) with capped item
 * samples so truncation never reads as "all clear". Models monkey-patched.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/platformAdminService');
const Organization = require('../src/models/Organization');
const User = require('../src/models/User');
const Subscription = require('../src/models/Subscription');
const Domain = require('../src/models/Domain');
const BrandConfig = require('../src/models/BrandConfig');
const ClientSubscription = require('../src/models/ClientSubscription');
const AgencyPlan = require('../src/models/AgencyPlan');

function chain(val) {
  const q = {
    select: () => q, sort: () => q, limit: () => q, skip: () => q,
    lean: async () => val,
    then: (r, j) => Promise.resolve(val).then(r, j),
  };
  return q;
}

const real = {};
beforeEach(() => {
  for (const [m, keys] of [
    [Organization, ['find', 'countDocuments']], [User, ['find']], [Subscription, ['find', 'countDocuments']],
    [Domain, ['find', 'countDocuments']], [BrandConfig, ['find', 'countDocuments']],
    [ClientSubscription, ['find', 'countDocuments']], [AgencyPlan, ['find']],
  ]) {
    for (const k of keys) real[`${m.modelName}.${k}`] = m[k];
  }
});
afterEach(() => {
  for (const key of Object.keys(real)) {
    const [model, method] = key.split('.');
    const m = { Organization, User, Subscription, Domain, BrandConfig, ClientSubscription, AgencyPlan }[model];
    m[method] = real[key];
  }
});

describe('_summariseOrgClientSubs (shared rollup)', () => {
  const planById = new Map([
    ['pA', { _id: 'pA', amount: 4900, currency: 'usd', interval: 'month' }],
    ['pB', { _id: 'pB', amount: 60000, currency: 'usd', interval: 'year' }],
  ]);

  it('counts access clients but excludes trials + collapses subs per workspace', () => {
    const subs = [
      { workspaceId: 'w1', agencyPlanId: 'pA', status: 'active' },
      { workspaceId: 'w2', agencyPlanId: 'pA', status: 'trialing' },        // access, no MRR
      { workspaceId: 'w3', agencyPlanId: 'pB', status: 'active' },          // year → /12
      { workspaceId: 'w1', agencyPlanId: 'pA', status: 'canceled' },        // old sub, same ws → collapsed
    ];
    const r = svc._summariseOrgClientSubs(subs, planById);
    assert.equal(r.clientCount, 3, 'w1,w2,w3 have access; the canceled w1 dup collapses');
    assert.equal(r.mrrByCurrency.usd, 4900 + 5000, 'active 49 + yearly 600/12=50; trial excluded');
  });

  it('empty → zeroes', () => {
    assert.deepEqual(svc._summariseOrgClientSubs([], planById), { clientCount: 0, mrrByCurrency: {} });
  });

  it('two billed subs on one workspace → most-recent primary (createdAt tiebreak works)', () => {
    // Regression: the tenant projection must include createdAt or this sort is inert.
    const subs = [
      { workspaceId: 'w1', agencyPlanId: 'pA', status: 'active', createdAt: new Date('2026-01-01') },
      { workspaceId: 'w1', agencyPlanId: 'pB', status: 'past_due', createdAt: new Date('2026-06-01') }, // newer
    ];
    const r = svc._summariseOrgClientSubs(subs, planById);
    assert.equal(r.clientCount, 1, 'one workspace');
    assert.equal(r.mrrByCurrency.usd, 5000, 'newer past_due on yearly pB (600/12), not the older active pA');
  });

  it('a zero-priced plan adds NO currency key (matches the console exactly)', () => {
    const planZero = new Map([['pZ', { _id: 'pZ', amount: 0, currency: 'usd', interval: 'month' }]]);
    const r = svc._summariseOrgClientSubs([{ workspaceId: 'w1', agencyPlanId: 'pZ', status: 'active' }], planZero);
    assert.equal(r.clientCount, 1);
    assert.deepEqual(r.mrrByCurrency, {}, 'no {usd:0} phantom key');
  });
});

describe('getTenantList', () => {
  beforeEach(() => {
    Organization.find = () => chain([
      { _id: 'org1', name: 'Acme', slug: 'acme', ownerId: 'u1', isPersonal: false, lifecycleStatus: 'active', stripeConnectAccountId: 'acct_1', connectChargesEnabled: true, connectPayoutsEnabled: false, createdAt: new Date() },
    ]);
    Organization.countDocuments = async () => 1;
    User.find = () => chain([{ _id: 'u1', email: 'owner@acme.co' }]);
    Subscription.find = () => chain([{ organizationId: 'org1', planId: 'agency-monthly', status: 'active' }]);
    Domain.find = () => chain([
      { organizationId: 'org1', status: 'active' },
      { organizationId: 'org1', status: 'failed' },
      { organizationId: 'org1', status: 'pending_dns' },
    ]);
    ClientSubscription.find = () => chain([
      { organizationId: 'org1', workspaceId: 'w1', agencyPlanId: 'pA', status: 'active' },
      { organizationId: 'org1', workspaceId: 'w2', agencyPlanId: 'pA', status: 'trialing' },
    ]);
    AgencyPlan.find = () => chain([{ _id: 'pA', amount: 4900, currency: 'usd', interval: 'month' }]);
  });

  it('enriches each tenant with owner, tier, connect, domain buckets, client rollup', async () => {
    const { tenants, pagination } = await svc.getTenantList({ page: 1, limit: 50 });
    assert.equal(pagination.total, 1);
    const t = tenants[0];
    assert.equal(t.owner, 'owner@acme.co');
    assert.equal(t.tier, 'agency', 'derived from planId prefix');
    assert.equal(t.platformSubStatus, 'active');
    assert.deepEqual(t.connect, { connected: true, chargesEnabled: true, payoutsEnabled: false });
    assert.deepEqual(t.domains, { total: 3, active: 1, failed: 1, pending: 1 });
    assert.equal(t.clientCount, 2, 'active + trialing both have access');
    assert.deepEqual(t.mrrByCurrency, { usd: 4900 }, 'trial excluded from MRR');
  });

  it('empty page returns no tenants but valid pagination', async () => {
    Organization.find = () => chain([]);
    Organization.countDocuments = async () => 0;
    const r = await svc.getTenantList({ page: 1, limit: 50 });
    assert.deepEqual(r.tenants, []);
    assert.equal(r.pagination.pages, 0);
  });

  it('a regex-metachar search does not throw and is escaped to a literal', async () => {
    // '(a+)+' would be a ReDoS pattern if passed raw into $regex.
    let sawFilter;
    Organization.find = (f) => { sawFilter = f; return chain([]); };
    Organization.countDocuments = async () => 0;
    await assert.doesNotReject(svc.getTenantList({ page: 1, limit: 50, search: '(a+)+' }));
    assert.match(sawFilter.$or[0].name.$regex, /\\\(a\\\+\\\)\\\+/, 'metachars are backslash-escaped');
  });
});

describe('getHealthBoard', () => {
  it('returns exact counts with capped item samples across all five signals', async () => {
    Domain.find = () => chain([{ hostname: 'x.co', organizationId: 'o1', status: 'failed' }]);
    Domain.countDocuments = async () => 7; // more than items → truncation surfaced by count
    BrandConfig.find = () => chain([{ organizationId: 'o1', emailDomain: { domain: 'mail.x.co', status: 'unverified' } }]);
    BrandConfig.countDocuments = async () => 1;
    ClientSubscription.find = () => chain([{ organizationId: 'o1', status: 'past_due' }]);
    ClientSubscription.countDocuments = async () => 2;
    Subscription.find = () => chain([{ organizationId: 'o1', status: 'past_due' }]);
    Subscription.countDocuments = async () => 1;
    Organization.find = () => chain([{ name: 'Acme', lifecycleStatus: 'winding_down' }]);
    Organization.countDocuments = async () => 1;

    const b = await svc.getHealthBoard();
    assert.equal(b.failedDomains.count, 7);
    assert.equal(b.failedDomains.items.length, 1);
    assert.equal(b.unverifiedEmailDomains.count, 1);
    assert.equal(b.unverifiedEmailDomains.items[0].domain, 'mail.x.co');
    assert.equal(b.failingClientPayments.count, 2);
    assert.equal(b.failingAgencyPayments.count, 1);
    assert.equal(b.agenciesOffboarding.count, 1);
    assert.equal(b.agenciesOffboarding.items[0].lifecycleStatus, 'winding_down');
    assert.ok(b.itemCap >= 1);
  });
});
