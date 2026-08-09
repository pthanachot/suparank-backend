const Stripe = require('stripe');
const STRIPE_API_VERSION = require('../config/stripeApiVersion');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const { clearTierCache, getOrgTierConfig } = require('../services/tierService');
const { applyLocksForOrg } = require('../services/downgradeService');
const { getPlanFromPriceId, PRICE_TO_PLAN, EXTRA_SEAT_PRICES } = require('../config/stripePrices');
const { CREDIT_PACKS, getPackById } = require('../config/creditPacks');
const auditService = require('../services/auditService');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

// Phase 10: append-only audit row for owner cash actions. Fire-and-forget —
// auditService.record never throws and must not block the billing response.
function auditBilling(req, org, action, meta = null) {
  auditService.record({
    organizationId: org._id,
    userId: req.user.userId,
    actorEmail: req.user.email,
    action,
    resource: 'billing',
    meta,
    ip: req.ip,
    impersonatedBy: req.user.impersonatedBy || null,
  });
}

const { appUrl } = require('../config/appUrl');

// The canonical app origin (APP_URL, else FRONTEND_URL). Every Stripe
// success/cancel/return URL below is built from it.
const APP_URL = appUrl();

// Convert Stripe Unix timestamps (seconds) to Date objects
function parseStripeDate(ts) {
  if (!ts) return undefined;
  const date = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return isNaN(date.getTime()) ? undefined : date;
}

// Plan metadata (prices filled in after Stripe Dashboard setup)
const PLAN_INFO = {
  free: { name: 'Free', optimizations: 1, aiModel: 'Basic' },
  'standard-monthly': { name: 'Standard', optimizations: 30, aiModel: 'Advanced' },
  'standard-yearly': { name: 'Standard', optimizations: 30, aiModel: 'Advanced' },
  'pro-monthly': { name: 'Pro', optimizations: -1, aiModel: 'Custom' },
  'pro-yearly': { name: 'Pro', optimizations: -1, aiModel: 'Custom' },
  'agency-monthly': { name: 'Agency', optimizations: -1, aiModel: 'Custom' },
  'agency-yearly': { name: 'Agency', optimizations: -1, aiModel: 'Custom' },
};

// ─── HELPERS ─────────────────────────────────────────────────

/**
 * Validate that the authenticated user is the owner of the given org.
 * Returns the org document on success, or sends a 400/403 and returns null.
 */
async function validateOrgOwner(req, res, orgId) {
  if (!orgId) {
    res.status(400).json({ error: 'orgId is required' });
    return null;
  }

  const org = await Organization.findById(orgId).lean();
  if (!org) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }

  if (!org.ownerId.equals(req.user.userId)) {
    res.status(403).json({ error: 'Only the organization owner can manage billing' });
    return null;
  }

  return org;
}

/**
 * Reuse the org's existing Stripe customer, or create one if none exists.
 * Shared by the subscription checkout and the credit-pack checkout so both
 * flows attach to the SAME per-organization customer. Behavior is identical
 * to the previously-inline logic in createCheckoutSession.
 */
async function getOrCreateStripeCustomer(org, user, orgId) {
  const existingSub = await Subscription.findOne({ organizationId: orgId });
  // Reuse a customer from either the Subscription (platform sub flow) or the
  // Organization (persisted below). Credit-pack purchases can happen for orgs
  // with no Subscription row, so without persisting we'd mint a duplicate
  // Stripe customer on every purchase and fragment the org's billing history.
  let customerId = existingSub?.stripeCustomerId || org.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: `${org.name} (${user.profile?.name || user.email})`,
      metadata: {
        organizationId: orgId.toString(),
        userId: user._id.toString(),
      },
    });
    customerId = customer.id;
    // Persist on the Organization so future purchases reuse this customer even
    // when there's no Subscription row yet. (The subscription webhook still
    // writes Subscription.stripeCustomerId for the platform sub flow.)
    await Organization.updateOne({ _id: orgId }, { stripeCustomerId: customerId }).catch(() => {});
  }

  return customerId;
}

// ─── GET SUBSCRIPTION ─────────────────────────────────────────

