/**
 * Connected-account webhook — Phase 16 MONEY CORE.
 *
 * A SEPARATE endpoint from the platform webhook (/api/billing/webhooks). It
 * receives events for agencies' Stripe Connect accounts (Connect Standard),
 * verified with its OWN secret (STRIPE_CONNECT_WEBHOOK_SECRET). Connect events
 * carry `event.account` = the connected account id.
 *
 * Guarantees:
 *  - signature verified (constructEvent) — 400 on failure.
 *  - idempotent via ProcessedWebhookEvent, MARK-AFTER-SUCCESS: an event is
 *    recorded only once its handler completes; a handler throw returns 500
 *    (unrecorded) so Stripe retries. Every handler is independently idempotent
 *    (reconcile-from-state, upsert-by-id), so a concurrent duplicate that
 *    reprocesses is harmless — this avoids the "event permanently lost" hole of
 *    mark-first + delete-on-throw.
 *  - ORDER-RESILIENT LOCKING: workspace access is never toggled by a single
 *    event. After any change we RECONCILE the workspace's `clientLocked` from
 *    the CURRENT state of ALL its client subscriptions, so a stale/redelivered
 *    or out-of-order event can never strand a lock on a workspace that a newer
 *    subscription legitimately owns.
 *  - client subscriptions bind only to workspaces that belong to the paying
 *    agency org (defense-in-depth; checkout enforces it too).
 *
 * NO application fee anywhere — money is 100% the agency's (Connect Standard).
 * This path never touches the platform credit system. This lock is SEPARATE
 * from the tier-downgrade `locked` flag (downgradeService owns that).
 */

const { stripe, CONNECT_WEBHOOK_SECRET, connectedAccountOptions } = require('../services/stripeService');
const ProcessedWebhookEvent = require('../models/ProcessedWebhookEvent');
const ClientSubscription = require('../models/ClientSubscription');
const Organization = require('../models/Organization');
const Workspace = require('../models/Workspace');
const auditService = require('../services/auditService');
const flagService = require('../services/flagService');
const inviteService = require('../services/inviteService');

// A client subscription "grants access" to its workspace in these statuses.
// past_due is included as the grace window while Stripe retries the payment;
// once Stripe exhausts retries the subscription transitions to canceled/unpaid
// (→ mapStatus 'canceled') and access is withdrawn. paused/incomplete/canceled
// do NOT grant access.
const ACCESS_STATUSES = ['active', 'trialing', 'past_due'];

/** Map a Stripe subscription status to our ClientSubscription enum. */
function mapStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'unpaid': // Stripe exhausted retries and left it unpaid — terminal, lock
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

const _subId = (ref) => (typeof ref === 'string' ? ref : ref?.id) || null;
const _custId = (ref) => (typeof ref === 'string' ? ref : ref?.id) || null;

/**
 * Recompute a workspace's client-billing lock from the CURRENT state of all of
 * its client subscriptions. Idempotent and order-independent — this is what
 * makes redelivered / out-of-order Stripe events safe. A workspace is unlocked
 * iff it has at least one access-granting subscription.
 */
async function reconcileWorkspaceLock(workspaceId) {
  if (!workspaceId) return;
  let hasAccess = await ClientSubscription.exists({
    workspaceId,
    status: { $in: ACCESS_STATUSES },
  });
  if (hasAccess) {
    // Never unlock a workspace whose org is torn down / being purged. A client
    // sub that suspend() failed to cancel (transient Stripe error) still fires
    // payment webhooks — without this guard, invoice.payment_succeeded would
    // unlock a suspended org's workspace and defeat the lifecycle lock.
    // ('restoring' is deliberately not frozen: the org is on its way to active.)
    const ws = await Workspace.findById(workspaceId).select('organizationId').lean();
    const org = ws?.organizationId
      ? await Organization.findById(ws.organizationId).select('lifecycleStatus').lean()
      : null;
    if (['suspended', 'suspending', 'purging'].includes(org?.lifecycleStatus)) hasAccess = false;
  }
  await Workspace.findByIdAndUpdate(
    workspaceId,
    hasAccess
      ? { clientLocked: false, clientLockedAt: null }
      : { clientLocked: true, clientLockedAt: new Date() }
  );
}

/** True iff `workspaceId` exists AND belongs to `organizationId`. */
async function _workspaceBelongsToOrg(workspaceId, organizationId) {
  if (!workspaceId || !organizationId) return false;
  const ws = await Workspace.findOne({ _id: workspaceId, organizationId }).select('_id').lean();
  return Boolean(ws);
}

