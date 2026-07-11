/**
 * Phase 18A — agency offboarding state machine (lifecycleService).
 *
 * Verifies the transitions (startWindDown / recover / suspend / reconcile /
 * runDueSuspensions), the trigger predicate (hasLiveClientAssets), dark-safety
 * (every entry point inert when saasMode is off), and that suspend() runs its
 * teardown (cancel client subs, lock client workspaces, deactivate domains,
 * revert brand) while a failing step never blocks the transition.
 *
 * Models/services monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/services/lifecycleService');
const Organization = require('../src/models/Organization');
const ClientSubscription = require('../src/models/ClientSubscription');
const Workspace = require('../src/models/Workspace');
const Domain = require('../src/models/Domain');
const Subscription = require('../src/models/Subscription');
const flagService = require('../src/services/flagService');
const brandService = require('../src/services/brandService');
const domainService = require('../src/services/domainService');
const auditService = require('../src/services/auditService');
const stripeService = require('../src/services/stripeService');
const cloudflareService = require('../src/services/cloudflareService');

// ── mock query helpers ──
// findById in the transitions is `await Model.findById()` (→ doc with .save());
// in reconcile it's `.select().lean()` (→ plain). This object serves both.
function docQuery(doc) {
  const q = { select() { return q; }, lean: async () => (doc ? { ...doc } : null), then(res) { res(doc); } };
  return q;
}
// findOne(...).select().lean() → plain value
function leanQuery(val) {
  return { select() { return this; }, sort() { return this; }, lean: async () => val };
}

// ── shared harness state ──
let org, flagLive, entitled, hasSub, hasWs, clientSubs, domains, calls, dunning;

function makeOrg(over = {}) {
  return {
    _id: 'org1', ownerId: 'owner1', name: 'Acme', stripeConnectAccountId: 'acct_1',
    lifecycleStatus: 'active', lifecycleReason: null, windDownStartedAt: null,
    suspendAt: null, suspendedAt: null, purgeAt: null,
    async save() { calls.orgSaves.push(this.lifecycleStatus); return this; },
    ...over,
  };
}

const origs = {};
beforeEach(() => {
  org = makeOrg();
  flagLive = true; entitled = false; hasSub = false; hasWs = false; dunning = false;
  clientSubs = []; domains = [];
  calls = { orgSaves: [], audits: [], stripeCancels: [], wsUpdateMany: 0, brandCacheCleared: [], domainCacheCleared: 0, subSaves: [], domainSaves: [] };

  origs.orgFindById = Organization.findById;
  origs.orgFOU = Organization.findOneAndUpdate;
  origs.orgFind = Organization.find;
  origs.csFindOne = ClientSubscription.findOne;
  origs.csFind = ClientSubscription.find;
  origs.wsFindOne = Workspace.findOne;
  origs.wsUpdateMany = Workspace.updateMany;
  origs.domainFind = Domain.find;
  origs.flag = flagService.isFlagLive;
  origs.entitled = brandService.isSaasModeEntitled;
  origs.brandFor = brandService.getBrandForOrg;
  origs.clearBrand = brandService.clearBrandCache;
  origs.clearDomain = domainService.clearDomainCache;
  origs.audit = auditService.record;
  origs.connOpts = stripeService.connectedAccountOptions;
  origs.stripe = stripeService.stripe;
  origs.cfConfigured = cloudflareService.isConfigured;
  origs.subExists = Subscription.exists;

  Organization.findById = () => docQuery(org);
  // Atomic conditional claim: applies $set only when the current status matches
  // the filter, else returns null (simulates the concurrent-safe transition).
  Organization.findOneAndUpdate = async (filter, update) => {
    const want = filter.lifecycleStatus;
    const matches = want && typeof want === 'object' && Array.isArray(want.$in)
      ? want.$in.includes(org.lifecycleStatus)
      : org.lifecycleStatus === want;
    if (!matches) return null;
    Object.assign(org, update.$set);
    calls.orgSaves.push(org.lifecycleStatus);
    return { ...org };
  };
  Organization.find = () => leanQuery([{ _id: org._id }]);
  ClientSubscription.findOne = () => leanQuery(hasSub ? { _id: 's1' } : null);
  ClientSubscription.find = async () => clientSubs;
  Workspace.findOne = () => leanQuery(hasWs ? { _id: 'w1' } : null);
  Workspace.updateMany = async () => { calls.wsUpdateMany++; return {}; };
  Domain.find = async () => domains;
  flagService.isFlagLive = async () => flagLive;
  brandService.isSaasModeEntitled = async () => entitled;
  brandService.getBrandForOrg = async () => ({ brand: { brandName: 'Acme' } });
  brandService.clearBrandCache = (id) => calls.brandCacheCleared.push(id);
  domainService.clearDomainCache = () => { calls.domainCacheCleared++; };
  auditService.record = (e) => calls.audits.push(e.action);
  stripeService.connectedAccountOptions = () => ({});
  stripeService.stripe = { subscriptions: { cancel: async (id) => { calls.stripeCancels.push(id); } } };
  cloudflareService.isConfigured = () => false;
  Subscription.exists = async () => dunning ? { _id: 'sub_pd' } : null;
});

afterEach(() => {
  Organization.findById = origs.orgFindById;
  Organization.findOneAndUpdate = origs.orgFOU;
  Organization.find = origs.orgFind;
  ClientSubscription.findOne = origs.csFindOne;
  ClientSubscription.find = origs.csFind;
  Workspace.findOne = origs.wsFindOne;
  Workspace.updateMany = origs.wsUpdateMany;
  Domain.find = origs.domainFind;
  flagService.isFlagLive = origs.flag;
  brandService.isSaasModeEntitled = origs.entitled;
  brandService.getBrandForOrg = origs.brandFor;
  brandService.clearBrandCache = origs.clearBrand;
  domainService.clearDomainCache = origs.clearDomain;
  auditService.record = origs.audit;
  stripeService.connectedAccountOptions = origs.connOpts;
  Subscription.exists = origs.subExists;
  stripeService.stripe = origs.stripe;
  cloudflareService.isConfigured = origs.cfConfigured;
});

describe('hasLiveClientAssets', () => {
  it('true when a client subscription exists', async () => {
    hasSub = true;
    assert.equal(await lifecycle.hasLiveClientAssets('org1'), true);
  });
  it('true when a client-provisioned workspace exists', async () => {
    hasWs = true;
    assert.equal(await lifecycle.hasLiveClientAssets('org1'), true);
  });
  it('false when neither exists', async () => {
    assert.equal(await lifecycle.hasLiveClientAssets('org1'), false);
  });
});

describe('startWindDown', () => {
  it('DARK: no-op when saasMode is off', async () => {
    flagLive = false; hasSub = true;
    const r = await lifecycle.startWindDown('org1');
    assert.equal(r, null);
    assert.equal(org.lifecycleStatus, 'active');
    assert.equal(calls.orgSaves.length, 0);
  });

  it('active + has clients → winding_down with a 30-day grace deadline + audit', async () => {
    hasSub = true;
    const r = await lifecycle.startWindDown('org1', 'entitlement_lost');
    assert.equal(r.lifecycleStatus, 'winding_down');
    assert.ok(org.windDownStartedAt instanceof Date);
    const graceMs = org.suspendAt.getTime() - org.windDownStartedAt.getTime();
    assert.equal(Math.round(graceMs / lifecycle.DAY_MS), lifecycle.GRACE_DAYS);
    assert.ok(calls.audits.includes('lifecycle.wind_down_started'));
  });

  it('no client assets → stays active (quiet entitlement drop)', async () => {
    hasSub = false; hasWs = false;
    const r = await lifecycle.startWindDown('org1');
    assert.equal(r, null);
    assert.equal(org.lifecycleStatus, 'active');
  });

  it('idempotent: already winding_down → no-op', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down' }); hasSub = true;
    const r = await lifecycle.startWindDown('org1');
    assert.equal(r, null);
    assert.equal(calls.orgSaves.length, 0);
  });

  it('atomic claim: a repeat call does NOT re-audit or re-notify (idempotent transition)', async () => {
    hasSub = true;
    await lifecycle.startWindDown('org1'); // active → winding_down (claims)
    const auditsAfterFirst = calls.audits.length;
    const r2 = await lifecycle.startWindDown('org1'); // status now winding_down → claim fails
    assert.equal(r2, null);
    assert.equal(calls.audits.length, auditsAfterFirst, 'no second wind_down audit');
  });
});

describe('recover', () => {
  it('winding_down → active, clears fields + audit', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down', windDownStartedAt: new Date(), suspendAt: new Date() });
    const r = await lifecycle.recover('org1');
    assert.equal(r.lifecycleStatus, 'active');
    assert.equal(org.windDownStartedAt, null);
    assert.equal(org.suspendAt, null);
    assert.ok(calls.audits.includes('lifecycle.recovered'));
  });
  it('not winding_down → no-op', async () => {
    const r = await lifecycle.recover('org1'); // active
    assert.equal(r, null);
  });

  it('CANNOT recover a suspending org (race guard) — recover requires winding_down', async () => {
    org = makeOrg({ lifecycleStatus: 'suspending' });
    const r = await lifecycle.recover('org1');
    assert.equal(r, null, 'a re-subscribe mid-teardown cannot flip suspending→active');
    assert.equal(org.lifecycleStatus, 'suspending');
  });
});

describe('suspend', () => {
  it('winding_down → suspended with 90-day purge deadline, and runs full teardown', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down' });
    clientSubs = [
      { _id: 'cs1', stripeSubscriptionId: 'sub_1', connectedAccountId: 'acct_1', status: 'active', async save() { calls.subSaves.push(this.status); } },
    ];
    domains = [
      { _id: 'd1', hostname: 'acme.com', status: 'active', cloudflareId: 'cf1', async save() { calls.domainSaves.push(this.status); } },
    ];

    const r = await lifecycle.suspend('org1');
    assert.equal(r.lifecycleStatus, 'suspended');
    assert.ok(org.suspendedAt instanceof Date);
    const retMs = org.purgeAt.getTime() - org.suspendedAt.getTime();
    assert.equal(Math.round(retMs / lifecycle.DAY_MS), lifecycle.RETENTION_DAYS);
    assert.ok(calls.audits.includes('lifecycle.suspended'));

    // teardown
    assert.deepEqual(calls.stripeCancels, ['sub_1'], 'client sub cancelled on Stripe');
    assert.deepEqual(calls.subSaves, ['canceled'], 'client sub marked canceled');
    assert.equal(calls.wsUpdateMany, 1, 'client workspaces locked');
    assert.deepEqual(calls.domainSaves, ['suspended'], 'domain deactivated');
    assert.equal(domains[0].cloudflareId, '', 'cloudflare id cleared');
    assert.ok(calls.brandCacheCleared.includes('org1'), 'brand cache cleared (reverts to platform)');
  });

  it('not winding_down → no-op (cannot suspend an active org directly)', async () => {
    const r = await lifecycle.suspend('org1'); // active
    assert.equal(r, null);
  });

  it('a failing teardown step never blocks the status transition', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down' });
    Workspace.updateMany = async () => { throw new Error('db down'); };
    const r = await lifecycle.suspend('org1');
    assert.equal(r.lifecycleStatus, 'suspended', 'still suspended despite the step failure');
  });

  it('HOLDS at suspending (no finalize) while a transient Stripe cancel failure pends retry', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down' });
    clientSubs = [
      { _id: 'cs1', stripeSubscriptionId: 'sub_1', connectedAccountId: 'acct_1', status: 'active', async save() { calls.subSaves.push(this.status); } },
    ];
    stripeService.stripe = { subscriptions: { cancel: async () => { throw Object.assign(new Error('rate limited'), { statusCode: 429 }); } } };
    const r = await lifecycle.suspend('org1');
    assert.equal(r, null, 'suspend returns null — held for retry');
    assert.equal(org.lifecycleStatus, 'suspending', 'stays suspending so the daily re-drive retries the cancel');
    assert.deepEqual(calls.subSaves, [], 'sub NOT falsely marked canceled');
    assert.ok(!calls.audits.includes('lifecycle.suspended'), 'no suspended audit while held');
  });

  it('finalizes when the only uncancellable sub has no connected account (manual case, non-blocking)', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down', stripeConnectAccountId: null });
    clientSubs = [
      { _id: 'cs1', stripeSubscriptionId: 'sub_1', connectedAccountId: null, status: 'active', async save() { calls.subSaves.push(this.status); } },
    ];
    const r = await lifecycle.suspend('org1');
    assert.equal(r.lifecycleStatus, 'suspended', 'no-acct sub is manual-handling, not a retry blocker');
  });
});

describe('reconcile (from current entitlement)', () => {
  it('DARK: no-op', async () => {
    flagLive = false; entitled = false;
    await lifecycle.reconcile('org1');
    assert.equal(calls.orgSaves.length, 0);
    assert.equal(org.lifecycleStatus, 'active');
  });
  it('not entitled + active + has clients → starts wind-down', async () => {
    entitled = false; hasSub = true;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'winding_down');
  });
  it('DUNNING GRACE: past_due platform sub → NO wind-down (no client email blast on a card retry)', async () => {
    entitled = false; hasSub = true; dunning = true;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'active', 'stays active while Stripe retries the card');
  });
  it('entitled + winding_down → recovers', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down' }); entitled = true;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'active');
  });
  it('entitled + active → no-op', async () => {
    entitled = true;
    await lifecycle.reconcile('org1');
    assert.equal(calls.orgSaves.length, 0);
  });
  it('entitled + suspended → restores (Phase 18D)', async () => {
    org = makeOrg({ lifecycleStatus: 'suspended' }); entitled = true;
    const restoreService = require('../src/services/restoreService');
    const origRestore = restoreService.restoreSuspendedOrg;
    let restoredWith = null;
    restoreService.restoreSuspendedOrg = async (id) => { restoredWith = id; return { restored: true }; };
    try {
      await lifecycle.reconcile('org1');
      assert.equal(restoredWith, 'org1');
    } finally {
      restoreService.restoreSuspendedOrg = origRestore;
    }
  });
});

describe('runDueSuspensions', () => {
  it('DARK: skipped', async () => {
    flagLive = false;
    const r = await lifecycle.runDueSuspensions();
    assert.deepEqual(r, { suspended: 0, skipped: 'dark' });
  });
  it('suspends each org past its grace deadline', async () => {
    org = makeOrg({ lifecycleStatus: 'winding_down' });
    const r = await lifecycle.runDueSuspensions(new Date());
    assert.equal(r.due, 1);
    assert.equal(r.suspended, 1);
    assert.equal(org.lifecycleStatus, 'suspended');
  });
});
