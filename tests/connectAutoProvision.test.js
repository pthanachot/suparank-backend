/**
 * Phase 17 Part C — auto-provisioning on a self-serve client checkout
 * (checkout.session.completed with NO workspaceId). Ships DARK behind saasMode.
 *
 * Guarantees under test:
 *   - flag dark ⇒ pre-P17 behavior (log + skip; nothing provisioned),
 *   - flag live ⇒ Workspace + ClientSubscription + client invite created,
 *   - idempotent: an already-bound sub is a no-op (just reconcile); a workspace
 *     already tagged with the sub id is reused (no duplicate) on retry,
 *   - {userId,name} collisions suffix the name rather than crashing,
 *   - a missing/ownerless org is skipped (no throw),
 *   - a failed client invite NEVER fails the webhook (paid sub must not strand).
 *
 * Models/services monkey-patched; stripe.subscriptions.retrieve patched at
 * runtime on the shared stripeService instance. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const connectWebhook = require('../src/controllers/connectWebhookController');
const stripeService = require('../src/services/stripeService');
const flagService = require('../src/services/flagService');
const inviteService = require('../src/services/inviteService');
const ClientSubscription = require('../src/models/ClientSubscription');
const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const auditService = require('../src/services/auditService');

const real = {
  retrieve: stripeService.stripe.subscriptions.retrieve,
  isFlagLive: flagService.isFlagLive,
  createInvite: inviteService.createInvite,
  csFindOne: ClientSubscription.findOne,
  csFOU: ClientSubscription.findOneAndUpdate,
  csExists: ClientSubscription.exists,
  orgFBI: Organization.findById,
  wsFindOne: Workspace.findOne,
  wsFindById: Workspace.findById,
  wsNext: Workspace.getNextNumber,
  wsCreate: Workspace.create,
  wsFBIU: Workspace.findByIdAndUpdate,
  audit: auditService.record,
};
after(() => {
  stripeService.stripe.subscriptions.retrieve = real.retrieve;
  flagService.isFlagLive = real.isFlagLive;
  inviteService.createInvite = real.createInvite;
  ClientSubscription.findOne = real.csFindOne;
  ClientSubscription.findOneAndUpdate = real.csFOU;
  ClientSubscription.exists = real.csExists;
  Organization.findById = real.orgFBI;
  Workspace.findOne = real.wsFindOne;
  Workspace.findById = real.wsFindById;
  Workspace.getNextNumber = real.wsNext;
  Workspace.create = real.wsCreate;
  Workspace.findByIdAndUpdate = real.wsFBIU;
  auditService.record = real.audit;
});

let flagLive, orgDoc, fastBound, wsByProvId, createThrowQueue, inviteThrows, retrievedSub;
let wsCreates, csBinds, inviteCalls, auditCalls, reconcileCalls;

const dupName = () => Object.assign(new Error('E11000 dup key'), { code: 11000, keyPattern: { name: 1 } });

const provSession = (over = {}) => ({
  mode: 'subscription',
  subscription: 'sub_new',
  customer: 'cus_1',
  customer_email: 'client@acme.io',
  customer_details: { name: 'Acme Co', email: 'client@acme.io' },
  metadata: { organizationId: 'org1', agencyPlanId: 'plan1' }, // NO workspaceId
  ...over,
});

beforeEach(() => {
  flagLive = true;
  orgDoc = { _id: 'org1', ownerId: 'owner1', name: 'Acme Agency' };
  fastBound = null;
  wsByProvId = null;
  createThrowQueue = [];
  inviteThrows = false;
  retrievedSub = { status: 'active', current_period_end: 1893456000, customer: 'cus_1', cancel_at_period_end: false };
  wsCreates = []; csBinds = []; inviteCalls = []; auditCalls = []; reconcileCalls = [];

  stripeService.stripe.subscriptions.retrieve = async () => retrievedSub;
  flagService.isFlagLive = async () => flagLive;
  inviteService.createInvite = async (args) => { inviteCalls.push(args); if (inviteThrows) throw new Error('smtp down'); };
  ClientSubscription.findOne = () => ({ select: () => ({ lean: async () => fastBound }) });
  ClientSubscription.findOneAndUpdate = async (filter, update) => { csBinds.push({ filter, set: update.$set }); return {}; };
  ClientSubscription.exists = async () => true; // reconcile: workspace has access → unlock
  Organization.findById = () => ({ select: () => ({ lean: async () => orgDoc }) });
  Workspace.findOne = () => ({ lean: async () => wsByProvId });
  // reconcileWorkspaceLock's lifecycle guard reads workspace → org (active default)
  Workspace.findById = (id) => ({ select: () => ({ lean: async () => ({ _id: id, organizationId: 'org1' }) }) });
  Workspace.getNextNumber = async () => 100001;
  Workspace.create = async (doc) => { wsCreates.push(doc); const e = createThrowQueue.shift(); if (e) throw e; return { _id: 'ws_new', ...doc }; };
  Workspace.findByIdAndUpdate = async (id) => { reconcileCalls.push(id); return {}; };
  auditService.record = (a) => auditCalls.push(a);
});

describe('auto-provision — saasMode dark', () => {
  it('does NOT provision anything (pre-P17 behavior)', async () => {
    flagLive = false;
    await connectWebhook.onCheckoutCompleted(provSession(), 'acct_1');
    assert.equal(wsCreates.length, 0);
    assert.equal(csBinds.length, 0);
    assert.equal(inviteCalls.length, 0);
  });
});

describe('auto-provision — saasMode live', () => {
  it('creates Workspace + ClientSubscription + client invite', async () => {
    await connectWebhook.onCheckoutCompleted(provSession(), 'acct_1');

    assert.equal(wsCreates.length, 1);
    assert.equal(wsCreates[0].userId, 'owner1', 'owned by the agency owner');
    assert.equal(wsCreates[0].organizationId, 'org1');
    assert.equal(wsCreates[0].name, 'Acme Co', 'named from client details');
    assert.equal(wsCreates[0].clientProvisionedSubId, 'sub_new', 'tagged for idempotency');

    assert.equal(csBinds.length, 1);
    assert.equal(csBinds[0].set.workspaceId, 'ws_new');
    assert.equal(csBinds[0].set.status, 'active');
    assert.equal(csBinds[0].set.organizationId, 'org1');

    assert.equal(inviteCalls.length, 1);
    assert.equal(inviteCalls[0].role, 'client');
    assert.equal(inviteCalls[0].accessScope, 'assigned');
    assert.deepEqual(inviteCalls[0].workspaceIds, ['ws_new']);
    assert.equal(inviteCalls[0].email, 'client@acme.io');
    assert.equal(inviteCalls[0].invitedBy, 'owner1');

    assert.ok(auditCalls.some((a) => a.action === 'billing.client_workspace_provisioned'));
  });

  it('is a no-op when the subscription is already bound (idempotent retry)', async () => {
    fastBound = { workspaceId: 'ws_existing' };
    await connectWebhook.onCheckoutCompleted(provSession(), 'acct_1');
    assert.equal(wsCreates.length, 0, 'no duplicate workspace');
    assert.equal(csBinds.length, 0);
    assert.equal(inviteCalls.length, 0);
    assert.deepEqual(reconcileCalls, ['ws_existing'], 'still reconciles the lock');
  });

  it('reuses a workspace already tagged with the sub id (retry before bind)', async () => {
    wsByProvId = { _id: 'ws_prov' };
    await connectWebhook.onCheckoutCompleted(provSession(), 'acct_1');
    assert.equal(wsCreates.length, 0, 'reused, not recreated');
    assert.equal(csBinds[0].set.workspaceId, 'ws_prov');
  });

  it('suffixes the name on a {userId,name} collision instead of crashing', async () => {
    createThrowQueue = [dupName()]; // first create clashes, second succeeds
    await connectWebhook.onCheckoutCompleted(provSession(), 'acct_1');
    assert.equal(wsCreates.length, 2);
    assert.equal(wsCreates[0].name, 'Acme Co');
    assert.equal(wsCreates[1].name, 'Acme Co (2)');
  });

  it('skips (no throw) when the agency org is missing/ownerless', async () => {
    orgDoc = null;
    await assert.doesNotReject(connectWebhook.onCheckoutCompleted(provSession(), 'acct_1'));
    assert.equal(wsCreates.length, 0);
    assert.equal(csBinds.length, 0);
  });

  it('never fails the webhook when the client invite email throws', async () => {
    inviteThrows = true;
    await assert.doesNotReject(connectWebhook.onCheckoutCompleted(provSession(), 'acct_1'));
    assert.equal(csBinds.length, 1, 'subscription still bound');
    assert.ok(auditCalls.some((a) => a.action === 'billing.client_workspace_provisioned'));
  });

  it('falls back to the email local-part when no client name is present', async () => {
    await connectWebhook.onCheckoutCompleted(
      provSession({ customer_details: { email: 'jane@plumbing.io' }, customer_email: 'jane@plumbing.io' }),
      'acct_1'
    );
    assert.equal(wsCreates[0].name, 'jane');
  });
});
