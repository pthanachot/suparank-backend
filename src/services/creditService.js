/**
 * Credit service — central credit management for SupaRank.
 *
 * Three credit pools, two levels:
 *
 *   USER-LEVEL (personal, shared across all orgs the user belongs to):
 *     - UserCredit.freeCredits: granted once on account creation, never expire.
 *
 *   ORG-LEVEL (shared by all members of the org):
 *     - Credit.subscriptionCredits: expire at billing cycle end.
 *     - Credit.generalCredits: purchased credits, promos — never expire.
 *
 * Deduction priority: org subscription → user free → org purchased.
 * Refunds go back to whichever pool they came from.
 *
 * 1 credit = 50 words of AI-generated content.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const Credit = require('../models/Credit');
const UserCredit = require('../models/UserCredit');
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
 * Get combined credit balance (org + user free credits).
 *
 * @param {string} orgId
 * @param {string} [userId] - if provided, includes user's free credits in total
 * @returns {{ subscription: number, general: number, userFree: number, total: number, expiresAt: Date|null }}
 */
async function getBalance(orgId, userId = null) {
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

  // Fetch user free credits if userId provided
  let userFree = 0;
  if (userId) {
    const userCredit = await UserCredit.findOne({ userId }).lean();
    userFree = userCredit?.freeCredits || 0;
  }

  return {
    subscription: credit.subscriptionCredits,
    general: credit.generalCredits,
    userFree,
    total: credit.subscriptionCredits + userFree + credit.generalCredits,
    expiresAt: credit.subscriptionCreditsExpireAt,
  };
}

/**
 * Check if organization + user can afford a credit cost.
 */
async function canAfford(orgId, amount, userId = null) {
  const { total } = await getBalance(orgId, userId);
  return total >= amount;
}

// ─── User free credit grants ────────────────────────────────

/**
 * Grant free credits to a user. Sets grantedAt on first grant.
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string} [description]
 */
