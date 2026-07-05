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
  const hasAccess = await ClientSubscription.exists({
    workspaceId,
    status: { $in: ACCESS_STATUSES },
  });
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
  // ClientSubscription.workspaceId is required — a checkout with no workspace
  // (deferred to Phase 17 auto-provisioning) cannot create a sub here.
  if (!workspaceId) {
    console.error(`[connect-webhook] checkout completed with no workspaceId — sub=${stripeSubscriptionId} (agency may have been charged; needs manual reconciliation)`);
    return;
  }
  // Defense-in-depth: never bind a subscription (or unlock) a workspace that
  // doesn't belong to the paying org. Checkout validates this too; this guards
  // against any tampered/misrouted metadata.
  if (!(await _workspaceBelongsToOrg(workspaceId, organizationId))) {
    console.error(`[connect-webhook] checkout workspace ${workspaceId} does not belong to org ${organizationId} — refusing to bind (sub=${stripeSubscriptionId})`);
    return;
  }

  // Pull authoritative status/period from the subscription on the connected
  // account. On failure THROW → 500 → Stripe retries (don't silently store an
  // 'incomplete' sub that would strand the paid client's workspace locked).
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

  auditService.record({
    organizationId,
    actorEmail: 'stripe',
    action: 'billing.client_subscription_created',
    resourceId: stripeSubscriptionId,
    meta: { workspaceId, agencyPlanId: md.agencyPlanId, status },
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