// ─── Event handlers (each idempotent; each reconciles the lock) ────

async function onCheckoutCompleted(session, account) {
  if (session.mode !== 'subscription') return;
  const md = session.metadata || {};
  const stripeSubscriptionId = _subId(session.subscription);
  const workspaceId = md.workspaceId || null;
  const organizationId = md.organizationId || null;
  if (!stripeSubscriptionId) return;

  if (!workspaceId) {
    // Phase 17: a self-serve client checkout with no pre-existing workspace →
    // auto-provision one. GATED — with saasMode dark, keep the pre-P17 behavior
    // (log + skip; nothing is ever provisioned on the live path).
    if (!(await flagService.isFlagLive('saasMode'))) {
      console.error(`[connect-webhook] checkout completed with no workspaceId — sub=${stripeSubscriptionId} (saasMode dark; needs manual reconciliation)`);
      return;
    }
    return _autoProvisionClientWorkspace(session, account, stripeSubscriptionId, organizationId, md);
  }

  // Defense-in-depth: never bind a subscription (or unlock) a workspace that
  // doesn't belong to the paying org. Checkout validates this too; this guards
  // against any tampered/misrouted metadata.
  if (!(await _workspaceBelongsToOrg(workspaceId, organizationId))) {
    console.error(`[connect-webhook] checkout workspace ${workspaceId} does not belong to org ${organizationId} — refusing to bind (sub=${stripeSubscriptionId})`);
    return;
  }

  const status = await _bindClientSubscription(session, account, workspaceId, stripeSubscriptionId, organizationId, md);
  auditService.record({
    organizationId,
    actorEmail: 'stripe',
    action: 'billing.client_subscription_created',
    resourceId: stripeSubscriptionId,
    meta: { workspaceId, agencyPlanId: md.agencyPlanId, status },
  });
}

/**
 * Upsert (idempotent, keyed by stripeSubscriptionId) the ClientSubscription for
 * `workspaceId`, with authoritative status/period pulled from the connected
 * account, then reconcile the workspace lock. Returns the mapped status.
 * On a failed retrieve THROWS → 500 → Stripe retries (don't silently store an
 * 'incomplete' sub that would strand the paid client's workspace locked).
 */
