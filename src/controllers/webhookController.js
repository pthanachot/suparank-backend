const Stripe = require('stripe');
const STRIPE_API_VERSION = require('../config/stripeApiVersion');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const UsageTracker = require('../models/UsageTracker');
const Session = require('../models/Session');
const OrgMember = require('../models/OrgMember');
const Workspace = require('../models/Workspace');
const CreditTransaction = require('../models/CreditTransaction');
const { clearTierCache, getOrgTierConfig, getTierConfig } = require('../services/tierService');
const { applyLocksForOrg } = require('../services/downgradeService');
const lifecycleService = require('../services/lifecycleService');
const creditService = require('../services/creditService');
const trackerScheduleService = require('../services/trackerScheduleService');
const { getPlanFromPriceId, EXTRA_SEAT_PRICE_SET } = require('../config/stripePrices');
const { getPackById } = require('../config/creditPacks');
const { applyCustomTemplate } = require('./emailPortalController');
const { sendEmail } = require('../utils/emailService');
const { getSettings } = require('../services/systemSettingsService');
const auditService = require('../services/auditService');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

// Convert Stripe Unix timestamps (seconds) to Date objects
function parseStripeDate(ts) {
  if (!ts) return undefined;
  const date = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return isNaN(date.getTime()) ? undefined : date;
}

// Human-readable plan name from a planId like "standard-monthly"
function formatPlanName(planId) {
  if (!planId) return 'Your Plan';
  return planId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatEmailDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Send a triggerable-template email to the org owner. Never throws —
// email failure must not break webhook processing. Respects the owner's
// emailNotifications preference and skips if template resolution fails.
async function notifyOrgOwner(organizationId, triggerId, data) {
  try {
    if (getSettings().emailNotificationsEnabled === false) return;
    const org = await Organization.findById(organizationId).lean();
    const owner = org?.ownerId ? await User.findById(org.ownerId).lean() : null;
    if (!owner?.email || owner.preferences?.emailNotifications === false) return;

    const emailOptions = {
      to: owner.email,
      orgId: organizationId, // Phase 11 sender identity
      data: { userName: owner.profile?.name || 'there', ...data },
    };
    await applyCustomTemplate(triggerId, emailOptions, organizationId);
    if (!emailOptions.subject) return;
    await sendEmail(emailOptions);
    console.log(`[email] ${triggerId} email sent to ${owner.email} for org=${organizationId}`);
  } catch (err) {
    console.error(`[email] Failed to send ${triggerId} email for org=${organizationId}:`, err.message);
  }
}

// ─── WEBHOOK HANDLER ──────────────────────────────────────────

const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw body
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error(`Webhook handler error for ${event.type}:`, error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};

// ─── HELPERS ─────────────────────────────────────────────────

/**
 * Resolve organizationId from session/subscription metadata.
 * Handles both new (organizationId in metadata) and legacy (userId only) checkouts.
 */
async function resolveOrgId(metadata) {
  // New flow: organizationId directly in metadata
  if (metadata?.organizationId) {
    return metadata.organizationId;
  }

  // Legacy fallback: find user's personal org
  if (metadata?.userId) {
    const personalOrg = await Organization.findOne({
      ownerId: metadata.userId,
      isPersonal: true,
    }).lean();

    if (personalOrg) {
      console.warn(`Legacy checkout: resolved org from user's personal org. userId=${metadata.userId} orgId=${personalOrg._id}`);
      return personalOrg._id.toString();
    }
  }

  return null;
}

// ─── EVENT HANDLERS ───────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  // One-time credit-pack purchase. Branch EARLY and return — this fulfillment
  // path is entirely separate from the subscription path below and must never
  // fall through into subscription logic (no Subscription upsert, no plan credits).
  if (session.mode === 'payment' && session.metadata?.creditPackId) {
    return fulfillCreditPackPurchase(session);
  }

  if (session.mode !== 'subscription') return;

  const organizationId = await resolveOrgId(session.metadata);
  const userId = session.metadata?.userId;

  if (!organizationId) {
    console.error('Checkout completed but could not resolve organizationId. metadata:', session.metadata);
    return;
  }

  const subscriptionId = session.subscription;
  const customerId = session.customer;

  // Store stripeCustomerId on user (backward compat)
  if (userId) {
    await User.findByIdAndUpdate(userId, { stripeCustomerId: customerId });
  }

  // Fetch full subscription from Stripe
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });

  const subItem = stripeSub.items.data[0];
  const priceId = subItem?.price?.id;
  const planId = getPlanFromPriceId(priceId);

  if (!planId) {
    console.error('Unknown price ID from checkout:', priceId);
    return;
  }

  const paymentMethod = stripeSub.default_payment_method;

  await Subscription.findOneAndUpdate(
    { organizationId },
    {
      organizationId,
      userId: userId || undefined,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      planId,
      status: stripeSub.status,
      currentPeriodStart: parseStripeDate(subItem?.current_period_start || stripeSub.current_period_start),
      currentPeriodEnd: parseStripeDate(subItem?.current_period_end || stripeSub.current_period_end),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      defaultPaymentMethod: paymentMethod?.card
        ? {
            brand: paymentMethod.card.brand,
            last4: paymentMethod.card.last4,
            expMonth: paymentMethod.card.exp_month,
            expYear: paymentMethod.card.exp_year,
          }
        : undefined,
    },
    { upsert: true, new: true }
  );

  clearTierCache();
  // Re-evaluate resource locks for the new tier (unlocks on upgrade)
  applyLocksForOrg(organizationId).catch((err) =>
    console.error(`[downgradeService] checkout lock error for org=${organizationId}:`, err.message)
  );

  // Grant subscription credits for the new plan. Phase 7: use the idempotent
  // monthly grant (rollover 0 for a brand-new subscriber) so the expiry is the
  // monthly rollover window — not the Stripe period end (a year out on annual
  // plans) — and a redelivered checkout event can't re-grant the same month.
  try {
    const { config } = await getOrgTierConfig(organizationId);
    if (config?.creditsPerMonth) {
      const r = await creditService.grantMonthlyCreditsIfDue(organizationId, config.creditsPerMonth);
      console.log(`[credits] Checkout grant org=${organizationId}: ${r.granted ? r.amount : r.reason}`);
    }
  } catch (err) {
    console.error(`[credits] Failed to grant on checkout for org=${organizationId}:`, err.message);
  }

  console.log(`Checkout completed: org=${organizationId} plan=${planId}`);
}

