/**
 * Credit service — central credit management for SupaRank.
 *
 * Two credit pools per organization:
 *   - subscriptionCredits: expire at billing cycle end
 *   - generalCredits: never expire
 *
 * Deduction priority: subscription first, then general.
 * Refunds always go to general pool.
 *
 * 1 credit = 50 words of AI-generated content.
 */

const Credit = require('../models/Credit');
const CreditTransaction = require('../models/CreditTransaction');
const UsageTracker = require('../models/UsageTracker');
const tierService = require('./tierService');

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Convert word count to credit cost.
 * @param {number} wordCount
 * @returns {number} credits (minimum 1 if wordCount > 0)
 */
function wordsToCredits(wordCount) {
  if (!wordCount || wordCount <= 0) return 0;
  return Math.ceil(wordCount / 50);
}

/**
 * Check if credit deduction is enabled for a feature on this tier.
 * @param {object} tierConfig - TierConfig document (with .custom field)
 * @param {string} featureKey - e.g. 'aiChat', 'contentAudit'
 * @returns {boolean} true if deduction is enabled (defaults true if flag undefined)
 */
function isFeatureEnabled(tierConfig, featureKey) {
  if (!tierConfig?.custom?.creditDeductionFlags) return true;
  const flag = tierConfig.custom.creditDeductionFlags[featureKey];
  return flag !== false; // undefined or true → enabled
}

// ─── Core operations ─────────────────────────────────────────

/**
 * Get or create a Credit document for an organization.
 */
async function getOrCreateCredit(orgId) {
  return Credit.getOrCreateForOrg(orgId);
}

/**
 * Get credit balance for an organization.
 * @returns {{ subscription: number, general: number, total: number, expiresAt: Date|null }}
 */
async function getBalance(orgId) {
  const credit = await getOrCreateCredit(orgId);

  // Auto-expire subscription credits if past expiration date
  if (credit.subscriptionCreditsExpireAt && new Date() > credit.subscriptionCreditsExpireAt) {
    const expired = credit.subscriptionCredits;
    if (expired > 0) {
      credit.subscriptionCredits = 0;
      credit.subscriptionCreditsExpireAt = null;
      await credit.save();

      await CreditTransaction.logTransaction({
        orgId,
        type: 'expiration',
        amount: -expired,
        pool: 'subscription',
        description: 'Subscription credits expired (auto)',
        balanceAfter: 0,
      });
    }
  }

  return {
    subscription: credit.subscriptionCredits,
    general: credit.generalCredits,
    total: credit.subscriptionCredits + credit.generalCredits,
    expiresAt: credit.subscriptionCreditsExpireAt,
  };
}

/**
 * Check if organization can afford a credit cost.
 */
async function canAfford(orgId, amount) {
  const { total } = await getBalance(orgId);
  return total >= amount;
}

/**
 * Pre-deduct credits (reserve for a pending operation).
 *
 * Deducts from subscription first, then general.
 * Creates a CreditTransaction with status='pending'.
 * Also increments UsageTracker.creditsUsed.
 *
 * @param {string} orgId
 * @param {string} userId - user who triggered the operation
 * @param {number} amount - credits to deduct
 * @param {string} feature - feature key (e.g. 'aiChat')
 * @param {object} [metadata] - extra context
 * @returns {{ transactionId: string, deducted: number, balanceAfter: { subscription: number, general: number } }}
 */