async function _bindClientSubscription(session, account, workspaceId, stripeSubscriptionId, organizationId, md) {
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, connectedAccountOptions(account));
  const status = mapStatus(sub?.status || 'incomplete');
  const currentPeriodEnd = sub?.current_period_end ? new Date(sub.current_period_end * 1000) : null;

  await ClientSubscription.findOneAndUpdate(
    { stripeSubscriptionId },
    {
      $set: {
        organizationId,
        workspaceId,
        agencyPlanId: md.agencyPlanId || null,
        stripeCustomerId: _custId(session.customer) || _custId(sub?.customer),
        connectedAccountId: account,
        clientEmail: session.customer_email || session.customer_details?.email || null,
        status,
        currentPeriodEnd,
        cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await reconcileWorkspaceLock(workspaceId);
  return status;
}

// ─── Phase 17 auto-provisioning (self-serve client checkout, ships DARK) ──

/** Derive a friendly workspace name from the checkout's client details. */
function _provisionWorkspaceName(session) {
  const name = session.customer_details?.name?.trim();
  if (name) return name.slice(0, 50);
  const email = session.customer_email || session.customer_details?.email || '';
  const local = email.split('@')[0];
  return (local || 'Client workspace').slice(0, 50);
}

/**
 * Create (or idempotently reuse) the workspace for a self-serve client checkout.
 * Tagged with clientProvisionedSubId (sparse-unique) so a redelivery / concurrent
 * delivery reuses the same workspace rather than leaking a duplicate. Handles the
 * {userId,name} unique index by suffixing the name, and workspaceNumber races by
 * retrying with a fresh number.
 */
async function _provisionWorkspace(org, baseName, stripeSubscriptionId) {
  const existing = await Workspace.findOne({ clientProvisionedSubId: stripeSubscriptionId }).lean();
  if (existing) return existing;

  let suffix = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const name = (suffix === 0 ? baseName : `${baseName} (${suffix + 1})`).slice(0, 50);
    try {
      const workspaceNumber = await Workspace.getNextNumber();
      return await Workspace.create({
        workspaceNumber,
        name,
        userId: org.ownerId,
        organizationId: org._id,
        color: '#6366F1',
        clientProvisionedSubId: stripeSubscriptionId,
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      // A concurrent delivery may have just provisioned it — reuse the winner.
      const raced = await Workspace.findOne({ clientProvisionedSubId: stripeSubscriptionId }).lean();
      if (raced) return raced;
      // Otherwise a {userId,name} or workspaceNumber collision. ALWAYS advance the
      // name to guarantee forward progress — we don't depend on err.keyPattern
      // being populated (some driver/wrapper error shapes omit it, which would
      // otherwise spin 12× on the same name → throw → 500 → Stripe retry storm →
      // stranded paid client). A workspaceNumber race just gets a fresh number
      // next iteration anyway, so an extra suffix in that rare case is harmless.
      suffix++;
    }
  }
  throw new Error(`auto-provision: exhausted workspace creation retries for sub ${stripeSubscriptionId}`);
}

/**
 * Provision a Workspace + ClientSubscription + client invite for a self-serve
 * checkout that carried no workspaceId. Idempotent: the workspace is keyed by
 * clientProvisionedSubId and the subscription by stripeSubscriptionId, so
 * retries and concurrent deliveries converge on one workspace + one sub. The
 * client invite is best-effort — a failed email must never fail the webhook
 * (which would strand the paid subscription behind endless Stripe retries).
 * NOTE: intentionally does NOT enforce the agency's maxWorkspaces tier limit —
 * the client already paid; blocking here would strand a paid subscription.
 */
async function _autoProvisionClientWorkspace(session, account, stripeSubscriptionId, organizationId, md) {
  // Fast idempotency path: already fully provisioned on a prior delivery.
  const bound = await ClientSubscription.findOne({ stripeSubscriptionId }).select('workspaceId').lean();
  if (bound?.workspaceId) {
    await reconcileWorkspaceLock(bound.workspaceId);
    return;
  }

  const org = await Organization.findById(organizationId).select('_id ownerId name lifecycleStatus').lean();
  if (!org?.ownerId) {
    console.error(`[connect-webhook] auto-provision: org ${organizationId} missing or ownerless — sub=${stripeSubscriptionId} (needs manual reconciliation)`);
    return;
  }
  // Phase 18 (DARK): never provision a new client into a SUSPENDED agency (its
  // tenant surface is torn down). An in-flight checkout during winding_down is
  // still honored — the client already paid and grace access is live. Inert
  // unless saasMode is live (lifecycleStatus is always 'active' when dark).
  if (['suspended', 'suspending', 'purging'].includes(org.lifecycleStatus)) {
    console.error(`[connect-webhook] auto-provision: org ${organizationId} is ${org.lifecycleStatus} — sub=${stripeSubscriptionId} NOT provisioned (needs manual refund/reconciliation)`);
    return;
  }

  const workspace = await _provisionWorkspace(org, _provisionWorkspaceName(session), stripeSubscriptionId);
  const status = await _bindClientSubscription(session, account, workspace._id, stripeSubscriptionId, organizationId, md);

  const clientEmail = session.customer_email || session.customer_details?.email || null;
  if (clientEmail) {
    try {
      await inviteService.createInvite({
        org,
        email: clientEmail,
        role: 'client',
        accessScope: 'assigned',
        workspaceIds: [workspace._id],
        invitedBy: org.ownerId,
        inviterName: org.name,
      });
    } catch (err) {
      console.error(`[connect-webhook] auto-provision: client invite failed for ${clientEmail} — ${err.message}`);
    }
  }

  auditService.record({
    organizationId,
    actorEmail: 'stripe',
    action: 'billing.client_workspace_provisioned',
    resourceId: stripeSubscriptionId,
    meta: { workspaceId: workspace._id, clientEmail, status },
  });
}

async function onSubscriptionUpdated(sub) {
  const cs = await ClientSubscription.findOne({ stripeSubscriptionId: sub.id });
  if (!cs) return; // not ours yet — checkout.session.completed will create it
  // subscription.updated is the AUTHORITATIVE source of status.
  cs.status = mapStatus(sub.status);
  if (sub.current_period_end) cs.currentPeriodEnd = new Date(sub.current_period_end * 1000);
  cs.cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
  if (cs.status === 'canceled' && !cs.canceledAt) cs.canceledAt = new Date();
  await cs.save();
  await reconcileWorkspaceLock(cs.workspaceId);
}

async function onSubscriptionDeleted(sub) {
  const cs = await ClientSubscription.findOne({ stripeSubscriptionId: sub.id });
  if (!cs) return;
  cs.status = 'canceled';
  if (!cs.canceledAt) cs.canceledAt = new Date();
  await cs.save();
  await reconcileWorkspaceLock(cs.workspaceId);

  auditService.record({
    organizationId: cs.organizationId,
    actorEmail: 'stripe',
    action: 'billing.client_subscription_canceled',
    resourceId: sub.id,
    meta: { workspaceId: cs.workspaceId },
  });
}

// Invoice events do NOT mutate `status` (customer.subscription.updated is the
// status authority — this is what makes a stale/redelivered invoice event
// harmless). They only reconcile the lock and audit. This prevents a
// reordered old payment_succeeded from resurrecting a canceled subscription.
async function onPaymentFailed(invoice) {
  const subId = _subId(invoice.subscription);
  if (!subId) return;
  const cs = await ClientSubscription.findOne({ stripeSubscriptionId: subId }).select('workspaceId organizationId').lean();
  if (!cs) return;
  await reconcileWorkspaceLock(cs.workspaceId);
  if (!invoice.next_payment_attempt) {
    // Stripe has exhausted retries; the subscription will transition to
    // canceled/unpaid via subscription.updated, which locks. Audit the event.
    auditService.record({
      organizationId: cs.organizationId,
      actorEmail: 'stripe',
      action: 'billing.client_payment_failed',
      resourceId: subId,
      meta: { workspaceId: cs.workspaceId, retriesExhausted: true },
    });
  }
}

async function onPaymentSucceeded(invoice) {
  if ((invoice.amount_paid || 0) <= 0) return; // skip $0 / trial invoices
  const subId = _subId(invoice.subscription);
  if (!subId) return;
  const cs = await ClientSubscription.findOne({ stripeSubscriptionId: subId }).select('workspaceId').lean();
  if (!cs) return;
  await reconcileWorkspaceLock(cs.workspaceId);
}

async function onAccountUpdated(account) {
  const org = await Organization.findOne({ stripeConnectAccountId: account.id });
  if (!org) return;
  org.connectChargesEnabled = Boolean(account.charges_enabled);
  org.connectPayoutsEnabled = Boolean(account.payouts_enabled);
  org.connectDetailsSubmitted = Boolean(account.details_submitted);
  if (account.charges_enabled && !org.connectOnboardedAt) {
    org.connectOnboardedAt = new Date();
  }
  await org.save();
}

// ─── Entry point ──────────────────────────────────────────────────

async function _dispatch(event, account) {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event.data.object, account);
    case 'customer.subscription.updated':
      return onSubscriptionUpdated(event.data.object);
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object);
    case 'invoice.payment_failed':
      return onPaymentFailed(event.data.object);
    case 'invoice.payment_succeeded':
      return onPaymentSucceeded(event.data.object);
    case 'account.updated':
      return onAccountUpdated(event.data.object);
    default:
      console.log(`[connect-webhook] unhandled event type: ${event.type}`);
  }
}