/**
 * Fulfill a one-time credit-pack purchase (Stripe checkout mode:'payment').
 *
 * MONEY CODE — read the idempotency + retry reasoning before touching this.
 *
 * IDEMPOTENCY (mandatory): Stripe WILL redeliver checkout.session.completed
 * (network retries, at-least-once delivery). grantGeneralCredits() is ADDITIVE,
 * so processing the same event twice would hand out free credits. The dedup key
 * is `session.id`, stored on the purchase-marker CreditTransaction at
 * `metadata.stripeSessionId`. We check for that marker FIRST — if it exists we
 * return without granting again.
 *
 * ORDERING: grantGeneralCredits() logs its own 'general_grant' txn but WITHOUT
 * a stripeSessionId, so it can't serve as the dedup key. We therefore write a
 * distinct 'purchase' marker txn carrying stripeSessionId. Grant happens first,
 * marker second (per spec). The only re-grant window is a crash BETWEEN the grant
 * and the marker write; that window is tiny and favors "granted once, maybe twice
 * on a crash" over "never granted", which is the right trade-off for paid credits.
 *
 * RETRY vs. POISON: transient failures (DB down, grant throws) propagate up so the
 * webhook returns 500 and Stripe RETRIES. Permanent failures (org unresolvable,
 * bad credits amount) are logged loudly and return normally (=> 200) so Stripe
 * STOPS retrying a poisoned event instead of hammering us forever.
 */