async function grantFreeCredits(userId, amount, description = 'Free-tier initial credits') {
  if (!amount || amount <= 0) return;

  const updated = await UserCredit.findOneAndUpdate(
    { userId },
    {
      $inc: { freeCredits: amount },
      $setOnInsert: { grantedAt: new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // If grantedAt wasn't set by $setOnInsert (doc already existed), set it now if null
  if (!updated.grantedAt) {
    updated.grantedAt = new Date();
    await updated.save();
  }

  await CreditTransaction.logTransaction({
    orgId: null,
    userId,
    type: 'general_grant',
    amount,
    pool: 'user_free',
    description,
    balanceAfter: updated.freeCredits,
  });

  console.log(`[creditService] Granted ${amount} free credits to user ${userId}`);
}

/**
 * Idempotent free credit grant — only grants if user has never received free credits.
 *
 * @param {string} userId
 * @param {number} amount
 */
async function grantFreeCreditsIfNew(userId, amount) {
  const existing = await UserCredit.findOne({ userId }).lean();
  if (existing?.grantedAt) return; // already granted
  await grantFreeCredits(userId, amount);
}

// ─── Pre-deduction (three-way split) ────────────────────────

const MAX_TX_RETRIES = 3;

/**
 * Pre-deduct credits (reserve for a pending operation).
 *
 * Deduction order: org subscription → org purchased → user free.
 * Uses a MongoDB transaction for cross-collection atomicity.
 *
 * @param {string} orgId
 * @param {string} userId - user who triggered the operation
 * @param {number} amount - credits to deduct
 * @param {string} feature - feature key (e.g. 'aiChat')
 * @param {object} [metadata] - extra context
 * @returns {{ transactionId: string, deducted: number, balanceAfter: object }}
 */
async function preDeduct(orgId, userId, amount, feature, metadata = {}) {
  if (amount <= 0) {
    return { transactionId: null, deducted: 0, balanceAfter: { subscription: 0, general: 0, userFree: 0 } };
  }

  // F10-01: stable group identifier so settle/refund can find ALL pending txs
  // from this deduction across pools, regardless of their (slightly different)
  // createdAt timestamps. Pre-fix the related-tx query used `createdAt: tx.createdAt`
  // (exact equality), which only matched the queried tx because each sequential
  // logTransaction call produced a different timestamp.
  const groupId = crypto.randomUUID();

  for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const credit = await Credit.findOne({ organizationId: orgId }).session(session);
      const userCredit = userId
        ? await UserCredit.findOne({ userId }).session(session)
        : null;

      const subAvail = credit?.subscriptionCredits || 0;
      const userFreeAvail = userCredit?.freeCredits || 0;
      const orgGeneralAvail = credit?.generalCredits || 0;

      // Auto-expire subscription credits
      let subEffective = subAvail;
      if (credit?.subscriptionCreditsExpireAt && new Date() > credit.subscriptionCreditsExpireAt) {
        subEffective = 0;
      }

      // Three-way split: subscription → org purchased → user free (personal credits last)
      const fromSubscription = Math.min(subEffective, amount);
      let remaining = amount - fromSubscription;
      const fromOrgGeneral = Math.min(orgGeneralAvail, remaining);
      remaining -= fromOrgGeneral;
      const fromUserFree = Math.min(userFreeAvail, remaining);
      const totalDeducted = fromSubscription + fromUserFree + fromOrgGeneral;

      if (totalDeducted < amount) {
        throw new Error('Insufficient credits');
      }

      // Atomic decrements within the transaction
      if (credit && (fromSubscription > 0 || fromOrgGeneral > 0)) {
        const subExpired = subAvail - subEffective; // credits lost to expiry
        await Credit.findOneAndUpdate(
          { organizationId: orgId },
          {
            $inc: {
              subscriptionCredits: -(fromSubscription + subExpired),
              generalCredits: -fromOrgGeneral,
            },
            ...(subExpired > 0 ? { $set: { subscriptionCreditsExpireAt: null } } : {}),
          },
          { session }
        );
      }

      if (fromUserFree > 0 && userId) {
        await UserCredit.findOneAndUpdate(
          { userId },
          { $inc: { freeCredits: -fromUserFree } },
          { session }
        );
      }

      // F10-03: include UsageTracker.creditsUsed increment INSIDE the same
      // transaction so a deduction and its usage entry commit-or-fail together.
      // Pre-fix the increment ran AFTER session.commitTransaction(); a DB blip on
      // the increment left credits deducted but usage counter never raised, and
      // the eventual orphan refund (line 487) then DECREMENTED a never-raised
      // counter, driving creditsUsed NEGATIVE and silently letting users
      // exceed their monthly quota until the period rolled over.
      const { config } = await tierService.getOrgTierConfig(orgId);
      const limitType = config?.creditLimitType || 'monthly';
      const period = tierService.getPeriod(limitType);
      await UsageTracker.findOneAndUpdate(
        { organizationId: orgId, period },
        { $inc: { creditsUsed: totalDeducted } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      await session.commitTransaction();
      session.endSession();

      // Log transactions AFTER commit (one per pool touched). Audit log
      // failures here are informational only — the balance + usage commit is
      // already durable. Wrap each in try/catch so a log hiccup doesn't
      // propagate and confuse the caller about the deduction's success.
      const transactions = [];
      const safeLog = async (params) => {
        try {
          return await CreditTransaction.logTransaction(params);
        } catch (logErr) {
          console.error('[creditService] preDeduct audit log failed:', logErr.message);
          return null;
        }
      };

      if (fromSubscription > 0) {
        const tx = await safeLog({
          orgId,
          userId,
          type: 'deduction',
          amount: -fromSubscription,
          pool: 'subscription',
          description: `${feature}: ${amount} credits`,
          metadata: { ...metadata, feature, estimatedTotal: amount, groupId },
          balanceAfter: subEffective - fromSubscription,
          status: 'pending',
        });
        if (tx) transactions.push(tx);
      }

      if (fromUserFree > 0) {
        const tx = await safeLog({
          orgId,
          userId,
          type: 'deduction',
          amount: -fromUserFree,
          pool: 'user_free',
          description: `${feature}: ${amount} credits`,
          metadata: { ...metadata, feature, estimatedTotal: amount, groupId },
          balanceAfter: userFreeAvail - fromUserFree,
          status: 'pending',
        });
        if (tx) transactions.push(tx);
      }

      if (fromOrgGeneral > 0) {
        const tx = await safeLog({
          orgId,
          userId,
          type: 'deduction',
          amount: -fromOrgGeneral,
          pool: 'general',
          description: `${feature}: ${amount} credits`,
          metadata: { ...metadata, feature, estimatedTotal: amount, groupId },
          balanceAfter: orgGeneralAvail - fromOrgGeneral,
          status: 'pending',
        });
        if (tx) transactions.push(tx);
      }

      return {
        transactionId: transactions[0]?._id?.toString() || null,
        deducted: totalDeducted,
        balanceAfter: {
          subscription: subEffective - fromSubscription,
          userFree: userFreeAvail - fromUserFree,
          general: orgGeneralAvail - fromOrgGeneral,
        },
      };
    } catch (err) {
      await session.abortTransaction();
      session.endSession();

      // Retry on transient transaction errors (write conflicts)
      if (err.hasErrorLabel?.('TransientTransactionError') && attempt < MAX_TX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }
}

// ─── Pool-aware refund helper ───────────────────────────────

/**
 * Refund credits back to the pool they were deducted from.
 * @param {object} tx - CreditTransaction document
 * @param {number} refundAmount
 */
async function _refundToPool(tx, refundAmount) {
  if (refundAmount <= 0) return;

  // F10-04 + F10-05: single roundtrip for credit + balance read via `{ new: true }`,
  // and wrap the audit log in try/catch so a log failure doesn't propagate (the
  // balance is the source of truth; the log is informational, eventually
  // reconstructable from balanceAfter snapshots).
  const safeLog = async (params) => {
    try {
      await CreditTransaction.logTransaction(params);
    } catch (logErr) {
      console.error('[creditService] refund audit log failed:', logErr.message);
    }
  };

  if (tx.pool === 'user_free' && tx.userId) {
    const updated = await UserCredit.findOneAndUpdate(
      { userId: tx.userId },
      { $inc: { freeCredits: refundAmount } },
      { new: true }
    );
    await safeLog({
      orgId: tx.organizationId,
      userId: tx.userId,
      type: 'refund',
      amount: refundAmount,
      pool: 'user_free',
      description: 'Refund to user free credits',
      metadata: { feature: tx.metadata?.feature },
      balanceAfter: updated?.freeCredits || 0,
      relatedTransactionId: tx._id,
    });
  } else if (tx.pool === 'subscription' && tx.organizationId) {
    const updated = await Credit.findOneAndUpdate(
      { organizationId: tx.organizationId },
      { $inc: { subscriptionCredits: refundAmount } },
      { new: true }
    );
    await safeLog({
      orgId: tx.organizationId,
      userId: tx.userId,
      type: 'refund',
      amount: refundAmount,
      pool: 'subscription',
      description: 'Refund to subscription credits',
      metadata: { feature: tx.metadata?.feature },
      balanceAfter: updated?.subscriptionCredits || 0,
      relatedTransactionId: tx._id,
    });
  } else if (tx.organizationId) {
    // 'general' pool (org purchased credits)
    const updated = await Credit.findOneAndUpdate(
      { organizationId: tx.organizationId },
      { $inc: { generalCredits: refundAmount } },
      { new: true }
    );
    await safeLog({
      orgId: tx.organizationId,
      userId: tx.userId,
      type: 'refund',
      amount: refundAmount,
      pool: 'general',
      description: 'Refund to org purchased credits',
      metadata: { feature: tx.metadata?.feature },
      balanceAfter: updated?.generalCredits || 0,
      relatedTransactionId: tx._id,
    });
  }
}

// ─── Settle / Refund ────────────────────────────────────────

/**
 * Settle a pending pre-deduction with actual credit cost.
 *
 * If actual < estimated: refund difference back to each pool proportionally.
 *
 * @param {string} transactionId - the original pending transaction ID
 * @param {number} actualAmount - the real credit cost
 * @returns {{ refunded: number }}
 */
async function settle(transactionId, actualAmount) {
  if (!transactionId) return { refunded: 0 };

  // F10-02: atomic claim. Pre-fix `findById` + `if status !== 'pending' return`
  // was a check-then-act race — a concurrent settle/orphan-refund could BOTH
  // read 'pending', both call _refundToPool's unconditional $inc, and double-
  // credit the user. Now we use findOneAndUpdate to atomically transition the
  // primary tx into a temp 'settling' state; if someone else got there first
  // the filter doesn't match and we return cleanly.
  const tx = await CreditTransaction.findOneAndUpdate(
    { _id: transactionId, status: 'pending' },
    { $set: { status: 'settling' } },
    { new: true }
  );
  if (!tx) return { refunded: 0 };

  // F10-01: prefer the stable groupId from metadata; fall back to the legacy
  // createdAt query for transactions that predate the groupId rollout.
  const groupId = tx.metadata?.groupId;
  const relatedFilter = groupId
    ? { 'metadata.groupId': groupId }
    : {
        'metadata.estimatedTotal': tx.metadata?.estimatedTotal,
        createdAt: tx.createdAt,
        $or: [
          { organizationId: tx.organizationId },
          { userId: tx.userId, pool: 'user_free' },
        ],
      };

  // F10-02: atomic claim of related txs too. updateMany returns modifiedCount;
  // the primary tx is already 'settling' so it isn't re-claimed.
  await CreditTransaction.updateMany(
    { ...relatedFilter, _id: { $ne: tx._id }, status: 'pending' },
    { $set: { status: 'settling' } }
  );
  // Fetch the full claimed set (primary + relatives) for processing.
  const relatedTxs = await CreditTransaction.find({ ...relatedFilter, status: 'settling' });

  const totalDeducted = relatedTxs.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  let refundRemaining = Math.max(0, totalDeducted - actualAmount);

  if (refundRemaining > 0) {
    // Refund in reverse deduction order: user free → org purchased → subscription
    const refundOrder = [...relatedTxs].sort((a, b) => {
      const order = { user_free: 0, general: 1, subscription: 2 };
      return (order[a.pool] ?? 9) - (order[b.pool] ?? 9);
    });

    for (const rtx of refundOrder) {
      if (refundRemaining <= 0) break;
      const amt = Math.min(Math.abs(rtx.amount), refundRemaining);
      await _refundToPool(rtx, amt);
      refundRemaining -= amt;
    }

    // Decrement UsageTracker for the refunded total
    const totalRefunded = Math.max(0, totalDeducted - actualAmount);
    if (tx.organizationId) {
      const { config } = await tierService.getOrgTierConfig(tx.organizationId);
      const limitType = config?.creditLimitType || 'monthly';
      const period = tierService.getPeriod(limitType);
      await UsageTracker.increment(tx.organizationId, 'creditsUsed', period, -totalRefunded);
    }
  }

  // Mark all claimed transactions as settled
  await CreditTransaction.updateMany(
    { _id: { $in: relatedTxs.map((t) => t._id) } },
    { $set: { status: 'settled' } }
  );

  // Fire-and-forget low balance check now that the deduction is final
  maybeNotifyLowBalance(tx.organizationId);

  return { refunded: Math.max(0, totalDeducted - actualAmount) };
}

/**
 * Full refund of a pending pre-deduction (operation failed/aborted).
 *
 * Refunds each pool's portion back to that pool.
 *
 * @param {string} transactionId
 * @returns {{ refunded: number }}
 */
async function refund(transactionId) {
  if (!transactionId) return { refunded: 0 };

  // F10-02: atomic claim — see settle() for full rationale. Note we only claim
  // when status is 'pending'; an already-settled or already-refunded tx is
  // not re-processed.
  const tx = await CreditTransaction.findOneAndUpdate(
    { _id: transactionId, status: 'pending' },
    { $set: { status: 'refunding' } },
    { new: true }
  );
  if (!tx) return { refunded: 0 };

  // F10-01: groupId-aware related-tx lookup with legacy fallback.
  const groupId = tx.metadata?.groupId;
  const relatedFilter = groupId
    ? { 'metadata.groupId': groupId }
    : {
        'metadata.estimatedTotal': tx.metadata?.estimatedTotal,
        createdAt: tx.createdAt,
        $or: [
          { organizationId: tx.organizationId },
          { userId: tx.userId, pool: 'user_free' },
        ],
      };

  await CreditTransaction.updateMany(
    { ...relatedFilter, _id: { $ne: tx._id }, status: 'pending' },
    { $set: { status: 'refunding' } }
  );
  const relatedTxs = await CreditTransaction.find({ ...relatedFilter, status: 'refunding' });

  let totalRefunded = 0;
  for (const rtx of relatedTxs) {
    const amt = Math.abs(rtx.amount);
    await _refundToPool(rtx, amt);
    totalRefunded += amt;
  }

  if (totalRefunded > 0 && tx.organizationId) {
    // Decrement UsageTracker for the refunded amount
    const { config } = await tierService.getOrgTierConfig(tx.organizationId);
    const limitType = config?.creditLimitType || 'monthly';
    const period = tierService.getPeriod(limitType);
    await UsageTracker.increment(tx.organizationId, 'creditsUsed', period, -totalRefunded);
  }

  // Mark all claimed transactions as refunded
  await CreditTransaction.updateMany(
    { _id: { $in: relatedTxs.map((t) => t._id) } },
    { $set: { status: 'refunded' } }
  );

  return { refunded: totalRefunded };
}

// ─── Subscription / org-level grants ────────────────────────

/**
 * Grant subscription credits for a billing cycle.
 * REPLACES the current subscription balance (not additive).
 */
async function grantSubscriptionCredits(orgId, amount, expiresAt) {
  const credit = await getOrCreateCredit(orgId);

  credit.subscriptionCredits = amount;
  credit.subscriptionCreditsExpireAt = expiresAt || null;
  credit.lastResetAt = new Date();
  credit.lowBalanceNotifiedAt = null; // re-arm the credits_low notification
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
 * Grant general (non-expiring) credits to an org — for purchases and promos.
 * ADDITIVE — adds to existing balance.
 */
async function grantGeneralCredits(orgId, amount, description = 'General credits granted') {
  if (!amount || amount <= 0) return;

  const updated = await Credit.findOneAndUpdate(
    { organizationId: orgId },
    { $inc: { generalCredits: amount }, $set: { lowBalanceNotifiedAt: null } },
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

// ─── Low-balance notification ───────────────────────────────

const LOW_BALANCE_FLOOR = 50; // fire below this many credits when tier has no monthly allotment

/**
 * Fire the credits_low email once per low period. Anti-spam via
 * Credit.lowBalanceNotifiedAt — set here, cleared when credits are granted.
 * Never throws; called fire-and-forget from settle().
 */
async function maybeNotifyLowBalance(orgId) {
  try {
    if (!orgId) return;
    const { getSettings } = require('./systemSettingsService');
    if (getSettings().emailNotificationsEnabled === false) return;
    const credit = await Credit.findOne({ organizationId: orgId });
    if (!credit || credit.lowBalanceNotifiedAt) return;

    const balance = credit.subscriptionCredits + credit.generalCredits;
    const { tier, config } = await tierService.getOrgTierConfig(orgId);
    const threshold = config?.creditsPerMonth
      ? Math.max(Math.floor(config.creditsPerMonth * 0.2), LOW_BALANCE_FLOOR)
      : LOW_BALANCE_FLOOR;
    if (balance >= threshold) return;

    // Set the flag before sending so a send failure can't cause a retry storm.
    credit.lowBalanceNotifiedAt = new Date();
    await credit.save();

    // Lazy requires — keeps the service loadable without the controller layer.
    const Organization = require('../models/Organization');
    const User = require('../models/User');
    const { applyCustomTemplate } = require('../controllers/emailPortalController');
    const { sendEmail } = require('../utils/emailService');

    const org = await Organization.findById(orgId).lean();
    const owner = org?.ownerId ? await User.findById(org.ownerId).lean() : null;
    if (!owner?.email || owner.preferences?.emailNotifications === false) return;

    const emailOptions = {
      to: owner.email,
      data: {
        userName: owner.profile?.name || 'there',
        remainingCredits: String(balance),
        planName: tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Free',
      },
    };
    await applyCustomTemplate('credits_low', emailOptions);
    if (!emailOptions.subject) return;
    await sendEmail(emailOptions);
    console.log(`[creditService] credits_low email sent to ${owner.email} for org ${orgId} (balance=${balance})`);
  } catch (err) {
    console.error(`[creditService] Low-balance notify failed for org ${orgId}:`, err.message);
  }
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
  grantFreeCredits,
  grantFreeCreditsIfNew,
  grantSubscriptionCredits,
  grantGeneralCredits,
  expireSubscriptionCredits,
};