async function preDeduct(orgId, userId, amount, feature, metadata = {}) {
  if (amount <= 0) {
    return { transactionId: null, deducted: 0, balanceAfter: { subscription: 0, general: 0 } };
  }

  // Read current balance (getBalance auto-expires if needed)
  const credit = await getOrCreateCredit(orgId);

  // Auto-expire if past date
  if (credit.subscriptionCreditsExpireAt && new Date() > credit.subscriptionCreditsExpireAt) {
    credit.subscriptionCredits = 0;
    credit.subscriptionCreditsExpireAt = null;
  }

  // Calculate split: subscription first, then general
  const fromSubscription = Math.min(credit.subscriptionCredits, amount);
  const fromGeneral = Math.min(credit.generalCredits, amount - fromSubscription);
  const totalDeducted = fromSubscription + fromGeneral;

  if (totalDeducted <= 0) {
    throw new Error('Insufficient credits');
  }

  // Atomic deduction using $inc (prevents race conditions)
  const updated = await Credit.findOneAndUpdate(
    {
      organizationId: orgId,
      subscriptionCredits: { $gte: fromSubscription },
      generalCredits: { $gte: fromGeneral },
    },
    {
      $inc: {
        subscriptionCredits: -fromSubscription,
        generalCredits: -fromGeneral,
      },
    },
    { new: true }
  );

  if (!updated) {
    // Race condition: balance changed between read and update
    throw new Error('Insufficient credits (concurrent deduction)');
  }

  // Log transactions — one per pool touched
  const transactions = [];

  if (fromSubscription > 0) {
    const tx = await CreditTransaction.logTransaction({
      orgId,
      userId,
      type: 'deduction',
      amount: -fromSubscription,
      pool: 'subscription',
      description: `${feature}: ${amount} credits`,
      metadata: { ...metadata, feature, estimatedTotal: amount },
      balanceAfter: updated.subscriptionCredits,
      status: 'pending',
    });
    transactions.push(tx);
  }

  if (fromGeneral > 0) {
    const tx = await CreditTransaction.logTransaction({
      orgId,
      userId,
      type: 'deduction',
      amount: -fromGeneral,
      pool: 'general',
      description: `${feature}: ${amount} credits`,
      metadata: { ...metadata, feature, estimatedTotal: amount },
      balanceAfter: updated.generalCredits,
      status: 'pending',
    });
    transactions.push(tx);
  }

  // Increment UsageTracker.creditsUsed
  const { config } = await tierService.getOrgTierConfig(orgId);
  const limitType = config?.creditLimitType || 'monthly';
  const period = tierService.getPeriod(limitType);
  await UsageTracker.increment(orgId, 'creditsUsed', period, totalDeducted);

  return {
    transactionId: transactions[0]?._id?.toString() || null,
    deducted: totalDeducted,
    balanceAfter: {
      subscription: updated.subscriptionCredits,
      general: updated.generalCredits,
    },
  };
}

/**
 * Settle a pending pre-deduction with actual credit cost.
 *
 * If actual < estimated: refund the difference to general pool.
 * Marks the original transaction as 'settled'.
 *
 * @param {string} transactionId - the original pending transaction ID
 * @param {number} actualAmount - the real credit cost
 * @returns {{ refunded: number }}
 */
async function settle(transactionId, actualAmount) {
  if (!transactionId) return { refunded: 0 };

  const tx = await CreditTransaction.findById(transactionId);
  if (!tx || tx.status !== 'pending') return { refunded: 0 };

  // Get the total estimated amount from all related transactions
  const relatedTxs = await CreditTransaction.find({
    organizationId: tx.organizationId,
    status: 'pending',
    'metadata.estimatedTotal': tx.metadata?.estimatedTotal,
    createdAt: tx.createdAt,
  });

  const totalDeducted = relatedTxs.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const refundAmount = Math.max(0, totalDeducted - actualAmount);

  if (refundAmount > 0) {
    // Refund difference to general pool
    await Credit.findOneAndUpdate(
      { organizationId: tx.organizationId },
      { $inc: { generalCredits: refundAmount } }
    );

    const credit = await Credit.findOne({ organizationId: tx.organizationId }).lean();

    await CreditTransaction.logTransaction({
      orgId: tx.organizationId,
      userId: tx.userId,
      type: 'refund',
      amount: refundAmount,
      pool: 'general',
      description: `Settlement refund: estimated ${totalDeducted}, actual ${actualAmount}`,
      metadata: { feature: tx.metadata?.feature, actualAmount },
      balanceAfter: credit?.generalCredits || 0,
      relatedTransactionId: tx._id,
    });

    // Decrement UsageTracker for the refunded amount
    const { config } = await tierService.getOrgTierConfig(tx.organizationId);
    const limitType = config?.creditLimitType || 'monthly';
    const period = tierService.getPeriod(limitType);
    await UsageTracker.increment(tx.organizationId, 'creditsUsed', period, -refundAmount);
  }

  // Mark all related pending transactions as settled
  await CreditTransaction.updateMany(
    { _id: { $in: relatedTxs.map((t) => t._id) } },
    { $set: { status: 'settled' } }
  );

  return { refunded: refundAmount };
}

/**
 * Full refund of a pending pre-deduction (operation failed/aborted).
 *
 * Adds refund to general pool. Marks original as 'refunded'.
 *
 * @param {string} transactionId
 * @returns {{ refunded: number }}
 */