async function fulfillCreditPackPurchase(session) {
  const creditPackId = session.metadata?.creditPackId;
  const credits = parseInt(session.metadata?.credits, 10);
  const organizationId = await resolveOrgId(session.metadata);

  // Permanent failures — nothing to retry. Log loudly, return (=> 200) so
  // Stripe stops redelivering a poisoned event.
  if (!organizationId) {
    console.error(`[credits] Credit pack purchase could not resolve org. session=${session.id} metadata:`, session.metadata);
    return;
  }
  if (!Number.isFinite(credits) || credits <= 0) {
    console.error(`[credits] Credit pack purchase has invalid credits="${session.metadata?.credits}" session=${session.id}`);
    return;
  }

  const pack = getPackById(creditPackId);
  const label = pack?.label || `${credits} credits`;

  // Atomic + idempotent: grant and the session-keyed marker commit together in
  // one transaction, so a crash, error, or Stripe redelivery can never
  // double-grant. A transient DB error throws out of here → 500 → Stripe
  // retries cleanly (the aborted txn granted nothing).
  const result = await creditService.grantGeneralCreditsIdempotent(
    organizationId,
    credits,
    `Credit pack: ${label}`,
    { idempotencyKey: session.id, userId: session.metadata?.userId || null, meta: { creditPackId, credits } }
  );

  if (result.alreadyFulfilled) {
    console.log(`[credits] Credit pack already fulfilled for session=${session.id} — skipping (Stripe redelivery)`);
    return;
  }

  auditService.record({
    organizationId,
    userId: session.metadata?.userId || null,
    actorEmail: 'stripe',
    action: 'billing.credits_purchased',
    resourceId: session.id,
    meta: { credits, packId: creditPackId, sessionId: session.id },
  });

  console.log(`[credits] Credit pack fulfilled: org=${organizationId} pack=${creditPackId} credits=${credits} session=${session.id}`);
}

/**
 * Sanitise the acquisition surface arriving from Stripe metadata (Wave 5 §9 F4).
 * Same shape the checkout writer enforces; anything else becomes null rather
 * than seeding an attribution table with arbitrary strings from a webhook body.
 */
function cleanSurface(raw) {
  return typeof raw === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw) ? raw : null;
}

