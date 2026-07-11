/**
 * Phase 18C — data deletion service (deletionService).
 *
 * Verifies workspace + org hard-erasure coverage (every scoped collection is
 * hit, tracker/sitemap children deleted before parents), live-sub Stripe cancel
 * and Cloudflare hostname cleanup before record deletion, resilience (one failing
 * deleteMany doesn't abort the rest), and the retention purge (dark-gated,
 * client-workspace-only, marks purgedAt, idempotent).
 *
 * Models/services monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const deletion = require('../src/services/deletionService');
const flagService = require('../src/services/flagService');
const auditService = require('../src/services/auditService');
const stripeService = require('../src/services/stripeService');
const cloudflareService = require('../src/services/cloudflareService');

const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const AiTracker = require('../src/models/AiTracker');
const Sitemap = require('../src/models/Sitemap');
const ClientSubscription = require('../src/models/ClientSubscription');
const Domain = require('../src/models/Domain');

// every collection the service issues deleteMany against
const DELETE_MODELS = {
  Content: require('../src/models/Content'),
  Plan: require('../src/models/Plan'),
  AgentUsageLog: require('../src/models/AgentUsageLog'),
  KeywordResearchHistory: require('../src/models/KeywordResearchHistory'),
  ReportShare: require('../src/models/ReportShare'),
  ReportSnapshot: require('../src/models/ReportSnapshot'),
  WorkspaceUsageTracker: require('../src/models/WorkspaceUsageTracker'),
  WorkspaceMember: require('../src/models/WorkspaceMember'),
  ClientSubscription,
  Site: require('../src/models/Site'),
  Sitemap,
  CrawlPage: require('../src/models/CrawlPage'),
  BrandVoice: require('../src/models/BrandVoice'),
  Avatar: require('../src/models/Avatar'),
  AiTracker,
  AiTrackerScan: require('../src/models/AiTrackerScan'),
  AiTrackerPrompt: require('../src/models/AiTrackerPrompt'),
  AiTrackerCompetitor: require('../src/models/AiTrackerCompetitor'),
  Workspace,
  Organization,
  AgencyPlan: require('../src/models/AgencyPlan'),
  BrandConfig: require('../src/models/BrandConfig'),
  Credit: require('../src/models/Credit'),
  CreditTransaction: require('../src/models/CreditTransaction'),
  Domain,
  GscConnection: require('../src/models/GscConnection'),
  Invite: require('../src/models/Invite'),
  OrgMember: require('../src/models/OrgMember'),
  Subscription: require('../src/models/Subscription'),
  TriggerableEmailTemplate: require('../src/models/TriggerableEmailTemplate'),
  UsageTracker: require('../src/models/UsageTracker'),
};

function leanQuery(val) {
  return { select() { return this; }, sort() { return this; }, lean: async () => val };
}

let deletes;   // [{ model, filter }]
let calls;
const origs = {};

beforeEach(() => {
  deletes = [];
  calls = { stripeCancels: [], cfDeletes: [], audits: [], orgUpdates: [] };

  // patch deleteMany on every target model
  origs.deleteMany = {};
  for (const [name, Model] of Object.entries(DELETE_MODELS)) {
    origs.deleteMany[name] = Model.deleteMany;
    Model.deleteMany = async (filter) => { deletes.push({ name, filter }); return { deletedCount: 1 }; };
  }

  // finds used to enumerate children / targets — default empty
  const Subscription = DELETE_MODELS.Subscription;
  origs.finds = {
    AiTracker: AiTracker.find, Sitemap: Sitemap.find, Workspace: Workspace.find,
    Organization: Organization.find, ClientSubscription: ClientSubscription.find, Domain: Domain.find,
    Subscription: Subscription.find,
  };
  AiTracker.find = () => leanQuery([]);
  Sitemap.find = () => leanQuery([]);
  Workspace.find = () => leanQuery([]);
  Organization.find = () => leanQuery([]);
  ClientSubscription.find = () => leanQuery([]);
  Domain.find = () => leanQuery([]);
  Subscription.find = () => leanQuery([]);

  origs.orgFindById = Organization.findById;
  Organization.findById = () => leanQuery({ stripeConnectAccountId: null });

  origs.orgUpdateMany = Organization.updateMany;
  Organization.updateMany = async (filter, update) => { calls.orgRollbacks = (calls.orgRollbacks || 0) + 1; return { modifiedCount: 0 }; };

  origs.orgFOU = Organization.findOneAndUpdate;
  Organization.findOneAndUpdate = async (filter, update) => {
    calls.orgUpdates.push({ filter, update });
    return { _id: filter._id, ...update.$set };
  };

  origs.flag = flagService.isFlagLive;
  origs.audit = auditService.record;
  origs.connOpts = stripeService.connectedAccountOptions;
  origs.stripe = stripeService.stripe;
  origs.cfConfigured = cloudflareService.isConfigured;
  origs.cfDelete = cloudflareService.deleteCustomHostname;

  flagService.isFlagLive = async () => true;
  auditService.record = (e) => { calls.audits.push(e); };
  stripeService.connectedAccountOptions = (acct) => ({ stripeAccount: acct });
  // record whether the cancel carried connected-account options (client sub) or
  // not (platform sub)
  stripeService.stripe = { subscriptions: { cancel: async (id, opts) => { calls.stripeCancels.push({ id, connected: !!opts }); } } };
  cloudflareService.isConfigured = () => true;
  cloudflareService.deleteCustomHostname = async (id) => { calls.cfDeletes.push(id); };
});

afterEach(() => {
  for (const [name, Model] of Object.entries(DELETE_MODELS)) Model.deleteMany = origs.deleteMany[name];
  AiTracker.find = origs.finds.AiTracker; Sitemap.find = origs.finds.Sitemap; Workspace.find = origs.finds.Workspace;
  Organization.find = origs.finds.Organization; ClientSubscription.find = origs.finds.ClientSubscription; Domain.find = origs.finds.Domain;
  DELETE_MODELS.Subscription.find = origs.finds.Subscription;
  Organization.findById = origs.orgFindById;
  Organization.updateMany = origs.orgUpdateMany;
  Organization.findOneAndUpdate = origs.orgFOU;
  flagService.isFlagLive = origs.flag; auditService.record = origs.audit;
  stripeService.connectedAccountOptions = origs.connOpts; stripeService.stripe = origs.stripe;
  cloudflareService.isConfigured = origs.cfConfigured; cloudflareService.deleteCustomHostname = origs.cfDelete;
});

const deletedNames = () => deletes.map((d) => d.name);
const filterFor = (name) => deletes.find((d) => d.name === name)?.filter;

describe('deleteWorkspaceData', () => {
  it('deletes every workspace-scoped collection and the workspace itself', async () => {
    const counts = await deletion.deleteWorkspaceData('ws1');
    const n = deletedNames();
    for (const expected of [
      'Content', 'Plan', 'AgentUsageLog', 'KeywordResearchHistory', 'ReportShare', 'ReportSnapshot',
      'WorkspaceUsageTracker', 'WorkspaceMember', 'ClientSubscription', 'Site', 'Sitemap',
      'BrandVoice', 'Avatar', 'AiTracker', 'Invite', 'Workspace',
    ]) {
      assert.ok(n.includes(expected), `expected ${expected} to be deleted`);
    }
    assert.deepEqual(filterFor('Workspace'), { _id: 'ws1' });
    // brand assets are scoped by `workspace`, not `workspaceId`
    assert.deepEqual(filterFor('BrandVoice'), { workspace: 'ws1' });
    assert.deepEqual(filterFor('Content'), { workspaceId: 'ws1' });
    // pending invites targeting this workspace (invitee email) are removed
    assert.deepEqual(filterFor('Invite'), { workspaceIds: 'ws1' });
    assert.equal(counts.workspace, 1);
  });

  it('deletes AI-tracker children (by trackerId) BEFORE the trackers', async () => {
    AiTracker.find = () => leanQuery([{ _id: 't1' }, { _id: 't2' }]);
    await deletion.deleteWorkspaceData('ws1');
    const n = deletedNames();
    assert.ok(n.includes('AiTrackerScan') && n.includes('AiTrackerPrompt') && n.includes('AiTrackerCompetitor'));
    assert.deepEqual(filterFor('AiTrackerScan'), { trackerId: { $in: ['t1', 't2'] } });
    // ordering: scans deleted before the parent tracker
    assert.ok(n.indexOf('AiTrackerScan') < n.indexOf('AiTracker'));
  });

  it('deletes CrawlPages (by sitemapId) BEFORE the sitemaps', async () => {
    Sitemap.find = () => leanQuery([{ _id: 'sm1' }]);
    await deletion.deleteWorkspaceData('ws1');
    const n = deletedNames();
    assert.ok(n.includes('CrawlPage'));
    assert.deepEqual(filterFor('CrawlPage'), { sitemapId: { $in: ['sm1'] } });
    assert.ok(n.indexOf('CrawlPage') < n.indexOf('Sitemap'));
  });

  it('cancels a still-live client subscription on Stripe before deleting records', async () => {
    ClientSubscription.find = () => leanQuery([
      { stripeSubscriptionId: 'sub_live', connectedAccountId: 'acct_9' },
      { stripeSubscriptionId: null, connectedAccountId: 'acct_9' }, // no stripe id → skipped
    ]);
    await deletion.deleteWorkspaceData('ws1');
    assert.deepEqual(calls.stripeCancels, [{ id: 'sub_live', connected: true }]);
  });

  it('falls back to the org connected account when a live sub lacks connectedAccountId', async () => {
    ClientSubscription.find = () => leanQuery([
      { stripeSubscriptionId: 'sub_x', connectedAccountId: null, organizationId: 'org1' },
    ]);
    Organization.findById = () => leanQuery({ stripeConnectAccountId: 'acct_org' });
    await deletion.deleteWorkspaceData('ws1');
    assert.deepEqual(calls.stripeCancels, [{ id: 'sub_x', connected: true }]);
  });

  it('is resilient: one failing deleteMany does not abort the rest', async () => {
    DELETE_MODELS.Content.deleteMany = async () => { throw new Error('boom'); };
    const counts = await deletion.deleteWorkspaceData('ws1');
    // the workspace still gets deleted despite Content failing
    assert.ok(deletedNames().includes('Workspace'));
    assert.equal(counts.errors.content, 'boom');
  });
});

describe('deleteOrgData', () => {
  it('erases each workspace then org-scoped collections and the org', async () => {
    Workspace.find = () => leanQuery([{ _id: 'ws1' }, { _id: 'ws2' }]);
    const counts = await deletion.deleteOrgData('org1');
    const n = deletedNames();
    for (const expected of [
      'AgencyPlan', 'BrandConfig', 'Credit', 'CreditTransaction', 'Domain', 'GscConnection',
      'Invite', 'OrgMember', 'Subscription', 'TriggerableEmailTemplate', 'UsageTracker', 'Organization',
    ]) {
      assert.ok(n.includes(expected), `expected ${expected} to be deleted`);
    }
    // two workspaces erased → Workspace.deleteMany called twice
    assert.equal(deletes.filter((d) => d.name === 'Workspace').length, 2);
    assert.deepEqual(filterFor('Organization'), { _id: 'org1' });
    assert.equal(counts.organization, 1);
  });

  it('removes Cloudflare hostnames before deleting Domain records', async () => {
    Domain.find = () => leanQuery([{ cloudflareId: 'cf_1' }, { cloudflareId: 'cf_2' }]);
    await deletion.deleteOrgData('org1');
    assert.deepEqual(calls.cfDeletes, ['cf_1', 'cf_2']);
    assert.ok(deletedNames().includes('Domain'));
  });

  it('cancels the agency platform subscription (no connected-account opts) before deleting', async () => {
    DELETE_MODELS.Subscription.find = () => leanQuery([{ stripeSubscriptionId: 'sub_platform' }]);
    await deletion.deleteOrgData('org1');
    assert.ok(calls.stripeCancels.some((c) => c.id === 'sub_platform' && c.connected === false),
      'platform sub canceled on the platform account, not a connected account');
    assert.ok(deletedNames().includes('Subscription'));
  });

  it('cancels an org-level remnant client sub before the org-level delete', async () => {
    // no workspaces → the only client-sub cancel path is the org-level sweep
    ClientSubscription.find = () => leanQuery([
      { stripeSubscriptionId: 'sub_remnant', connectedAccountId: 'acct_1', organizationId: 'org1' },
    ]);
    await deletion.deleteOrgData('org1');
    assert.ok(calls.stripeCancels.some((c) => c.id === 'sub_remnant' && c.connected === true));
  });
});

describe('runDuePurges', () => {
  it('is a no-op when dark, and rolls back any org stranded in purging', async () => {
    flagService.isFlagLive = async () => false;
    const r = await deletion.runDuePurges(new Date('2026-07-06'));
    assert.deepEqual(r, { purged: 0, skipped: 'dark' });
    assert.equal(deletes.length, 0);
    assert.equal(calls.orgRollbacks, 1, 'purging→suspended rollback sweep ran');
  });

  it('requires BOTH dataErasure AND saasMode (destruction pauses with the lifecycle kill switch)', async () => {
    flagService.isFlagLive = async (key) => key === 'dataErasure'; // saasMode dark
    Organization.find = () => leanQuery([{ _id: 'org1' }]);
    const r = await deletion.runDuePurges(new Date('2026-07-06'));
    assert.equal(r.skipped, 'dark');
    assert.equal(deletes.length, 0, 'no deletion while saasMode is dark');
  });

  it('claims purging, purges CLIENT workspaces, then finalizes (purgeAt cleared, purgedAt set) + audits', async () => {
    Organization.find = () => leanQuery([{ _id: 'org1' }]);
    // only client-provisioned workspaces are purged
    Workspace.find = () => leanQuery([{ _id: 'cws1' }]);
    const now = new Date('2026-07-06');
    const r = await deletion.runDuePurges(now);

    assert.equal(r.purged, 1);
    assert.equal(r.due, 1);
    // the org itself is NOT deleted — only its client workspace data
    assert.ok(!deletedNames().includes('Organization'));
    assert.ok(deletedNames().includes('Workspace'));
    // TWO transitions: claim suspended→purging (before delete), then finalize
    assert.equal(calls.orgUpdates.length, 2);
    assert.equal(calls.orgUpdates[0].update.$set.lifecycleStatus, 'purging');
    assert.equal(calls.orgUpdates[1].update.$set.purgedAt, now);
    assert.equal(calls.orgUpdates[1].update.$set.purgeAt, null);
    assert.equal(calls.audits[0].action, 'lifecycle.purged');
  });

  it('does NOT delete when the purging claim is lost (e.g. a concurrent restore won) — no data loss, no audit', async () => {
    Organization.find = () => leanQuery([{ _id: 'org1' }]);
    Workspace.find = () => leanQuery([{ _id: 'cws1' }]);
    Organization.findOneAndUpdate = async () => null; // claim fails: org no longer 'suspended'
    const r = await deletion.runDuePurges(new Date('2026-07-06'));
    assert.equal(r.purged, 0);
    // critical: because the claim is BEFORE the delete, a restored org's data is untouched
    assert.equal(deletes.length, 0);
    assert.equal(calls.audits.length, 0);
  });
});
