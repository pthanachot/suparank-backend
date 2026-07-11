/**
 * Phase 18D — tenant restore (restoreService).
 *
 * Verifies restoreSuspendedOrg reverses the suspend teardown: atomic
 * suspended→restoring→active transition, client-workspace unlock, domain reset +
 * re-verify, brand-cache clear, collection of cancelled client subs for manual
 * re-subscription, dark-safety, the not-suspended guard, and the purged-shell path.
 *
 * Models/services monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const restore = require('../src/services/restoreService');
const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const Domain = require('../src/models/Domain');
const ClientSubscription = require('../src/models/ClientSubscription');
const flagService = require('../src/services/flagService');
const brandService = require('../src/services/brandService');
const domainService = require('../src/services/domainService');
const cloudflareService = require('../src/services/cloudflareService');
const auditService = require('../src/services/auditService');

function leanQuery(val) {
  return { select() { return this; }, sort() { return this; }, lean: async () => val };
}

let org, flagLive, domainDocs, canceledSubs, calls;
const origs = {};

beforeEach(() => {
  org = { _id: 'org1', lifecycleStatus: 'suspended', purgedAt: null, suspendedAt: null, updatedAt: new Date() };
  flagLive = true;
  domainDocs = [];
  canceledSubs = [];
  calls = { updateMany: null, domainSaves: [], verifies: [], brandCleared: [], domainCacheCleared: 0, audits: [], finalize: null };

  origs.findById = Organization.findById;
  origs.orgFind = Organization.find;
  origs.fou = Organization.findOneAndUpdate;
  origs.updateMany = Workspace.updateMany;
  origs.domainFind = Domain.find;
  origs.csFind = ClientSubscription.find;
  origs.flag = flagService.isFlagLive;
  origs.brandClear = brandService.clearBrandCache;
  origs.verify = domainService.verifyDomain;
  origs.domainCache = domainService.clearDomainCache;
  origs.audit = auditService.record;

  Organization.findById = () => leanQuery({ lifecycleStatus: org.lifecycleStatus, purgedAt: org.purgedAt });
  Organization.find = () => leanQuery([]);
  Organization.findOneAndUpdate = async (filter, update) => {
    // Evaluate the claim's $or lease filter (suspended | stale restoring) and the
    // finalize's plain status filter against the shared `org` state.
    const matchBranch = (f) => {
      if (f.lifecycleStatus !== undefined) {
        const want = f.lifecycleStatus;
        const ok = want && typeof want === 'object' && Array.isArray(want.$in)
          ? want.$in.includes(org.lifecycleStatus)
          : org.lifecycleStatus === want;
        if (!ok) return false;
      }
      if (f.updatedAt?.$lt !== undefined && !(org.updatedAt < f.updatedAt.$lt)) return false;
      return true;
    };
    const matches = filter.$or ? filter.$or.some(matchBranch) : matchBranch(filter);
    if (!matches) return null;
    const snapshot = { ...org };
    Object.assign(org, update.$set);
    org.updatedAt = new Date(); // timestamps: findOneAndUpdate bumps updatedAt
    if (update.$set.lifecycleStatus === 'active') calls.finalize = { ...org };
    // claim returns the doc BEFORE flip fields (purgedAt still visible); good enough
    return { ...org, purgedAt: snapshot.purgedAt, suspendedAt: snapshot.suspendedAt };
  };
  Workspace.updateMany = async (filter, update) => { calls.updateMany = { filter, update }; return { modifiedCount: 3 }; };
  Domain.find = async () => domainDocs;
  ClientSubscription.find = () => leanQuery(canceledSubs);
  flagService.isFlagLive = async () => flagLive;
  brandService.clearBrandCache = (id) => { calls.brandCleared.push(id); };
  domainService.verifyDomain = async (id) => { calls.verifies.push(id); };
  domainService.clearDomainCache = () => { calls.domainCacheCleared++; };
  auditService.record = (e) => { calls.audits.push(e); };
});

afterEach(() => {
  Organization.findById = origs.findById; Organization.find = origs.orgFind; Organization.findOneAndUpdate = origs.fou;
  Workspace.updateMany = origs.updateMany; Domain.find = origs.domainFind; ClientSubscription.find = origs.csFind;
  flagService.isFlagLive = origs.flag; brandService.clearBrandCache = origs.brandClear;
  domainService.verifyDomain = origs.verify; domainService.clearDomainCache = origs.domainCache;
  auditService.record = origs.audit;
});

function makeDomain(over = {}) {
  return { _id: over._id || 'd1', hostname: 'acme.co', status: 'suspended', cloudflareId: 'cf_old', statusDetail: '',
    async save() { calls.domainSaves.push({ status: this.status, cloudflareId: this.cloudflareId }); return this; }, ...over };
}

describe('restoreSuspendedOrg', () => {
  it('is a no-op when saasMode is dark', async () => {
    flagLive = false;
    const r = await restore.restoreSuspendedOrg('org1');
    assert.deepEqual(r, { restored: false, skipped: 'dark' });
    assert.equal(calls.finalize, null);
  });

  it('refuses a non-suspended org', async () => {
    org.lifecycleStatus = 'active';
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, false);
    assert.equal(r.reason, 'not_suspended');
  });

  it('restores a suspended org: domains, brand, collect subs, →active (workspaces stay LOCKED)', async () => {
    domainDocs = [makeDomain()];
    canceledSubs = [{ clientEmail: 'c@acme.co', workspaceId: 'ws9' }];
    const r = await restore.restoreSuspendedOrg('org1');

    assert.equal(r.restored, true);
    assert.equal(r.purged, false);
    // client workspaces are NOT unlocked (avoids unbilled access) — no updateMany
    assert.equal(calls.updateMany, null);
    assert.equal(r.workspacesUnlocked, undefined);
    // domain reset to pending_dns (cloudflareId cleared) + re-verified
    assert.equal(calls.domainSaves[0].status, 'pending_dns');
    assert.equal(calls.domainSaves[0].cloudflareId, '');
    assert.deepEqual(calls.verifies, ['d1']);
    assert.equal(r.domainsReset, 1);
    // brand cache cleared
    assert.deepEqual(calls.brandCleared, ['org1']);
    // cancelled subs surfaced for manual re-subscription
    assert.deepEqual(r.clientSubsNeedingResubscribe, [{ clientEmail: 'c@acme.co', workspaceId: 'ws9' }]);
    // finalized to active with fields cleared
    assert.equal(org.lifecycleStatus, 'active');
    assert.equal(org.suspendedAt, null);
    assert.equal(org.purgeAt, null);
    assert.equal(org.purgedAt, null);
    assert.equal(calls.audits[0].action, 'lifecycle.restored');
  });

  it('deletes a lingering Cloudflare hostname before re-verify (no orphan)', async () => {
    domainDocs = [makeDomain({ cloudflareId: 'cf_stale' })];
    let cfDeleted = null;
    const origCfDel = cloudflareService.deleteCustomHostname;
    const origCfCfg = cloudflareService.isConfigured;
    cloudflareService.isConfigured = () => true;
    cloudflareService.deleteCustomHostname = async (id) => { cfDeleted = id; };
    try {
      await restore.restoreSuspendedOrg('org1');
      assert.equal(cfDeleted, 'cf_stale', 'stale CF hostname deleted before clearing the id');
      assert.equal(calls.domainSaves[0].cloudflareId, '');
    } finally {
      cloudflareService.deleteCustomHostname = origCfDel;
      cloudflareService.isConfigured = origCfCfg;
    }
  });

  it('scopes collected subs to this suspension (canceledAt >= suspendedAt)', async () => {
    org.suspendedAt = new Date('2026-06-01');
    let seenFilter = null;
    ClientSubscription.find = (f) => { seenFilter = f; return leanQuery([]); };
    await restore.restoreSuspendedOrg('org1');
    assert.ok(seenFilter.canceledAt && seenFilter.canceledAt.$gte instanceof Date,
      'sub collection scoped by canceledAt >= suspendedAt');
  });

  it('re-drives a STALE restoring org (crashed mid-restore, lease expired)', async () => {
    org.lifecycleStatus = 'restoring';
    org.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // stale > 1h
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, true);
    assert.equal(org.lifecycleStatus, 'active');
  });

  it('does NOT re-claim a FRESH in-flight restoring org (lease held → claim_lost)', async () => {
    org.lifecycleStatus = 'restoring';
    org.updatedAt = new Date(); // another worker is actively restoring
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, false);
    assert.equal(r.reason, 'claim_lost', 'two live restores must not run the reversal concurrently');
  });

  it('FINISHES a stale in-flight restore even when saasMode is dark (never strand restoring)', async () => {
    flagLive = false;
    org.lifecycleStatus = 'restoring';
    org.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, true, 'finishing an in-flight restore is not flag-gated');
    assert.equal(org.lifecycleStatus, 'active');
  });

  it('reactivates a PURGED org as a shell (no unlock / no sub collection)', async () => {
    org.purgedAt = new Date('2026-07-01');
    domainDocs = [makeDomain()];
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, true);
    assert.equal(r.purged, true);
    // purged path skips the workspace unlock + sub collection
    assert.equal(calls.updateMany, null);
    assert.deepEqual(r.clientSubsNeedingResubscribe, []);
    // but still reactivates domains + brand + flips to active with purgedAt cleared
    assert.equal(calls.domainSaves[0].status, 'pending_dns');
    assert.equal(org.lifecycleStatus, 'active');
    assert.equal(org.purgedAt, null);
  });

  it('returns claim_lost if the atomic claim is lost to a concurrent worker', async () => {
    // findById says suspended, but the claim findOneAndUpdate finds it already moved
    Organization.findOneAndUpdate = async () => null;
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, false);
    assert.equal(r.reason, 'claim_lost');
  });
});

describe('resumeStuckRestores', () => {
  it('not flag-gated (finishing in-flight restores must survive a dark flag); empty sweep is a no-op', async () => {
    flagLive = false;
    const r = await restore.resumeStuckRestores(new Date());
    assert.deepEqual(r, { resumed: 0, stuck: 0 });
  });

  it('re-drives an org stranded in restoring past the staleness threshold', async () => {
    Organization.find = () => leanQuery([{ _id: 'org1' }]);
    org.lifecycleStatus = 'restoring';
    org.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // stale
    const r = await restore.resumeStuckRestores(new Date());
    assert.equal(r.stuck, 1);
    assert.equal(r.resumed, 1);
    assert.equal(org.lifecycleStatus, 'active');
  });
});

describe('restoreEntitledSuspended (lost-wakeup sweep)', () => {
  it('dark → no-op (it STARTS new restores)', async () => {
    flagLive = false;
    const r = await restore.restoreEntitledSuspended();
    assert.deepEqual(r, { restored: 0, skipped: 'dark' });
  });

  it('restores a suspended org that is entitled again; skips unentitled ones', async () => {
    Organization.find = () => leanQuery([{ _id: 'org1' }]);
    let entitled = true;
    const origEnt = brandService.isSaasModeEntitled;
    brandService.isSaasModeEntitled = async () => entitled;
    try {
      const r = await restore.restoreEntitledSuspended();
      assert.equal(r.restored, 1, 'entitled suspended org restored within the sweep');
      assert.equal(org.lifecycleStatus, 'active');

      // reset to suspended + unentitled → skipped
      org.lifecycleStatus = 'suspended';
      entitled = false;
      const r2 = await restore.restoreEntitledSuspended();
      assert.equal(r2.restored, 0);
      assert.equal(org.lifecycleStatus, 'suspended');
    } finally {
      brandService.isSaasModeEntitled = origEnt;
    }
  });
});