async function handleSubscriptionUpdated(stripeSub) {
  let sub = await Subscription.findOne({
    stripeSubscriptionId: stripeSub.id,
  });

  const priceId = stripeSub.items.data[0]?.price?.id;
  const planId = getPlanFromPriceId(priceId);

  // If no local record, try to create one by resolving org from subscription metadata
  if (!sub) {
    const organizationId = await resolveOrgId(stripeSub.metadata);
    if (organizationId && planId) {
      sub = new Subscription({
        organizationId,
        stripeCustomerId: typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id,
        stripeSubscriptionId: stripeSub.id,
        planId,
        status: stripeSub.status,
        surface: cleanSurface(stripeSub.metadata?.surface),
      });
      console.log(`Creating missing subscription record: org=${organizationId} sub=${stripeSub.id}`);
    } else {
      // Fallback: try finding via stripeCustomerId on existing subscription records
      const customerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id;
      const existingSub = await Subscription.findOne({ stripeCustomerId: customerId });
      if (!existingSub || !planId) return;
      sub = existingSub;
      console.log(`Matched subscription via stripeCustomerId: org=${sub.organizationId} sub=${stripeSub.id}`);
    }
  }

  // Detect plan change for credit pro-rating
  const oldPlanId = sub.planId;
  const isPlanChange = planId && oldPlanId && planId !== oldPlanId;
  // Snapshot pre-update values so the audit entry only records meaningful
  // transitions (Stripe fires this event on renewals, seat syncs, and
  // payment-method changes too — those must not flood the activity feed).
  const prevStatus = sub.status;
  const prevCancelAtPeriodEnd = sub.cancelAtPeriodEnd;

  if (planId) sub.planId = planId;

  // Acquisition surface is write-once: fill it if we never captured one (a doc
  // created before this field existed, or by a path without metadata), but never
  // let a later plan change rewrite where the customer originally came from.
  if (!sub.surface) {
    const s = cleanSurface(stripeSub.metadata?.surface);
    if (s) sub.surface = s;
  }

  const subItem = stripeSub.items.data[0];
  sub.status = stripeSub.status;
  sub.currentPeriodStart = parseStripeDate(subItem?.current_period_start || stripeSub.current_period_start);
  sub.currentPeriodEnd = parseStripeDate(subItem?.current_period_end || stripeSub.current_period_end);
  sub.cancelAtPeriodEnd = stripeSub.cancel_at_period_end;

  if (stripeSub.cancel_at_period_end && !sub.canceledAt) {
    sub.canceledAt = new Date();
  } else if (!stripeSub.cancel_at_period_end) {
    sub.canceledAt = undefined;
  }

  // Update payment method if available
  if (stripeSub.default_payment_method) {
    try {
      const pm = await stripe.paymentMethods.retrieve(
        typeof stripeSub.default_payment_method === 'string'
          ? stripeSub.default_payment_method
          : stripeSub.default_payment_method.id
      );
      if (pm.card) {
        sub.defaultPaymentMethod = {
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        };
      }
    } catch (err) {
      console.error('Failed to fetch payment method:', err.message);
    }
  }

  // Sync extra seats from Stripe subscription items.
  // Skip if a direct update via updateExtraSeats happened within the last 30s
  // to prevent stale webhook events from overwriting the correct value.
  const recentDirectUpdate =
    sub.extraSeatsUpdatedAt && Date.now() - new Date(sub.extraSeatsUpdatedAt).getTime() < 30_000;

  if (!recentDirectUpdate) {
    const seatItem = stripeSub.items.data.find((item) => {
      const pid = item.price?.id;
      return pid && EXTRA_SEAT_PRICE_SET.has(pid);
    });
    if (seatItem) {
      sub.purchasedExtraSeats = seatItem.quantity || 0;
      sub.stripeExtraSeatItemId = seatItem.id;
    } else if (sub.purchasedExtraSeats > 0) {
      // Extra seat item was removed externally (e.g. from Stripe Dashboard)
      sub.purchasedExtraSeats = 0;
      sub.stripeExtraSeatItemId = null;
    }
  }

  await sub.save();
  clearTierCache();
  // Re-evaluate resource locks for the new tier (locks on downgrade, unlocks on upgrade)
  if (sub.organizationId) {
    applyLocksForOrg(sub.organizationId).catch((err) =>
      console.error(`[downgradeService] subscription update lock error for org=${sub.organizationId}:`, err.message)
    );
    // Phase 18 (DARK): re-evaluate tenant lifecycle from the new entitlement —
    // start wind-down if the agency lost saasMode, or recover if it came back.
    // Inert unless saasMode is live.
    lifecycleService.reconcile(sub.organizationId).catch((err) =>
      console.error(`[lifecycle] reconcile error for org=${sub.organizationId}:`, err.message)
    );
    // Phase 11 review follow-up: once the org is active on a PAID tier, re-arm any
    // trackers the Free-tier scan gate unscheduled (nextScanAt=null) so automated
    // scans resume without a manual refresh. Idempotent + fire-and-forget (a
    // scheduling side-effect must never fail the billing webhook).
    const activePaid = (sub.status === 'active' || sub.status === 'trialing')
      && sub.planId && sub.planId.split('-')[0] !== 'free';
    if (activePaid) {
      trackerScheduleService.rearmTrackersForOrg(sub.organizationId).catch((err) =>
        console.error(`[tracker] re-arm error for org=${sub.organizationId}:`, err.message)
      );
    }
  }

  // Handle credit pro-rating on plan change
  if (isPlanChange && sub.organizationId) {
    try {
      await creditService.expireSubscriptionCredits(sub.organizationId);

      const newTier = planId.split('-')[0] === 'pro' ? 'professional' : planId.split('-')[0];
      const newConfig = await getTierConfig(newTier);

      if (newConfig?.creditsPerMonth) {
        const periodEnd = parseStripeDate(subItem?.current_period_end || stripeSub.current_period_end);
        const periodStart = parseStripeDate(subItem?.current_period_start || stripeSub.current_period_start);

        if (periodEnd && periodStart) {
          const totalDays = Math.max(1, (periodEnd - periodStart) / (1000 * 60 * 60 * 24));
          const daysRemaining = Math.max(0, (periodEnd - Date.now()) / (1000 * 60 * 60 * 24));
          const proRatedCredits = Math.ceil(newConfig.creditsPerMonth * (daysRemaining / totalDays));
          await creditService.grantSubscriptionCredits(sub.organizationId, proRatedCredits, periodEnd);
          console.log(`[credits] Plan change: granted ${proRatedCredits} pro-rated credits for org=${sub.organizationId}`);
        } else {
          await creditService.grantSubscriptionCredits(sub.organizationId, newConfig.creditsPerMonth, periodEnd || null);
          console.log(`[credits] Plan change: granted ${newConfig.creditsPerMonth} full credits for org=${sub.organizationId}`);
        }
      }
    } catch (err) {
      console.error(`[credits] Plan change credit error for org=${sub.organizationId}:`, err.message);
    }
  }

  // Audit only meaningful lifecycle transitions — plan change, status
  // change, or cancellation scheduled/undone. Renewals, seat syncs, and
  // payment-method updates fire this webhook too and are noise here.
  const meaningful =
    isPlanChange ||
    sub.status !== prevStatus ||
    sub.cancelAtPeriodEnd !== prevCancelAtPeriodEnd;
  if (sub.organizationId && meaningful) {
    auditService.record({
      organizationId: sub.organizationId,
      userId: null, // system actor
      actorEmail: 'stripe',
      action: isPlanChange ? 'billing.plan_change' : 'billing.subscription_updated',
      resourceId: stripeSub.id,
      meta: { planId: sub.planId, status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
    });
  }

  console.log(`Subscription updated: sub=${stripeSub.id} status=${stripeSub.status}`);
}

async function handleSubscriptionDeleted(stripeSub) {
  const sub = await Subscription.findOne({
    stripeSubscriptionId: stripeSub.id,
  });
  if (!sub) return;

  sub.status = 'canceled';
  sub.canceledAt = sub.canceledAt || new Date();
  sub.purchasedExtraSeats = 0;
  sub.stripeExtraSeatItemId = null;
  await sub.save();

  clearTierCache();
  // Lock excess resources — org falls back to free tier
  applyLocksForOrg(sub.organizationId).catch((err) =>
    console.error(`[downgradeService] subscription delete lock error for org=${sub.organizationId}:`, err.message)
  );
  // Phase 18 (DARK): agency lost its subscription entirely → start wind-down if
  // it has live client assets. Inert unless saasMode is live.
  lifecycleService.reconcile(sub.organizationId).catch((err) =>
    console.error(`[lifecycle] reconcile error for org=${sub.organizationId}:`, err.message)
  );

  // Expire remaining subscription credits
  try {
    await creditService.expireSubscriptionCredits(sub.organizationId);
    console.log(`[credits] Expired credits for canceled org=${sub.organizationId}`);
  } catch (err) {
    console.error(`[credits] Failed to expire on cancel for org=${sub.organizationId}:`, err.message);
  }

  auditService.record({
    organizationId: sub.organizationId,
    userId: null, // system actor
    actorEmail: 'stripe',
    action: 'billing.subscription_canceled',
    resourceId: stripeSub.id,
    meta: { planId: sub.planId },
  });

  // Reset monthly usage counters — org has no free tier, so stale counters
  // would block the user when they re-subscribe to a new paid plan.
  try {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await UsageTracker.deleteMany({ organizationId: sub.organizationId, period: currentPeriod });
    console.log(`[usage] Reset monthly counters for canceled org=${sub.organizationId}`);
  } catch (err) {
    console.error(`[usage] Failed to reset counters for org=${sub.organizationId}:`, err.message);
  }

  // Cancellation email via triggerable template — notifyOrgOwner handles the
  // kill-switch, owner lookup, opt-out check, and never throws.
  await notifyOrgOwner(sub.organizationId, 'subscription_canceled', {
    planName: formatPlanName(sub.planId),
    endDate: formatEmailDate(sub.currentPeriodEnd),
  });

  // Auto-delete user account if they requested deletion while subscription was active
  try {
    const org = await Organization.findById(sub.organizationId).lean();
    if (org?.ownerId) {
      const owner = await User.findById(org.ownerId);
      if (owner && owner.status === 'pending_deletion') {
        const originalEmail = owner.email;
        // Soft-delete user
        owner.status = 'deleted';
        owner.email = `deleted_${Date.now()}_${originalEmail}`;
        owner.tokenVersion = (owner.tokenVersion || 0) + 1;
        await owner.save();
        // Clean up sessions
        await Session.deleteMany({ userId: owner._id });
        // Remove from all org memberships
        await OrgMember.deleteMany({ userId: owner._id });
        // Cascade-delete personal org and its workspaces
        const personalOrg = await Organization.findOne({ ownerId: owner._id, isPersonal: true });
        if (personalOrg) {
          await Workspace.deleteMany({ organizationId: personalOrg._id });
          await Organization.deleteOne({ _id: personalOrg._id });
        }
        console.log(`[auto-delete] Account deleted for pending_deletion user="${originalEmail}" org=${sub.organizationId}`);
      }
    }
  } catch (err) {
    console.error(`[auto-delete] Failed for org=${sub.organizationId}:`, err.message);
  }

  console.log(`Subscription deleted: sub=${stripeSub.id}`);
}

async function handlePaymentSucceeded(invoice) {
  if (!invoice.subscription) return;

  const sub = await Subscription.findOne({
    stripeSubscriptionId: invoice.subscription,
  });
  if (!sub) return;

  // Avoid duplicates
  const exists = sub.paymentHistory.some((p) => p.invoiceId === invoice.id);
  if (exists) return;

  sub.paymentHistory.push({
    invoiceId: invoice.id,
    number: invoice.number || invoice.id,
    amount: (invoice.amount_paid || 0) / 100,
    currency: (invoice.currency || 'usd').toUpperCase(),
    status: 'paid',
    description: invoice.lines?.data?.[0]?.description || 'Subscription',
    invoiceUrl: invoice.hosted_invoice_url || null,
    pdfUrl: invoice.invoice_pdf || null,
    date: parseStripeDate(invoice.created),
  });
  await sub.save();

  // Grant credits on subscription renewal (not initial checkout). Phase 7:
  // ROLL OVER instead of expire+replace — grantMonthlyCreditsIfDue carries up to
  // one month's unused credits into the new period (idempotent per calendar month
  // so the monthly cron never double-grants the same renewal). For a MONTHLY plan
  // this fires each cycle; a YEARLY plan renews here once/year and the cron fills
  // the other 11 months.
  if (invoice.billing_reason === 'subscription_cycle') {
    try {
      const { config } = await getOrgTierConfig(sub.organizationId);
      if (config?.creditsPerMonth) {
        // Expiry is the monthly rollover window computed inside the service — NOT
        // the invoice period end (which for a yearly plan is a year out).
        const r = await creditService.grantMonthlyCreditsIfDue(
          sub.organizationId,
          config.creditsPerMonth,
        );
        console.log(`[credits] Renewal grant org=${sub.organizationId}: ${r.granted ? `${r.amount} (+${r.rolledOver} rollover)` : r.reason}`);
      }
    } catch (err) {
      console.error(`[credits] Failed to renew credits for org=${sub.organizationId}:`, err.message);
    }
  }

  // Payment confirmation email via triggerable template. Skip $0 invoices
  // (trials, 100% coupons, proration credit) — "you paid $0.00" reads as a bug.
  if ((invoice.amount_paid || 0) > 0) {
    await notifyOrgOwner(sub.organizationId, 'payment_confirmation', {
      planName: formatPlanName(sub.planId),
      amount: `$${(invoice.amount_paid / 100).toFixed(2)} ${(invoice.currency || 'usd').toUpperCase()}`,
      nextBillingDate: formatEmailDate(
        parseStripeDate(invoice.lines?.data?.[0]?.period?.end) || sub.currentPeriodEnd
      ),
    });
  }

  console.log(`Invoice saved: ${invoice.id} for sub=${invoice.subscription}`);
}

async function handlePaymentFailed(invoice) {
  if (!invoice.subscription) return;

  const sub = await Subscription.findOne({
    stripeSubscriptionId: invoice.subscription,
  });
  if (!sub) return;

  sub.status = 'past_due';

  // Save failed invoice to history
  const exists = sub.paymentHistory.some((p) => p.invoiceId === invoice.id);
  if (!exists) {
    sub.paymentHistory.push({
      invoiceId: invoice.id,
      number: invoice.number || invoice.id,
      amount: (invoice.amount_due || 0) / 100,
      currency: (invoice.currency || 'usd').toUpperCase(),
      status: 'failed',
      description: invoice.lines?.data?.[0]?.description || 'Subscription',
      invoiceUrl: invoice.hosted_invoice_url || null,
      pdfUrl: invoice.invoice_pdf || null,
      date: parseStripeDate(invoice.created),
    });
  }

  await sub.save();
  clearTierCache();

  // Payment failed notification via triggerable template.
  // Invariant I1: tenant-facing links use the org's custom domain when active
  const baseUrl = await require('../services/domainService').resolveBaseUrl(sub.organizationId);
  await notifyOrgOwner(sub.organizationId, 'payment_failed', {
    planName: formatPlanName(sub.planId),
    retryDate: invoice.next_payment_attempt
      ? formatEmailDate(parseStripeDate(invoice.next_payment_attempt))
      : 'soon',
    updatePaymentUrl: `${baseUrl}/settings/billing`,
  });

  console.log(`Payment failed: sub=${invoice.subscription}`);
}

module.exports = { handleWebhook, handleCheckoutCompleted, fulfillCreditPackPurchase };
