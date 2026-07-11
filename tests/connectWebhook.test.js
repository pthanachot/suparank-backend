/**
 * Tests for the connected-account webhook — Phase 16 money core (post-review).
 *
 * Validates the hardened behavior:
 *   - signature failure → 400,
 *   - idempotency is MARK-AFTER-SUCCESS: a duplicate (already-recorded) event is
 *     skipped; a handler throw is NOT recorded (so Stripe retries),
 *   - workspace access is RECONCILED from all of a workspace's subscriptions
 *     (order-resilient): a stale cancel for an old sub does not lock a workspace
 *     a newer active sub owns; a reordered payment event can't resurrect access,
 *   - past_due keeps access (grace); canceled/paused withdraw it,
 *   - checkout binds only to a workspace that belongs to the paying org,
 *   - a failed subscription retrieve THROWS (→ retry), never strands a lock,
 *   - account.updated syncs the Organization connect flags.
 *
 * Stripe faked via require-cache; models/services monkey-patched. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const stripeState = { event: null, retrievedSub: null, retrieveThrows: false };
class FakeStripe {
  constructor() {
    this.webhooks = {
      constructEvent: () => {
        if (stripeState.event === 'BAD_SIG') throw new Error('bad signature');
        return stripeState.event;
      },
    };
    this.subscriptions = {
      retrieve: async () => {
        if (stripeState.retrieveThrows) throw new Error('stripe retrieve failed');
        return stripeState.retrievedSub;
      },
    };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const connectWebhook = require('../src/controllers/connectWebhookController');
const ProcessedWebhookEvent = require('../src/models/ProcessedWebhookEvent');
const ClientSubscription = require('../src/models/ClientSubscription');
const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const auditService = require('../src/services/auditService');

const real = {
  pweFindOne: ProcessedWebhookEvent.findOne,
  pweMark: ProcessedWebhookEvent.markProcessed,
  csFindOneAndUpdate: ClientSubscription.findOneAndUpdate,
  csFindOne: ClientSubscription.findOne,
  csExists: ClientSubscription.exists,
  wsFindOne: Workspace.findOne,
  wsUpdate: Workspace.findByIdAndUpdate,
  wsFindById: Workspace.findById,
  orgFindOne: Organization.findOne,
  orgFindById: Organization.findById,
  audit: auditService.record,
};
after(() => {
  ProcessedWebhookEvent.findOne = real.pweFindOne;
  ProcessedWebhookEvent.markProcessed = real.pweMark;
  ClientSubscription.findOneAndUpdate = real.csFindOneAndUpdate;
  ClientSubscription.findOne = real.csFindOne;
  ClientSubscription.exists = real.csExists;
  Workspace.findOne = real.wsFindOne;
  Workspace.findByIdAndUpdate = real.wsUpdate;
  Workspace.findById = real.wsFindById;
  Organization.findOne = real.orgFindOne;
  Organization.findById = real.orgFindById;
  auditService.record = real.audit;
});

const ACCESS = ['active', 'trialing', 'past_due'];

let processed; // Set of marked event ids
let csStore; // Map subId -> { stripeSubscriptionId, workspaceId, organizationId, status }
let ownedWs; // Map workspaceId -> organizationId (ownership)
let wsLocks; // Map workspaceId -> boolean (latest clientLocked)
let orgSaved;
let auditCalls;
let orgLifecycle; // lifecycleStatus returned by the reconcile lock's org lookup

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const req = () => ({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') });

beforeEach(() => {
  processed = new Set();
  csStore = new Map();
  ownedWs = new Map();
  wsLocks = {};
  orgSaved = [];
  auditCalls = [];
  orgLifecycle = 'active';
  stripeState.retrieveThrows = false;
  stripeState.retrievedSub = { status: 'active', current_period_end: 1893456000, customer: 'cus_1', cancel_at_period_end: false };

  ProcessedWebhookEvent.findOne = () => ({ select: () => ({ lean: async () => (processed.has(_pendingId) ? { _id: 'x' } : null) }) });
  ProcessedWebhookEvent.markProcessed = async (eventId) => { processed.add(eventId); return { firstTime: true }; };

  ClientSubscription.findOneAndUpdate = async (filter, update) => {
    const id = filter.stripeSubscriptionId;
    const doc = { stripeSubscriptionId: id, ...update.$set };
    csStore.set(id, doc);
    return doc;
  };
  ClientSubscription.findOne = (filter) => {
    const doc = csStore.get(filter.stripeSubscriptionId);
    const chain = {
      select: () => ({ lean: async () => (doc ? { workspaceId: doc.workspaceId, organizationId: doc.organizationId } : null) }),
    };
    // Some handlers call findOne(...).save via a live doc, others .select().lean()
    if (doc) { doc.save = async () => {}; }
    return Object.assign(Promise.resolve(doc || null), chain);
  };
  ClientSubscription.exists = async (filter) => {
    for (const doc of csStore.values()) {
      if (String(doc.workspaceId) === String(filter.workspaceId) && filter.status.$in.includes(doc.status)) {
        return { _id: 'exists' };
      }
    }
    return null;
  };

  Workspace.findOne = (filter) => ({
    select: () => ({
      lean: async () => (String(ownedWs.get(String(filter._id))) === String(filter.organizationId) ? { _id: filter._id } : null),
    }),
  });
  Workspace.findByIdAndUpdate = async (id, update) => { wsLocks[String(id)] = update.clientLocked === true; return {}; };
  // reconcileWorkspaceLock's lifecycle guard: workspace → org (active by default)
  Workspace.findById = (id) => ({ select: () => ({ lean: async () => ({ _id: id, organizationId: ownedWs.get(String(id)) || 'org_1' }) }) });
  Organization.findById = () => ({ select: () => ({ lean: async () => ({ lifecycleStatus: orgLifecycle }) }) });

  Organization.findOne = async () => ({ connectChargesEnabled: false, connectOnboardedAt: null, save: async function () { orgSaved.push({ ...this }); } });
  auditService.record = (e) => auditCalls.push(e);
});

// The seen-check reads the CURRENT event id; expose it to the findOne stub.
let _pendingId = null;
async function deliver(event) {
  _pendingId = event && event.id;
  stripeState.event = event;
  const r = res();
  await connectWebhook.handleConnectWebhook(req(), r);
  return r;
}

function seedSub(subId, workspaceId, organizationId, status) {
  csStore.set(subId, { stripeSubscriptionId: subId, workspaceId, organizationId, status });
}

// ── signature + idempotency ────────────────────────────────────

describe('connect webhook — signature + idempotency (mark-after-success)', () => {
  it('bad signature → 400', async () => {
    const r = await deliver('BAD_SIG');
    assert.equal(r.statusCode, 400);
  });

  it('records the event only after a clean handle, and skips a redelivery', async () => {
    ownedWs.set('ws-1', 'org-1');
    const ev = { id: 'evt_1', type: 'checkout.session.completed', account: 'acct_1', data: { object: { mode: 'subscription', subscription: 'sub_1', metadata: { organizationId: 'org-1', agencyPlanId: 'plan-1', workspaceId: 'ws-1' } } } };
    const r1 = await deliver(ev);
    assert.equal(r1.body.received, true);
    assert.ok(processed.has('evt_1'), 'marked processed after success');
    const r2 = await deliver(ev);
    assert.equal(r2.body.duplicate, true, 'redelivery skipped');
  });

  it('a handler throw is NOT recorded (Stripe will retry)', async () => {
    ownedWs.set('ws-1', 'org-1');
    stripeState.retrieveThrows = true; // onCheckoutCompleted throws on retrieve
    const r = await deliver({ id: 'evt_boom', type: 'checkout.session.completed', account: 'acct_1', data: { object: { mode: 'subscription', subscription: 'sub_x', metadata: { organizationId: 'org-1', workspaceId: 'ws-1' } } } });
    assert.equal(r.statusCode, 500);
    assert.equal(processed.has('evt_boom'), false, 'not marked → retryable');
  });
});

// ── checkout binding + ownership ───────────────────────────────

describe('connect webhook — checkout binding', () => {
  it('binds the sub and unlocks the workspace when it belongs to the org', async () => {
    ownedWs.set('ws-9', 'org-1');
    await deliver({ id: 'evt_co', type: 'checkout.session.completed', account: 'acct_1', data: { object: { mode: 'subscription', subscription: 'sub_9', customer: 'cus_9', customer_email: 'c@x.io', metadata: { organizationId: 'org-1', agencyPlanId: 'plan-1', workspaceId: 'ws-9' } } } });
    assert.equal(csStore.get('sub_9').status, 'active');
    assert.equal(wsLocks['ws-9'], false, 'unlocked');
  });

  it('REFUSES to bind a workspace that does not belong to the paying org (cross-tenant guard)', async () => {
    ownedWs.set('ws-foreign', 'org-OTHER'); // belongs to a different org
    await deliver({ id: 'evt_ct', type: 'checkout.session.completed', account: 'acct_1', data: { object: { mode: 'subscription', subscription: 'sub_ct', metadata: { organizationId: 'org-1', workspaceId: 'ws-foreign' } } } });
    assert.equal(csStore.has('sub_ct'), false, 'no subscription bound');
    assert.equal(wsLocks['ws-foreign'], undefined, 'foreign workspace never touched');
  });

  it('throws (→500) when the subscription retrieve fails, rather than storing incomplete', async () => {
    ownedWs.set('ws-1', 'org-1');
    stripeState.retrieveThrows = true;
    const r = await deliver({ id: 'evt_rf', type: 'checkout.session.completed', account: 'acct_1', data: { object: { mode: 'subscription', subscription: 'sub_rf', metadata: { organizationId: 'org-1', workspaceId: 'ws-1' } } } });
    assert.equal(r.statusCode, 500);
    assert.equal(csStore.has('sub_rf'), false);
  });
});

// ── reconcile-based lock (order resilience) ────────────────────

describe('connect webhook — reconcile lock', () => {
  it('past_due keeps access (grace); canceled withdraws it', async () => {
    seedSub('sub_pd', 'ws-pd', 'org-1', 'active');
    await deliver({ id: 'e_pd', type: 'customer.subscription.updated', account: 'acct_1', data: { object: { id: 'sub_pd', status: 'past_due' } } });
    assert.equal(wsLocks['ws-pd'], false, 'past_due = grace, still unlocked');

    await deliver({ id: 'e_c', type: 'customer.subscription.updated', account: 'acct_1', data: { object: { id: 'sub_pd', status: 'canceled' } } });
    assert.equal(wsLocks['ws-pd'], true, 'canceled → locked');
  });

  it('maps Stripe unpaid/paused to a locked state', async () => {
    seedSub('sub_up', 'ws-up', 'org-1', 'active');
    await deliver({ id: 'e_up', type: 'customer.subscription.updated', account: 'acct_1', data: { object: { id: 'sub_up', status: 'unpaid' } } });
    assert.equal(wsLocks['ws-up'], true);
    assert.equal(csStore.get('sub_up').status, 'canceled'); // unpaid → canceled

    seedSub('sub_ps', 'ws-ps', 'org-1', 'active');
    await deliver({ id: 'e_ps', type: 'customer.subscription.updated', account: 'acct_1', data: { object: { id: 'sub_ps', status: 'paused' } } });
    assert.equal(wsLocks['ws-ps'], true);
  });

  it('a stale cancel for an OLD sub does NOT lock a workspace a newer active sub owns', async () => {
    // Workspace W owned by two subs: old A (about to cancel) + new B (active).
    seedSub('sub_A', 'ws-W', 'org-1', 'canceled');
    seedSub('sub_B', 'ws-W', 'org-1', 'active');
    await deliver({ id: 'e_stale', type: 'customer.subscription.deleted', account: 'acct_1', data: { object: { id: 'sub_A', status: 'canceled' } } });
    assert.equal(wsLocks['ws-W'], false, 'new active sub keeps the workspace unlocked');
  });

  it('a reordered/old payment_succeeded does NOT resurrect access for a canceled sub', async () => {
    seedSub('sub_dead', 'ws-dead', 'org-1', 'canceled');
    await deliver({ id: 'e_ps_old', type: 'invoice.payment_succeeded', account: 'acct_1', data: { object: { subscription: 'sub_dead', amount_paid: 4900 } } });
    // invoice handler reconciles only (no status mutation) → sub stays canceled → locked.
    assert.equal(csStore.get('sub_dead').status, 'canceled');
    assert.equal(wsLocks['ws-dead'], true);
  });

  it('subscription.deleted cancels + locks (no other sub)', async () => {
    seedSub('sub_d', 'ws-d', 'org-1', 'active');
    await deliver({ id: 'e_del', type: 'customer.subscription.deleted', account: 'acct_1', data: { object: { id: 'sub_d', status: 'canceled' } } });
    assert.equal(csStore.get('sub_d').status, 'canceled');
    assert.equal(wsLocks['ws-d'], true);
  });
});

// ── account.updated ────────────────────────────────────────────

describe('connect webhook — account.updated', () => {
  it('syncs the Organization connect flags', async () => {
    await deliver({ id: 'e_acct', type: 'account.updated', account: 'acct_1', data: { object: { id: 'acct_1', charges_enabled: true, payouts_enabled: true, details_submitted: true } } });
    assert.equal(orgSaved.length, 1);
    assert.equal(orgSaved[0].connectChargesEnabled, true);
    assert.ok(orgSaved[0].connectOnboardedAt);
  });
});
