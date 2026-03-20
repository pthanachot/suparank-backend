const Stripe = require('stripe');
const User = require('../models/User');
const Subscription = require('../models/Subscription');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const APP_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Map Stripe price IDs to internal plan IDs
const PRICE_TO_PLAN = {
  [process.env.STRIPE_STANDARD_MONTHLY_PRICE_ID || 'price_1TCaMYPViW8Lznb8OykrDOqY']: 'standard-monthly',
  [process.env.STRIPE_STANDARD_YEARLY_PRICE_ID || 'price_1TCaMYPViW8Lznb8SOYEOsk2']: 'standard-yearly',
  [process.env.STRIPE_PRO_MONTHLY_PRICE_ID || 'price_1TCaUDPViW8Lznb8599QuBfr']: 'pro-monthly',
  [process.env.STRIPE_PRO_YEARLY_PRICE_ID || 'price_1TCaUDPViW8Lznb86MXvgr4Z']: 'pro-yearly',
};

function getPlanFromPriceId(priceId) {
  return PRICE_TO_PLAN[priceId] || null;
}

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

// ─── GET SUBSCRIPTION ─────────────────────────────────────────

const getSubscription = async (req, res) => {
  try {
    // Only return real, active subscriptions (must have a Stripe subscription ID and plan)
    let sub = await Subscription.findOne({
      userId: req.user.userId,
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
        console.log(`Refreshed missing dates from Stripe for user=${req.user.userId}`);
      } catch (err) {
        console.error('Failed to refresh dates from Stripe:', err.message);
      }
    }

    // Fallback: if no local record, check Stripe directly and sync
    if (!sub) {
      const user = await User.findById(req.user.userId);
      if (user?.stripeCustomerId) {
        const stripeSubs = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
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
              { userId: req.user.userId },
              {
                userId: req.user.userId,
                stripeCustomerId: user.stripeCustomerId,
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
            console.log(`Synced subscription from Stripe: user=${req.user.userId} plan=${planId}`);
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
    const { priceId } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: 'Price ID is required' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.profile?.name || undefined,
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    // Block checkout if user already has an active subscription
    const existingSub = await Subscription.findOne({
      userId: user._id,
      status: { $in: ['active', 'trialing'] },
      stripeSubscriptionId: { $exists: true, $ne: null },
    });

    if (existingSub) {
      return res.status(400).json({
        error: 'You already have an active subscription. Please cancel your current plan first to switch plans.',
        existingSubscription: {
          planId: existingSub.planId,
          status: existingSub.status,
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
        error: 'You already have an active subscription. Please cancel your current plan first to switch plans.',
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
        userId: user._id.toString(),
      },
      subscription_data: {
        metadata: {
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
    const { flow } = req.body || {};

    const user = await User.findById(req.user.userId);
    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const portalParams = {
      customer: user.stripeCustomerId,
      return_url: `${APP_URL}/settings/billing`,
    };

    // If flow is 'subscription_update', go directly to plan switching
    if (flow === 'subscription_update') {
      const sub = await Subscription.findOne({
        userId: user._id,
        status: { $in: ['active', 'trialing'] },
        stripeSubscriptionId: { $exists: true, $ne: null },
      });

      if (sub) {
        // Release any pending schedule first — Stripe blocks flow_data when a schedule exists
        try {
          const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
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
            subscription: sub.stripeSubscriptionId,
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

module.exports = {
  getSubscription,
  createCheckoutSession,
  createCustomerPortal,
};