async function handleConnectWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      CONNECT_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[connect-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const account = event.account || null;

  // Dedup fast-path: skip an event already fully processed. (Handlers are
  // idempotent, so a concurrent duplicate that slips past this reprocesses
  // harmlessly.)
  const seen = await ProcessedWebhookEvent.findOne({ eventId: event.id }).select('_id').lean();
  if (seen) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    await _dispatch(event, account);
  } catch (err) {
    console.error(`[connect-webhook] handler error for ${event.type}:`, err.message);
    // NOT recorded as processed → Stripe retries and reprocesses idempotently.
    return res.status(500).json({ error: 'processing error' });
  }

  // Record only AFTER a clean handle. markProcessed swallows a concurrent
  // duplicate's 11000, so this is safe under a rare same-id race.
  try {
    await ProcessedWebhookEvent.markProcessed(event.id, event.type, account);
  } catch (err) {
    console.error('[connect-webhook] failed to record processed event:', err.message);
  }
  return res.json({ received: true });
}

module.exports = {
  handleConnectWebhook,
  onCheckoutCompleted,
  onSubscriptionUpdated,
  onSubscriptionDeleted,
  onPaymentFailed,
  onPaymentSucceeded,
  onAccountUpdated,
  reconcileWorkspaceLock,
  mapStatus,
};
