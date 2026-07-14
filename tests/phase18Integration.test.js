/**
 * Phase 18 END-TO-END integration — drives the REAL lifecycleService,
 * deletionService, and restoreService together against ONE shared in-memory
 * org/workspace/sub/domain state (unlike the per-part suites, which mock each
 * service's neighbours). Catches cross-service claim-filter mismatches and
 * stale-state bugs no isolated suite can see.
 *
 * Journey: active → winding_down → recover → winding_down → suspended
 *          → restore → suspended again → PURGED → restore (shell).
 * Races:   restore vs purging, suspend vs restoring, stale-purge TOCTOU.
 *
 * Only the MODEL layer and external services (Stripe/CF/email/flags) are faked;
 * every lifecycle decision runs the real service code.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/services/lifecycleService');
const deletion = require('../src/services/deletionService');
const restore = require('../src/services/restoreService');

const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const ClientSubscription = require('../src/models/ClientSubscription');
const Domain = require('../src/models/Domain');
const Subscription = require('../src/models/Subscription');
const AiTracker = require('../src/models/AiTracker');
const Sitemap = require('../src/models/Sitemap');

const flagService = require('../src/services/flagService');
const brandService = require('../src/services/brandService');
const domainService = require('../src/services/domainService');
const auditService = require('../src/services/auditService');
const stripeService = require('../src/services/stripeService');
const cloudflareService = require('../src/services/cloudflareService');

// every model deleteWorkspaceData touches (so the purge runs the REAL deletion path)
const DELETE_MODELS = [
  'Content', 'Plan', 'AgentUsageLog', 'KeywordResearchHistory', 'ReportShare', 'ReportSnapshot',
  'WorkspaceUsageTracker', 'WorkspaceMember', 'ClientSubscription', 'Site', 'Sitemap', 'CrawlPage',
  'BrandVoice', 'Avatar', 'AiTracker', 'AiTrackerScan', 'AiTrackerPrompt', 'AiTrackerCompetitor',
  'Invite', 'Workspace',
  'AiThread', 'AiThreadMessage', // Threads P5
].map((n) => [n, require(`../src/models/${n}`)]);

const DAY = 24 * 60 * 60 * 1000;

// ─── tiny Mongo-filter matcher (only the operators Phase 18 uses) ───
function matchCond(raw, cond) {
  const value = raw === undefined ? null : raw;
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('$in' in cond && !cond.$in.includes(value)) return false;
    if ('$ne' in cond && String(value) === String(cond.$ne)) return false;
    if ('$lte' in cond && !(value !== null && value <= cond.$lte)) return false;
    if ('$lt' in cond && !(value !== null && value < cond.$lt)) return false;
    if ('$type' in cond && cond.$type === 'string' && typeof value !== 'string') return false;
    if ('$gte' in cond && !(value !== null && value >= cond.$gte)) return false;
    return true;
  }
  return String(value) === String(cond);
}
function matches(doc, filter = {}) {
  for (const [k, cond] of Object.entries(filter)) {
    if (k === '$or') { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    if (!matchCond(doc[k], cond)) return false;
  }
  return true;
}
// chainable query: awaitable (live docs, for .save()) AND .select().lean() (copies)
function chain(docs) {
  const q = {
    select() { return q; },
    sort() { return q; },
    lean: async () => (Array.isArray(docs) ? docs.map((d) => ({ ...d })) : docs ? { ...docs } : null),
    then(res, rej) { Promise.resolve(docs).then(res, rej); },
  };
  return q;
}

// ─── shared state ───
let org, wsStore, csStore, domainStore, flags, entitled, calls;
const origs = {};

beforeEach(() => {
  flags = { saasMode: true, dataErasure: true };
  entitled = true;
  calls = { stripeCancels: [], audits: [], verifies: [], deletes: [] };

  org = {
    _id: 'org1', ownerId: 'owner1', name: 'Acme Agency', stripeConnectAccountId: 'acct_1',
    lifecycleStatus: 'active', lifecycleReason: null, windDownStartedAt: null,
    suspendAt: null, suspendedAt: null, purgeAt: null, purgedAt: null, updatedAt: new Date(),
  };
  wsStore = [{
    _id: 'ws1', organizationId: 'org1', name: 'Client One', clientProvisionedSubId: 'sub_c1',
    clientLocked: false, clientLockedAt: null,
  }];
  csStore = [{
    _id: 'cs1', organizationId: 'org1', workspaceId: 'ws1', stripeSubscriptionId: 'sub_c1',
    connectedAccountId: 'acct_1', status: 'active', clientEmail: null, canceledAt: null,
    async save() { return this; },
  }];
  domainStore = [{
    _id: 'd1', organizationId: 'org1', hostname: 'app.acme.co', status: 'active',
    cloudflareId: 'cf_1', statusDetail: '',
    async save() { return this; },
  }];

  // ── Organization: stateful fake honouring the real claim filters ──
  origs.orgFindById = Organization.findById;
  origs.orgFind = Organization.find;
  origs.orgFOU = Organization.findOneAndUpdate;
  origs.orgUpdateMany = Organization.updateMany;
  Organization.findById = () => chain({ ...org });
  Organization.find = (filter) => chain(matches(org, filter) ? [{ ...org }] : []);
  Organization.findOneAndUpdate = async (filter, update) => {
    if (!matches(org, filter)) return null;
    Object.assign(org, update.$set);
    org.updatedAt = new Date(); // mongoose timestamps
    return { ...org };
  };
  Organization.updateMany = async (filter, update) => {
    if (matches(org, filter)) { Object.assign(org, update.$set); org.updatedAt = new Date(); return { modifiedCount: 1 }; }
    return { modifiedCount: 0 };
  };

  // ── Workspace / ClientSubscription / Domain: filtered stores ──
  origs.wsFind = Workspace.find; origs.wsFindOne = Workspace.findOne; origs.wsUpdateMany = Workspace.updateMany;
  Workspace.find = (filter) => chain(wsStore.filter((d) => matches(d, filter)));
  Workspace.findOne = (filter) => chain(wsStore.find((d) => matches(d, filter)) || null);
  Workspace.updateMany = async (filter, update) => {
    const hit = wsStore.filter((d) => matches(d, filter));
    hit.forEach((d) => Object.assign(d, update.$set));
    return { modifiedCount: hit.length };
  };
  origs.csFind = ClientSubscription.find; origs.csFindOne = ClientSubscription.findOne;
  ClientSubscription.find = (filter) => chain(csStore.filter((d) => matches(d, filter)));
  ClientSubscription.findOne = (filter) => chain(csStore.find((d) => matches(d, filter)) || null);
  origs.domainFind = Domain.find;
  Domain.find = (filter) => chain(domainStore.filter((d) => matches(d, filter)));
  origs.subExists = Subscription.exists;
  Subscription.exists = async () => null; // no dunning
  origs.trFind = AiTracker.find; origs.smFind = Sitemap.find;
  AiTracker.find = () => chain([]);
  Sitemap.find = () => chain([]);
  // Threads P5: thread enumeration + COGS scrub in deleteWorkspaceData.
  const AiThreadModel = require('../src/models/AiThread');
  const AiCostLedgerModel = require('../src/models/AiCostLedger');
  origs.threadFind = AiThreadModel.find;
  origs.costScrub = AiCostLedgerModel.updateMany;
  AiThreadModel.find = () => chain([]);
  AiCostLedgerModel.updateMany = async () => ({ modifiedCount: 0 });

  // ── deleteMany across every purge-touched collection ──
  origs.deleteMany = {};
  for (const [name, Model] of DELETE_MODELS) {
    origs.deleteMany[name] = Model.deleteMany;
    Model.deleteMany = async (filter) => {
      calls.deletes.push(name);
      if (name === 'Workspace') wsStore = wsStore.filter((d) => !matches(d, filter));
      if (name === 'ClientSubscription') csStore = csStore.filter((d) => !matches(d, filter));
      return { deletedCount: 1 };
    };
  }

  // ── external services ──
  origs.flag = flagService.isFlagLive;
  origs.entitled = brandService.isSaasModeEntitled;
  origs.brandFor = brandService.getBrandForOrg;
  origs.clearBrand = brandService.clearBrandCache;
  origs.verify = domainService.verifyDomain;
  origs.clearDomain = domainService.clearDomainCache;
  origs.audit = auditService.record;
  origs.connOpts = stripeService.connectedAccountOptions;
  origs.stripe = stripeService.stripe;
  origs.cfConfigured = cloudflareService.isConfigured;
  flagService.isFlagLive = async (key) => !!flags[key];
  brandService.isSaasModeEntitled = async () => entitled;
  brandService.getBrandForOrg = async () => ({ brand: null });
  brandService.clearBrandCache = () => {};
  domainService.verifyDomain = async (id) => {
    calls.verifies.push(String(id));
    const d = domainStore.find((x) => String(x._id) === String(id));
    if (d) { d.status = 'active'; d.cloudflareId = 'cf_new'; }
  };
  domainService.clearDomainCache = () => {};
  auditService.record = (e) => calls.audits.push(e.action);
  stripeService.connectedAccountOptions = (acct) => ({ stripeAccount: acct });
  stripeService.stripe = { subscriptions: { cancel: async (id) => { calls.stripeCancels.push(id); } } };
  cloudflareService.isConfigured = () => false;
});

afterEach(() => {
  Organization.findById = origs.orgFindById; Organization.find = origs.orgFind;
  Organization.findOneAndUpdate = origs.orgFOU; Organization.updateMany = origs.orgUpdateMany;
  Workspace.find = origs.wsFind; Workspace.findOne = origs.wsFindOne; Workspace.updateMany = origs.wsUpdateMany;
  ClientSubscription.find = origs.csFind; ClientSubscription.findOne = origs.csFindOne;
  Domain.find = origs.domainFind; Subscription.exists = origs.subExists;
  AiTracker.find = origs.trFind; Sitemap.find = origs.smFind;
  require('../src/models/AiThread').find = origs.threadFind;
  require('../src/models/AiCostLedger').updateMany = origs.costScrub;
  for (const [name, Model] of DELETE_MODELS) Model.deleteMany = origs.deleteMany[name];
  flagService.isFlagLive = origs.flag; brandService.isSaasModeEntitled = origs.entitled;
  brandService.getBrandForOrg = origs.brandFor; brandService.clearBrandCache = origs.clearBrand;
  domainService.verifyDomain = origs.verify; domainService.clearDomainCache = origs.clearDomain;
  auditService.record = origs.audit; stripeService.connectedAccountOptions = origs.connOpts;
  stripeService.stripe = origs.stripe; cloudflareService.isConfigured = origs.cfConfigured;
});

describe('Phase 18 end-to-end journey (real services, shared state)', () => {
  it('active → wind-down → recover → wind-down → suspend → restore → suspend → PURGE → shell-restore', async () => {
    // 1. entitlement lost → wind-down (30-day grace)
    entitled = false;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'winding_down');
    assert.ok(org.suspendAt instanceof Date);

    // 2. re-subscribe within grace → recover (nothing was torn down)
    entitled = true;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'active');
    assert.equal(org.suspendAt, null);
    assert.equal(csStore[0].status, 'active', 'client sub untouched by recover');

    // 3. entitlement lost again; grace elapses → SUSPEND (full teardown)
    entitled = false;
    await lifecycle.reconcile('org1');
    const r1 = await lifecycle.runDueSuspensions(new Date(Date.now() + 31 * DAY));
    assert.equal(r1.suspended, 1);
    assert.equal(org.lifecycleStatus, 'suspended');
    assert.equal(org.suspendAt, null, 'suspendAt hygiene at finalize');
    assert.ok(org.purgeAt instanceof Date, '90-day retention deadline set');
    assert.deepEqual(calls.stripeCancels, ['sub_c1'], 'client sub cancelled on Stripe');
    assert.equal(csStore[0].status, 'canceled');
    assert.equal(wsStore[0].clientLocked, true, 'client workspace locked');
    assert.equal(domainStore[0].status, 'suspended', 'branded host deactivated');

    // 4. re-subscribe after suspension → RESTORE (reverses teardown; ws stays locked)
    entitled = true;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'active');
    assert.equal(org.purgeAt, null);
    assert.deepEqual(calls.verifies, ['d1'], 'domain re-verified');
    assert.equal(domainStore[0].status, 'active', 'branded host back');
    assert.equal(wsStore[0].clientLocked, true, 'workspace stays locked until the client re-subscribes');
    assert.ok(calls.audits.includes('lifecycle.restored'));

    // 5. lose entitlement again → suspend again → retention elapses → PURGE
    entitled = false;
    await lifecycle.reconcile('org1');
    assert.equal(org.lifecycleStatus, 'winding_down', 'client-provisioned ws still counts as a live asset');
    await lifecycle.runDueSuspensions(new Date(Date.now() + 31 * DAY));
    assert.equal(org.lifecycleStatus, 'suspended');
    const r2 = await deletion.runDuePurges(new Date(Date.now() + 121 * DAY));
    assert.equal(r2.purged, 1);
    assert.equal(org.lifecycleStatus, 'suspended', 'purge finalizes back to suspended');
    assert.ok(org.purgedAt instanceof Date);
    assert.equal(org.purgeAt, null, 'not re-picked by later sweeps');
    assert.equal(wsStore.length, 0, 'client workspace hard-deleted');
    assert.ok(calls.deletes.includes('Content') && calls.deletes.includes('Invite'), 'scoped collections erased');
    assert.ok(calls.audits.includes('lifecycle.purged'));

    // 6. re-subscribe after purge → shell restore (data gone, org reactivates)
    entitled = true;
    const shell = await restore.restoreSuspendedOrg('org1');
    assert.equal(shell.restored, true);
    assert.equal(shell.purged, true, 'restore reports the data was purged');
    assert.deepEqual(shell.clientSubsNeedingResubscribe, [], 'nothing to collect on the purged path');
    assert.equal(org.lifecycleStatus, 'active');
    assert.equal(org.purgedAt, null);
  });

  it('lost-wakeup sweep: a re-subscribe dropped mid-teardown is picked up by restoreEntitledSuspended', async () => {
    // org suspends while the agency is (as far as reconcile knows) unentitled…
    entitled = false;
    await lifecycle.reconcile('org1');
    await lifecycle.runDueSuspensions(new Date(Date.now() + 31 * DAY));
    assert.equal(org.lifecycleStatus, 'suspended');
    // …the re-subscribe webhook fired DURING teardown and was a no-op. The hourly
    // sweep closes the gap without waiting for the next billing webhook:
    entitled = true;
    const swept = await restore.restoreEntitledSuspended();
    assert.equal(swept.restored, 1);
    assert.equal(org.lifecycleStatus, 'active');
  });
});

describe('Phase 18 cross-service race guards (real claim filters)', () => {
  it('restore CANNOT claim an org mid-purge (purging is excluded)', async () => {
    org.lifecycleStatus = 'purging';
    org.purgeAt = new Date(Date.now() - DAY);
    const r = await restore.restoreSuspendedOrg('org1');
    assert.equal(r.restored, false);
    assert.equal(r.reason, 'not_suspended');
    assert.equal(org.lifecycleStatus, 'purging', 'purge keeps exclusive ownership');
  });

  it('a stale purge pass CANNOT delete a restored org (claim-before-delete)', async () => {
    // TOCTOU: the purge cron read its due-list while the org was suspended…
    org.lifecycleStatus = 'suspended';
    org.purgeAt = new Date(Date.now() - DAY);
    const staleDue = [{ _id: 'org1' }];
    Organization.find = () => chain(staleDue); // simulate the stale read
    // …but a restore completed before the purge claimed it.
    org.lifecycleStatus = 'active';
    org.purgeAt = null;
    const r = await deletion.runDuePurges(new Date());
    assert.equal(r.purged, 0);
    assert.equal(calls.deletes.length, 0, 'claim lost → NOTHING deleted from the live org');
    assert.equal(wsStore.length, 1, 'client workspace intact');
  });

  it('suspend CANNOT claim an org mid-restore (restoring is excluded)', async () => {
    org.lifecycleStatus = 'restoring';
    const r = await lifecycle.suspend('org1');
    assert.equal(r, null);
    assert.equal(org.lifecycleStatus, 'restoring');
  });

  it('recover CANNOT flip an org mid-teardown (suspending is excluded)', async () => {
    org.lifecycleStatus = 'suspending';
    const r = await lifecycle.recover('org1');
    assert.equal(r, null);
    assert.equal(org.lifecycleStatus, 'suspending');
  });

  it('kill-switch: darking the flags pauses destruction AND rolls a stranded purging org back to suspended', async () => {
    org.lifecycleStatus = 'purging';
    org.purgeAt = new Date(Date.now() - DAY);
    flags.dataErasure = false; // ops rollback
    const r = await deletion.runDuePurges(new Date());
    assert.equal(r.skipped, 'dark');
    assert.equal(calls.deletes.length, 0, 'nothing deleted while dark');
    assert.equal(org.lifecycleStatus, 'suspended', 'stranded purging org rolled back to a restorable state');
    // …and the org is now restorable even though destruction is paused
    const rr = await restore.restoreSuspendedOrg('org1');
    assert.equal(rr.restored, true);
    assert.equal(org.lifecycleStatus, 'active');
  });
});