const getSubscription = async (req, res) => {
  try {
    const orgId = req.query.orgId;
    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    // Only return real, active subscriptions (must have a Stripe subscription ID and plan)
    let sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
      stripeSubscriptionId: { $exists: true, $ne: null },
      planId: { $exists: true, $ne: null },
    });

    // If local record exists but dates are missing, refresh from Stripe
    if (sub && !sub.currentPeriodEnd) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        const subItem = stripeSub.items.data[0];
        sub.currentPeriodStart = parseStripeDate(subItem?.current_period_start || stripeSub.current_period_start);
        sub.currentPeriodEnd = parseStripeDate(subItem?.current_period_end || stripeSub.current_period_end);
        await sub.save();
        console.log(`Refreshed missing dates from Stripe for org=${orgId}`);
      } catch (err) {
        console.error('Failed to refresh dates from Stripe:', err.message);
      }
    }

    // Fallback: if no local record, check Stripe directly and sync
    if (!sub) {
      // Check if there's an existing subscription for this org with a Stripe customer
      const existingSub = await Subscription.findOne({ organizationId: orgId });
      if (existingSub?.stripeCustomerId) {
        const stripeSubs = await stripe.subscriptions.list({
          customer: existingSub.stripeCustomerId,
          status: 'active',
          limit: 1,
          expand: ['data.default_payment_method'],
        });

        if (stripeSubs.data.length > 0) {
          const stripeSub = stripeSubs.data[0];
          const priceId = stripeSub.items.data[0]?.price?.id;
          const planId = getPlanFromPriceId(priceId);

          if (planId) {
            const paymentMethod = stripeSub.default_payment_method;
            const subItem = stripeSub.items.data[0];
            sub = await Subscription.findOneAndUpdate(
              { organizationId: orgId },
              {
                organizationId: orgId,
                userId: req.user.userId,
                stripeCustomerId: existingSub.stripeCustomerId,
                stripeSubscriptionId: stripeSub.id,
                planId,
                status: stripeSub.status,
                currentPeriodStart: parseStripeDate(subItem?.current_period_start || stripeSub.current_period_start),
                currentPeriodEnd: parseStripeDate(subItem?.current_period_end || stripeSub.current_period_end),
                cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
                canceledAt: stripeSub.canceled_at ? parseStripeDate(stripeSub.canceled_at) : undefined,
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
            console.log(`Synced subscription from Stripe: org=${orgId} plan=${planId}`);
          }
        }
      }
    }

    if (!sub) {
      return res.json({
        subscription: null,
        plan: PLAN_INFO.free,
        planId: 'free',
        status: 'active',
      });
    }

    const planInfo = PLAN_INFO[sub.planId] || PLAN_INFO.free;

    // Fetch live subscription from Stripe for price info and schedule checks
    let pendingPlanChange = null;
    let billing = null;
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

      // Extract actual price from Stripe
      const subItem = stripeSub.items.data[0];
      if (subItem?.price) {
        billing = {
          amount: (subItem.price.unit_amount || 0) / 100,
          currency: (subItem.price.currency || 'usd').toUpperCase(),
          interval: subItem.price.recurring?.interval || 'month',       // "month" | "year"
          intervalCount: subItem.price.recurring?.interval_count || 1,
        };
      }

      if (stripeSub.schedule) {
        const schedule = await stripe.subscriptionSchedules.retrieve(stripeSub.schedule);
        const now = Date.now() / 1000;
        const nextPhase = schedule.phases?.find((p) => p.start_date > now);

        if (nextPhase) {
          const nextPriceId = nextPhase.items?.[0]?.price;
          const priceIdStr = typeof nextPriceId === 'string' ? nextPriceId : nextPriceId?.id;
          const nextPlanId = getPlanFromPriceId(priceIdStr);

          if (nextPlanId && nextPlanId !== sub.planId) {
            const nextPlanInfo = PLAN_INFO[nextPlanId] || {};
            const nextInterval = nextPlanId.includes('yearly') ? 'Yearly' : 'Monthly';
            const currentInterval = sub.planId.includes('yearly') ? 'Yearly' : 'Monthly';
            const isSameTier = nextPlanInfo.name === (PLAN_INFO[sub.planId] || {}).name;
            pendingPlanChange = {
              planId: nextPlanId,
              planName: isSameTier
                ? `${nextPlanInfo.name} ${nextInterval}`
                : nextPlanInfo.name || nextPlanId,
              currentPlanName: isSameTier
                ? `${(PLAN_INFO[sub.planId] || {}).name} ${currentInterval}`
                : undefined,
              effectiveDate: new Date(nextPhase.start_date * 1000).toISOString(),
            };
          }
        }
      }
    } catch (err) {
      console.error('Failed to check subscription schedule:', err.message);
    }

    res.json({
      subscription: {
        planId: sub.planId,
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        canceledAt: sub.canceledAt,
        defaultPaymentMethod: sub.defaultPaymentMethod,
      },
      plan: planInfo,
      planId: sub.planId,
      status: sub.status,
      extraSeats: sub.purchasedExtraSeats || 0,
      billing,
      pendingPlanChange,
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
};

// ─── CREATE CHECKOUT SESSION ──────────────────────────────────

const createCheckoutSession = async (req, res) => {
  try {
    const { priceId, orgId } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: 'Price ID is required' });
    }

    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create or retrieve Stripe customer per organization
    const customerId = await getOrCreateStripeCustomer(org, user, orgId);

    // Block checkout if org already has an active subscription
    const activeSub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
      stripeSubscriptionId: { $exists: true, $ne: null },
    });

    if (activeSub) {
      return res.status(400).json({
        error: 'This organization already has an active subscription. Please cancel the current plan first to switch plans.',
        existingSubscription: {
          planId: activeSub.planId,
          status: activeSub.status,
        },
      });
    }

    // Also check Stripe directly (handles race condition when webhook hasn't processed yet)
    const stripeSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    if (stripeSubscriptions.data.length > 0) {
      return res.status(400).json({
        error: 'This organization already has an active subscription. Please cancel the current plan first to switch plans.',
      });
    }

    // Wave 1 (§4c-9): the upgrade surface that led here, threaded into Stripe
    // metadata so a completed subscription can be attributed to the surface
    // that sold it — client events alone stop at checkout-start. Strictly
    // sanitized: client-supplied, and Stripe metadata is forever.
    const surface = typeof req.body?.surface === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(req.body.surface)
      ? req.body.surface
      : null;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      payment_method_collection: 'if_required',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/settings/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/pricing`,
      metadata: {
        organizationId: orgId.toString(),
        userId: user._id.toString(),
        ...(surface ? { surface } : {}),
      },
      subscription_data: {
        metadata: {
          organizationId: orgId.toString(),
          userId: user._id.toString(),
          ...(surface ? { surface } : {}),
        },
      },
    });

    auditBilling(req, org, 'billing.checkout_started', { priceId, plan: PRICE_TO_PLAN[priceId] || null, surface });
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Create checkout session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

// ─── CREATE CUSTOMER PORTAL ───────────────────────────────────

const createCustomerPortal = async (req, res) => {
  try {
    const { flow, orgId } = req.body || {};

    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const sub = await Subscription.findOne({
      organizationId: orgId,
      stripeCustomerId: { $exists: true, $ne: null },
    });

    if (!sub?.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found for this organization' });
    }

    const portalParams = {
      customer: sub.stripeCustomerId,
      return_url: `${APP_URL}/settings/billing`,
    };

    // If flow is 'subscription_update', go directly to plan switching
    if (flow === 'subscription_update') {
      const activeSub = await Subscription.findOne({
        organizationId: orgId,
        status: { $in: ['active', 'trialing'] },
        stripeSubscriptionId: { $exists: true, $ne: null },
      });

      if (activeSub) {
        // Release any pending schedule first — Stripe blocks flow_data when a schedule exists
        try {
          const stripeSub = await stripe.subscriptions.retrieve(activeSub.stripeSubscriptionId);
          if (stripeSub.schedule) {
            await stripe.subscriptionSchedules.release(stripeSub.schedule);
            console.log(`Released schedule ${stripeSub.schedule} before portal update flow`);
          }
        } catch (err) {
          console.error('Failed to release schedule before portal:', err.message);
        }

        portalParams.flow_data = {
          type: 'subscription_update',
          subscription_update: {
            subscription: activeSub.stripeSubscriptionId,
          },
        };
      }
    }

    const session = await stripe.billingPortal.sessions.create(portalParams);

    auditBilling(req, org, 'billing.portal_opened', { flow: flow || 'manage' });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Create customer portal error:', error);
    res.status(500).json({ error: 'Failed to create customer portal' });
  }
};

// ─── REVOKE SCHEDULED CHANGE ─────────────────────────────────

const revokeScheduledChange = async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
      stripeSubscriptionId: { $exists: true, $ne: null },
    });

    if (!sub) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    if (!stripeSub.schedule) {
      return res.status(400).json({ error: 'No pending plan change to revoke' });
    }

    // Release the schedule — keeps current plan, removes the pending change
    await stripe.subscriptionSchedules.release(stripeSub.schedule);

    auditBilling(req, org, 'billing.plan_change_revoked');
    res.json({ message: 'Pending plan change revoked' });
  } catch (error) {
    console.error('Revoke scheduled change error:', error);
    res.status(500).json({ error: 'Failed to revoke scheduled change' });
  }
};

// ─── CANCEL SUBSCRIPTION ─────────────────────────────────────

const cancelSubscription = async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
    });

    if (!sub) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // If there's a pending schedule (e.g. downgrade), release it first
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
      if (stripeSub.schedule) {
        await stripe.subscriptionSchedules.release(stripeSub.schedule);
        console.log(`Released schedule ${stripeSub.schedule} before cancellation`);
      }
    } catch (err) {
      console.error('Failed to release schedule before cancel:', err.message);
    }

    // Always cancel at period end — user keeps access until billing period expires
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    sub.cancelAtPeriodEnd = true;
    sub.canceledAt = new Date();
    await sub.save();

    clearTierCache();

    auditBilling(req, org, 'billing.subscription_canceled', { cancelAtPeriodEnd: true });
    res.json({ message: 'Subscription will cancel at end of billing period' });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
};

// ─── REACTIVATE SUBSCRIPTION ──────────────────────────────────

const reactivateSubscription = async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
      cancelAtPeriodEnd: true,
    });

    if (!sub) {
      return res.status(404).json({ error: 'No canceled subscription found' });
    }

    // Verify the subscription still exists and is active on Stripe
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    if (stripeSub.status === 'canceled') {
      // Stripe already deleted it — clean up local record
      sub.status = 'canceled';
      sub.cancelAtPeriodEnd = false;
      await sub.save();
      return res.status(404).json({ error: 'Subscription has already been canceled and cannot be reactivated' });
    }

    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    sub.cancelAtPeriodEnd = false;
    sub.canceledAt = undefined;
    await sub.save();

    clearTierCache();
    // Re-evaluate resource locks — reactivation restores the paid tier
    applyLocksForOrg(orgId).catch((err) =>
      console.error(`[downgradeService] reactivation lock error for org=${orgId}:`, err.message)
    );

    auditBilling(req, org, 'billing.subscription_reactivated');
    res.json({ message: 'Subscription reactivated' });
  } catch (error) {
    console.error('Reactivate subscription error:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
};

// ─── GET INVOICES ─────────────────────────────────────────────

const getInvoices = async (req, res) => {
  try {
    const orgId = req.query.orgId;
    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const sub = await Subscription.findOne({ organizationId: orgId });

    // No subscription at all
    if (!sub) {
      return res.json({ invoices: [] });
    }

    // If paymentHistory is empty but org has a Stripe customer, backfill once from Stripe
    if (sub.paymentHistory.length === 0 && sub.stripeCustomerId) {
      try {
        const stripeInvoices = await stripe.invoices.list({
          customer: sub.stripeCustomerId,
          limit: 24,
        });

        for (const inv of stripeInvoices.data) {
          sub.paymentHistory.push({
            invoiceId: inv.id,
            number: inv.number || inv.id,
            amount: (inv.amount_paid || 0) / 100,
            currency: (inv.currency || 'usd').toUpperCase(),
            status: inv.status === 'paid' ? 'paid' : inv.status === 'void' ? 'refunded' : inv.status,
            description: inv.lines?.data?.[0]?.description || 'Subscription',
            invoiceUrl: inv.hosted_invoice_url || null,
            pdfUrl: inv.invoice_pdf || null,
            date: new Date(inv.created * 1000),
          });
        }

        if (sub.paymentHistory.length > 0) {
          await sub.save();
          console.log(`Backfilled ${sub.paymentHistory.length} invoices from Stripe for org=${orgId}`);
        }
      } catch (err) {
        console.error('Failed to backfill invoices from Stripe:', err.message);
      }
    }

    // Sort by date descending and return
    const invoices = sub.paymentHistory
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map((inv) => ({
        id: inv.number || inv.invoiceId,
        date: inv.date?.toISOString(),
        description: inv.description,
        amount: inv.amount?.toFixed(2),
        currency: inv.currency || 'USD',
        status: inv.status,
        invoiceUrl: inv.invoiceUrl,
        pdfUrl: inv.pdfUrl,
      }));

    res.json({ invoices });
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: 'Failed to get invoices' });
  }
};

// ─── UPDATE EXTRA SEATS ─────────────────────────────────────

const updateExtraSeats = async (req, res) => {
  try {
    const { orgId, quantity } = req.body;

    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 0) {
      return res.status(400).json({ error: 'Quantity must be a non-negative integer' });
    }

    // Must have an active subscription
    const sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
      stripeSubscriptionId: { $exists: true, $ne: null },
    });

    if (!sub) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Validate tier supports extra seats
    const { config, tier } = await getOrgTierConfig(orgId);
    if (!config || !config.extraSeatPrice || config.extraSeatPrice <= 0) {
      return res.status(400).json({
        error: `Extra seats are not available on the ${config?.displayName || tier} plan.`,
      });
    }

    // Get the correct extra seat price ID for this plan's billing interval
    const seatPriceId = EXTRA_SEAT_PRICES[sub.planId];
    if (!seatPriceId) {
      return res.status(400).json({
        error: 'Extra seat pricing is not configured for this plan. Please contact support.',
      });
    }

    // If reducing seats, ensure we don't go below currently occupied extra seats.
    // Phase 9: count EDITOR seats only (org-wide members + owner + pending
    // org-wide invites) — free client viewers must not inflate seat occupancy.
    if (qty < (sub.purchasedExtraSeats || 0)) {
      const { seatsUsed } = await require('../services/seatService').getSeatUsage(orgId);
      const baseSeats = config.maxSeats || 0;
      const occupiedExtraSeats = Math.max(0, seatsUsed - baseSeats);

      if (qty < occupiedExtraSeats) {
        return res.status(400).json({
          error: `Cannot reduce to ${qty} extra seat(s). You currently have ${occupiedExtraSeats} member(s) using extra seats. Remove members first.`,
          occupiedExtraSeats,
        });
      }
    }

    // Apply changes to Stripe subscription.
    // 'always_invoice' charges immediately when adding/increasing seats,
    // preventing free usage if the card later declines.
    // Removals use 'create_prorations' (credit applied to next invoice).
    if (qty > 0 && !sub.stripeExtraSeatItemId) {
      // Create new subscription item — charge immediately
      const item = await stripe.subscriptionItems.create({
        subscription: sub.stripeSubscriptionId,
        price: seatPriceId,
        quantity: qty,
        proration_behavior: 'always_invoice',
      });
      sub.stripeExtraSeatItemId = item.id;
    } else if (qty > 0 && sub.stripeExtraSeatItemId) {
      // Update existing subscription item — charge immediately if increasing
      await stripe.subscriptionItems.update(sub.stripeExtraSeatItemId, {
        quantity: qty,
        proration_behavior: qty > (sub.purchasedExtraSeats || 0) ? 'always_invoice' : 'create_prorations',
      });
    } else if (qty === 0 && sub.stripeExtraSeatItemId) {
      // Remove subscription item — credit on next invoice
      await stripe.subscriptionItems.del(sub.stripeExtraSeatItemId, {
        proration_behavior: 'create_prorations',
      });
      sub.stripeExtraSeatItemId = null;
    }

    const prevSeats = sub.purchasedExtraSeats || 0;
    sub.purchasedExtraSeats = qty;
    sub.extraSeatsUpdatedAt = new Date();
    await sub.save();

    clearTierCache();
    applyLocksForOrg(orgId).catch((err) =>
      console.error(`[downgradeService] extra seats lock error for org=${orgId}:`, err.message)
    );

    // Attribute the seat change to the acting admin — the Stripe webhook
    // that follows is filtered out as a sync, not a lifecycle event.
    require('../services/auditService').record({
      organizationId: orgId,
      userId: req.user.userId,
      actorEmail: req.user.email,
      action: 'billing.seats_updated',
      resourceId: sub.stripeSubscriptionId,
      meta: { extraSeats: qty, previousExtraSeats: prevSeats },
      ip: req.ip,
      impersonatedBy: req.user.impersonatedBy || null,
    });

    res.json({
      extraSeats: qty,
      // null `maxSeats` means unlimited — preserve it so the frontend doesn't
      // mis-render a finite cap. Mirrors the same handling in tierController.
      effectiveMaxSeats: config.maxSeats != null ? config.maxSeats + qty : null,
      pricePerSeat: config.extraSeatPrice,
      monthlyCost: config.extraSeatPrice * qty,
    });
  } catch (error) {
    console.error('Update extra seats error:', error);
    res.status(500).json({ error: 'Failed to update extra seats' });
  }
};

// ─── GET PLAN PRICES (public, cached) ────────────────────────

let _priceCache = null;
let _priceCacheExpiry = 0;
const PRICE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const getPrices = async (_req, res) => {
  try {
    if (_priceCache && Date.now() < _priceCacheExpiry) {
      return res.json(_priceCache);
    }

    // Fetch all plan prices from Stripe in parallel
    const priceIds = Object.keys(PRICE_TO_PLAN);
    const stripeResults = await Promise.all(
      priceIds.map((id) => stripe.prices.retrieve(id).catch(() => null))
    );

    const plans = {};
    for (let i = 0; i < priceIds.length; i++) {
      const sp = stripeResults[i];
      if (!sp) continue;
      const planId = PRICE_TO_PLAN[priceIds[i]]; // e.g. "standard-monthly"
      const tier = planId.split('-')[0];          // e.g. "standard"
      const interval = planId.includes('yearly') ? 'year' : 'month';

      if (!plans[tier]) plans[tier] = {};
      plans[tier][interval] = {
        priceId: sp.id,
        amount: (sp.unit_amount || 0) / 100,
        currency: (sp.currency || 'usd').toUpperCase(),
        interval,
      };
    }

    const result = { plans };
    _priceCache = result;
    _priceCacheExpiry = Date.now() + PRICE_CACHE_TTL;

    res.json(result);
  } catch (error) {
    console.error('Get prices error:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
};

// ─── CREDIT PACKS (one-time top-up purchases) ────────────────

/**
 * Return the credit-pack catalog for the UI. Display fields only —
 * the Stripe price ID is never exposed to the client.
 */
const getCreditPacks = async (_req, res) => {
  res.json({
    packs: CREDIT_PACKS.map((p) => ({
      id: p.id,
      label: p.label,
      credits: p.credits,
      priceUsd: p.priceUsd,
    })),
  });
};

/**
 * Create a one-time Stripe Checkout Session for a credit top-up pack.
 * mode:'payment' (NOT subscription) — fulfillment happens in the
 * checkout.session.completed webhook (webhookController.fulfillCreditPackPurchase).
 */
const createCreditPackCheckout = async (req, res) => {
  try {
    const { orgId, packId } = req.body;

    if (!packId) {
      return res.status(400).json({ error: 'packId is required' });
    }

    const org = await validateOrgOwner(req, res, orgId);
    if (!org) return;

    const pack = getPackById(packId);
    if (!pack) {
      return res.status(400).json({ error: 'Invalid credit pack' });
    }

    // Dark-ship friendly: the pack exists in the catalog but its Stripe
    // one-time Price hasn't been wired up yet. Let the UI render it but
    // refuse checkout instead of creating a broken session.
    if (!pack.stripePriceId) {
      return res.status(503).json({ error: 'Credit packs are not configured yet' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Reuse the same per-org Stripe customer as the subscription checkout.
    const customerId = await getOrCreateStripeCustomer(org, user, orgId);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment', // one-time charge, NOT a subscription
      payment_method_types: ['card'],
      line_items: [{ price: pack.stripePriceId, quantity: 1 }],
      success_url: `${APP_URL}/settings/billing?credit_purchase=success`,
      cancel_url: `${APP_URL}/settings/billing`,
      // credits + creditPackId are the webhook's fulfillment inputs; the
      // webhook branches on `mode === 'payment' && metadata.creditPackId`.
      metadata: {
        organizationId: orgId.toString(),
        userId: user._id.toString(),
        creditPackId: pack.id,
        credits: String(pack.credits),
      },
    });

    auditBilling(req, org, 'billing.credit_pack_checkout', { creditPackId: pack.id, credits: pack.credits });
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Create credit pack checkout error:', error);
    res.status(500).json({ error: 'Failed to create credit pack checkout' });
  }
};

/**
 * Notify an org's owner via a triggerable email template. Mirrors
 * webhookController.notifyOrgOwner (kept local to avoid a controller↔controller
 * import). Best-effort — never throws into the request path.
 */
async function notifyOwner(organizationId, triggerId, data) {
  try {
    const { getSettings } = require('../services/systemSettingsService');
    if (getSettings().emailNotificationsEnabled === false) return;
    const { applyCustomTemplate } = require('./emailPortalController');
    const { sendEmail } = require('../utils/emailService');
    const org = await Organization.findById(organizationId).lean();
    const owner = org?.ownerId ? await User.findById(org.ownerId).lean() : null;
    if (!owner?.email || owner.preferences?.emailNotifications === false) return;

    const { htmlEscape, subjectSafe } = require('../utils/htmlEscape');
    const emailOptions = {
      to: owner.email,
      orgId: organizationId,
      data: { userName: htmlEscape(owner.profile?.name || 'there'), ...data },
    };
    await applyCustomTemplate(triggerId, emailOptions, organizationId);
    if (!emailOptions.subject) return; // template resolved to nothing — skip
    // Escaped values reach the Subject too, and a Subject is plain text —
    // "Top-up requested by O&#39;Brien" is not acceptable. See subjectSafe.
    emailOptions.subject = subjectSafe(emailOptions.subject);
    await sendEmail(emailOptions);
    console.log(`[email] ${triggerId} email sent to owner of org=${organizationId}`);
  } catch (err) {
    console.error(`[email] Failed to send ${triggerId} for org=${organizationId}:`, err.message);
  }
}

/**
 * POST /billing/request-topup — Phase 7. A non-owner member (Admin/Editor) asks
 * the org owner to buy more credits. RBAC: billing.requestTopup = Admin/Editor
 * ONLY (owners buy directly via billing.manage — validated here, not via rp
 * middleware, matching the rest of billing). Notifies the owner with the
 * requested amount + context.
 */
const requestTopup = async (req, res) => {
  try {
    const { orgId, amount, note } = req.body;
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    const org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Owners don't "request" — they purchase directly.
    if (org.ownerId.equals(req.user.userId)) {
      return res.status(400).json({ error: 'As the owner you can purchase credits directly from billing.' });
    }
    // Must be an active Admin or Editor of this org.
    const member = await OrgMember.findOne({
      organizationId: orgId,
      userId: req.user.userId,
      status: 'active',
    }).lean();
    if (!member || (member.role !== 'admin' && member.role !== 'editor')) {
      return res.status(403).json({ error: 'Only admins and editors can request a top-up.' });
    }

    const requester = await User.findById(req.user.userId).lean();
    // Escaped for the same reason as inviteService.createInvite: these are
    // free text the REQUESTER controls, substituted raw into a template that
    // is delivered to someone else (the org owner). `note` especially — it is
    // 500 characters of arbitrary input. See utils/htmlEscape.
    const { htmlEscape } = require('../utils/htmlEscape');
    const requesterName = htmlEscape(requester?.profile?.name || requester?.email || 'A team member');
    // amount is free-form context (credits or $), not a charge — sanitize to a short string.
    const amountStr = htmlEscape(amount != null ? String(amount).slice(0, 40) : 'unspecified');
    const noteStr = htmlEscape(typeof note === 'string' ? note.slice(0, 500) : '');

    await notifyOwner(orgId, 'topup_requested', {
      requesterName,
      requesterEmail: htmlEscape(requester?.email || ''),
      amount: amountStr,
      note: noteStr,
      billingUrl: `${APP_URL}/settings/billing`,
    });

    auditBilling(req, org, 'billing.topup_requested', { amount: amountStr });
    res.json({ success: true, message: 'Your top-up request was sent to the organization owner.' });
  } catch (err) {
    console.error('requestTopup error:', err.message);
    res.status(500).json({ error: 'Failed to send top-up request' });
  }
};

module.exports = {
  getSubscription,
  createCheckoutSession,
  createCustomerPortal,
  revokeScheduledChange,
  cancelSubscription,
  reactivateSubscription,
  getInvoices,
  updateExtraSeats,
  getPrices,
  getCreditPacks,
  createCreditPackCheckout,
  requestTopup,
};