async function refund(transactionId) {
  if (!transactionId) return { refunded: 0 };

  const tx = await CreditTransaction.findById(transactionId);
  if (!tx || tx.status === 'refunded') return { refunded: 0 };

  // Get all related pending transactions (subscription + general)
  const relatedTxs = await CreditTransaction.find({
    organizationId: tx.organizationId,
    status: 'pending',
    'metadata.estimatedTotal': tx.metadata?.estimatedTotal,
    createdAt: tx.createdAt,
  });

  const totalToRefund = relatedTxs.reduce((sum, t) => sum + Math.abs(t.amount), 0);

  if (totalToRefund > 0) {
    // Refund to general pool
    await Credit.findOneAndUpdate(
      { organizationId: tx.organizationId },
      { $inc: { generalCredits: totalToRefund } }
    );

    const credit = await Credit.findOne({ organizationId: tx.organizationId }).lean();

    await CreditTransaction.logTransaction({
      orgId: tx.organizationId,
      userId: tx.userId,
      type: 'refund',
      amount: totalToRefund,
      pool: 'general',
      description: `Full refund: operation failed/aborted`,
      metadata: { feature: tx.metadata?.feature, originalAmount: totalToRefund },
      balanceAfter: credit?.generalCredits || 0,
      relatedTransactionId: tx._id,
    });

    // Decrement UsageTracker for the refunded amount
    const { config } = await tierService.getOrgTierConfig(tx.organizationId);
    const limitType = config?.creditLimitType || 'monthly';
    const period = tierService.getPeriod(limitType);
    await UsageTracker.increment(tx.organizationId, 'creditsUsed', period, -totalToRefund);
  }

  // Mark all related transactions as refunded
  await CreditTransaction.updateMany(
    { _id: { $in: relatedTxs.map((t) => t._id) } },
    { $set: { status: 'refunded' } }
  );

  return { refunded: totalToRefund };
}

/**
 * Grant subscription credits for a billing cycle.
 *
 * REPLACES the current subscription balance (not additive).
 * Call expireSubscriptionCredits() first if there's an old balance.
 *
 * @param {string} orgId
 * @param {number} amount - credits to grant
 * @param {Date|null} expiresAt - when these credits expire (null = lifetime/never)
 */
async function grantSubscriptionCredits(orgId, amount, expiresAt) {
  const credit = await getOrCreateCredit(orgId);

  credit.subscriptionCredits = amount;
  credit.subscriptionCreditsExpireAt = expiresAt || null;
  credit.lastResetAt = new Date();
  await credit.save();

  await CreditTransaction.logTransaction({
    orgId,
    type: 'subscription_grant',
    amount,
    pool: 'subscription',
    description: expiresAt
      ? `Subscription credits granted (expires ${expiresAt.toISOString().slice(0, 10)})`
      : 'Subscription credits granted (lifetime)',
    metadata: { expiresAt },
    balanceAfter: amount,
  });

  console.log(`[creditService] Granted ${amount} subscription credits for org ${orgId}`);
}

/**
 * Grant general (non-expiring) credits — used for free-tier initial grant, promos, purchases.
 *
 * ADDITIVE — adds to existing general balance (does not overwrite).
 *
 * @param {string} orgId
 * @param {number} amount
 * @param {string} [description]
 */
async function grantGeneralCredits(orgId, amount, description = 'General credits granted') {
  if (!amount || amount <= 0) return;

  const updated = await Credit.findOneAndUpdate(
    { organizationId: orgId },
    { $inc: { generalCredits: amount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  await CreditTransaction.logTransaction({
    orgId,
    type: 'general_grant',
    amount,
    pool: 'general',
    description,
    balanceAfter: updated.generalCredits,
  });

  console.log(`[creditService] Granted ${amount} general credits for org ${orgId}`);
}

/**
 * Expire remaining subscription credits (on cancellation or before renewal).
 *
 * @param {string} orgId
 * @returns {{ expired: number }}
 */
async function expireSubscriptionCredits(orgId) {
  const credit = await getOrCreateCredit(orgId);
  const expired = credit.subscriptionCredits;

  if (expired <= 0) return { expired: 0 };

  credit.subscriptionCredits = 0;
  credit.subscriptionCreditsExpireAt = null;
  await credit.save();

  await CreditTransaction.logTransaction({
    orgId,
    type: 'expiration',
    amount: -expired,
    pool: 'subscription',
    description: `Subscription credits expired (${expired} credits)`,
    balanceAfter: 0,
  });

  console.log(`[creditService] Expired ${expired} subscription credits for org ${orgId}`);
  return { expired };
}

module.exports = {
  wordsToCredits,
  isFeatureEnabled,
  getOrCreateCredit,
  getBalance,
  canAfford,
  preDeduct,
  settle,
  refund,
  grantSubscriptionCredits,
  grantGeneralCredits,
  expireSubscriptionCredits,
};
