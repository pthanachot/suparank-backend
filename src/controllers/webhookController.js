const Stripe = require('stripe');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const UsageTracker = require('../models/UsageTracker');
const Session = require('../models/Session');
const OrgMember = require('../models/OrgMember');
const Workspace = require('../models/Workspace');
const { clearTierCache, getOrgTierConfig, getTierConfig } = require('../services/tierService');
const { applyLocksForOrg } = require('../services/downgradeService');
const creditService = require('../services/creditService');
const { getPlanFromPriceId, EXTRA_SEAT_PRICE_SET } = require('../config/stripePrices');
const { applyCustomTemplate } = require('./emailPortalController');
const { sendEmail } = require('../utils/emailService');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    const org = await Organization.findById(organizationId).lean();
    const owner = org?.ownerId ? await User.findById(org.ownerId).lean() : null;
    if (!owner?.email || owner.preferences?.emailNotifications === false) return;

    const emailOptions = {
      to: owner.email,
      data: { userName: owner.profile?.name || 'there', ...data },
    };
    await applyCustomTemplate(triggerId, emailOptions);
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

  // Grant subscription credits for new plan
  try {
    const { config } = await getOrgTierConfig(organizationId);
    if (config?.creditsPerMonth) {
      const periodEnd = parseStripeDate(subItem?.current_period_end || stripeSub.current_period_end);
      await creditService.grantSubscriptionCredits(organizationId, config.creditsPerMonth, periodEnd || null);
      console.log(`[credits] Granted ${config.creditsPerMonth} credits for org=${organizationId}`);
    }
  } catch (err) {
    console.error(`[credits] Failed to grant on checkout for org=${organizationId}:`, err.message);
  }

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

  // Detect plan change for credit pro-rating
  const oldPlanId = sub.planId;
  const isPlanChange = planId && oldPlanId && planId !== oldPlanId;

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

  // Expire remaining subscription credits
  try {
    await creditService.expireSubscriptionCredits(sub.organizationId);
    console.log(`[credits] Expired credits for canceled org=${sub.organizationId}`);
  } catch (err) {
    console.error(`[credits] Failed to expire on cancel for org=${sub.organizationId}:`, err.message);
  }

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

  // Send cancellation email via triggerable template
  try {
    const org = await Organization.findById(sub.organizationId).lean();
    const owner = org?.ownerId ? await User.findById(org.ownerId).lean() : null;
    if (owner?.email && owner.preferences?.emailNotifications !== false) {
      const planName = sub.planId ? sub.planId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Your Plan';
      const endDate = sub.currentPeriodEnd
        ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : 'N/A';
      const emailOptions = {
        to: owner.email,
        data: {
          userName: owner.profile?.name || 'there',
          planName,
          endDate,
        },
      };
      await applyCustomTemplate('subscription_canceled', emailOptions);
      await sendEmail(emailOptions);
      console.log(`[email] Cancellation email sent to ${owner.email} for org=${sub.organizationId}`);
    }
  } catch (err) {
    console.error(`[email] Failed to send cancellation email for org=${sub.organizationId}:`, err.message);
  }

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

  // Grant credits on subscription renewal (not initial checkout)
  if (invoice.billing_reason === 'subscription_cycle') {
    try {
      const { config } = await getOrgTierConfig(sub.organizationId);
      if (config?.creditsPerMonth) {
        await creditService.expireSubscriptionCredits(sub.organizationId);
        const newPeriodEnd = parseStripeDate(invoice.lines?.data?.[0]?.period?.end);
        await creditService.grantSubscriptionCredits(sub.organizationId, config.creditsPerMonth, newPeriodEnd || null);
        console.log(`[credits] Renewed ${config.creditsPerMonth} credits for org=${sub.organizationId}`);
      }
    } catch (err) {
      console.error(`[credits] Failed to renew credits for org=${sub.organizationId}:`, err.message);
    }
  }

  // Payment confirmation email via triggerable template
  await notifyOrgOwner(sub.organizationId, 'payment_confirmation', {
    planName: formatPlanName(sub.planId),
    amount: `$${((invoice.amount_paid || 0) / 100).toFixed(2)} ${(invoice.currency || 'usd').toUpperCase()}`,
    nextBillingDate: formatEmailDate(
      parseStripeDate(invoice.lines?.data?.[0]?.period?.end) || sub.currentPeriodEnd
    ),
  });

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

  // Payment failed notification via triggerable template
  await notifyOrgOwner(sub.organizationId, 'payment_failed', {
    planName: formatPlanName(sub.planId),
    retryDate: invoice.next_payment_attempt
      ? formatEmailDate(parseStripeDate(invoice.next_payment_attempt))
      : 'soon',
    updatePaymentUrl: `${process.env.FRONTEND_URL || 'https://app.suparank.ai'}/settings/billing`,
  });

  console.log(`Payment failed: sub=${invoice.subscription}`);
}

module.exports = { handleWebhook };
