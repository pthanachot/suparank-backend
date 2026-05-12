const Stripe = require('stripe');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const { clearTierCache } = require('../services/tierService');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
  console.log(`Checkout completed: org=${organizationId} plan=${planId}`);
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

  if (planId) sub.planId = planId;

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

  await sub.save();
  clearTierCache();
  console.log(`Subscription updated: sub=${stripeSub.id} status=${stripeSub.status}`);
}

async function handleSubscriptionDeleted(stripeSub) {
  const sub = await Subscription.findOne({
    stripeSubscriptionId: stripeSub.id,
  });
  if (!sub) return;

  sub.status = 'canceled';
  sub.canceledAt = sub.canceledAt || new Date();
  await sub.save();

  clearTierCache();
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

  console.log(`Payment failed: sub=${invoice.subscription}`);
}

module.exports = { handleWebhook };
