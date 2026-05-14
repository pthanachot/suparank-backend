const Stripe = require('stripe');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const { clearTierCache, getOrgTierConfig } = require('../services/tierService');
const { applyLocksForOrg } = require('../services/downgradeService');
const { getPlanFromPriceId, EXTRA_SEAT_PRICES } = require('../config/stripePrices');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const APP_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

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

    // Check for pending plan change (subscription schedule from portal-initiated changes)
    let pendingPlanChange = null;
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
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
    let existingSub = await Subscription.findOne({ organizationId: orgId });
    let customerId = existingSub?.stripeCustomerId;

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
    }

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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      payment_method_collection: 'if_required',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/settings/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/settings/billing/plans`,
      metadata: {
        organizationId: orgId.toString(),
        userId: user._id.toString(),
      },
      subscription_data: {
        metadata: {
          organizationId: orgId.toString(),
          userId: user._id.toString(),
        },
      },
    });

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

    // If reducing seats, ensure we don't go below currently occupied extra seats
    if (qty < (sub.purchasedExtraSeats || 0)) {
      const memberCount = await OrgMember.countDocuments({
        organizationId: orgId,
        locked: { $ne: true },
      });
      const totalSeats = memberCount + 1; // +1 for owner
      const baseSeats = config.maxSeats || 0;
      const occupiedExtraSeats = Math.max(0, totalSeats - baseSeats);

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

    sub.purchasedExtraSeats = qty;
    sub.extraSeatsUpdatedAt = new Date();
    await sub.save();

    clearTierCache();
    applyLocksForOrg(orgId).catch((err) =>
      console.error(`[downgradeService] extra seats lock error for org=${orgId}:`, err.message)
    );

    res.json({
      extraSeats: qty,
      effectiveMaxSeats: (config.maxSeats || 0) + qty,
      pricePerSeat: config.extraSeatPrice,
      monthlyCost: config.extraSeatPrice * qty,
    });
  } catch (error) {
    console.error('Update extra seats error:', error);
    res.status(500).json({ error: 'Failed to update extra seats' });
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
};
