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
const WorkspaceUsageTracker = require('../models/WorkspaceUsageTracker');
const tierService = require('./tierService');
const workspaceQuotaService = require('./workspaceQuotaService');
const { resolveCredits } = require('../config/creditRules');

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

  // Phase 17 (DARK): resolve client-billing BEFORE the transaction (read-only
  // reference data, not session-bound). Returns null unless saasMode is live AND
  // metadata.workspaceId names a client-billed workspace — so with the flag dark
  // wsBilled is always null and every branch below is byte-identical to pre-P17.
  let wsBilled = null;
  if (metadata.workspaceId) {
    const limits = await workspaceQuotaService.resolveWorkspacePlanLimits(metadata.workspaceId);
    if (limits) {
      wsBilled = {
        workspaceId: metadata.workspaceId,
        creditsLimit: limits.creditsPerMonth ?? null, // null = unlimited on the plan
        period: tierService.getPeriod('monthly'),
      };
    }
  }

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

      // Phase 17 (DARK): hard-cap a client-billed workspace at its plan's monthly
      // credit allocation. Checked INSIDE the txn against the committed counter so
      // concurrent generations can't race past the cap. Throws → callers already
      // map preDeduct errors to 402. Inert when wsBilled is null (flag dark).
      if (wsBilled?.creditsLimit != null) {
        const wsRow = await WorkspaceUsageTracker.findOne(
          { workspaceId: wsBilled.workspaceId, period: wsBilled.period }
        ).session(session);
        const wsUsed = wsRow?.creditsUsed || 0;
        if (wsUsed + amount > wsBilled.creditsLimit) {
          throw new Error('Insufficient credits: client plan monthly limit reached');
        }
      }

      // Three-way split: subscription → org purchased → user free (personal
      // credits last). B1: a client-billed workspace draws ONLY from the agency's
      // org pool — never a member's personal free credits (the agency is billing
      // a client for this work), so user_free is excluded from the overflow.
      const fromSubscription = Math.min(subEffective, amount);
      let remaining = amount - fromSubscription;
      const fromOrgGeneral = Math.min(orgGeneralAvail, remaining);
      remaining -= fromOrgGeneral;
      const fromUserFree = wsBilled ? 0 : Math.min(userFreeAvail, remaining);
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

      // Phase 17 (DARK): mirror the consumption onto the client-billed workspace's
      // own counter, in the SAME transaction, so the monthly cap stays accurate.
      if (wsBilled) {
        await WorkspaceUsageTracker.findOneAndUpdate(
          { workspaceId: wsBilled.workspaceId, period: wsBilled.period },
          { $inc: { creditsUsed: totalDeducted } },
          { upsert: true, new: true, setDefaultsOnInsert: true, session }
        );
      }

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

      // Carry the workspace period on each pooled tx so settle/refund can mirror
      // the reversal onto the workspace counter (only present when client-billed).
      const logMeta = wsBilled
        ? { ...metadata, feature, estimatedTotal: amount, groupId, wsBilledPeriod: wsBilled.period }
        : { ...metadata, feature, estimatedTotal: amount, groupId };

      if (fromSubscription > 0) {
        const tx = await safeLog({
          orgId,
          userId,
          type: 'deduction',
          amount: -fromSubscription,
          pool: 'subscription',
          description: `${feature}: ${amount} credits`,
          metadata: logMeta,
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
          metadata: logMeta,
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
          metadata: logMeta,
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
    // Refund POOLS in reverse deduction order: user free → org purchased →
    // subscription. Bounded by what was actually recorded (a dropped tx log
    // can't be refunded to its pool — see the counter note below).
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
  }

  // Correct the usage counters by the TRUE over-charge (estimate − actual), based
  // on the authoritative deducted amount captured at preDeduct time — NOT the sum
  // of the persisted pool txs. preDeduct always deducts exactly `estimatedTotal`
  // (it throws if the pools can't cover it) and increments the counters by that
  // in-transaction, but the pool tx logs are best-effort: a dropped log would make
  // a persisted-sum-based reversal short (or skip it entirely when the dropped tx
  // was the excess), permanently over-counting creditsUsed against both the org
  // tier and the workspace cap. Basing the counter reversal on estimatedTotal is
  // exact in the normal case and self-healing when a log is lost. (Legacy txs
  // without the marker fall back to the persisted total.)
  const authDeducted = tx.metadata?.estimatedTotal ?? totalDeducted;
  const counterRefund = Math.max(0, authDeducted - actualAmount);
  if (counterRefund > 0) {
    if (tx.organizationId) {
      const { config } = await tierService.getOrgTierConfig(tx.organizationId);
      const period = tierService.getPeriod(config?.creditLimitType || 'monthly');
      await UsageTracker.increment(tx.organizationId, 'creditsUsed', period, -counterRefund);
    }
    // Phase 17 (DARK): mirror onto the client-billed workspace counter (present
    // only when preDeduct tagged the group as client-billed).
    const wsId = tx.metadata?.workspaceId;
    const wsPeriod = tx.metadata?.wsBilledPeriod;
    if (wsId && wsPeriod) {
      await WorkspaceUsageTracker.increment(wsId, 'creditsUsed', wsPeriod, -counterRefund);
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

  // Fully reverse the usage counters by the AUTHORITATIVE deducted amount captured
  // at preDeduct time — not the persisted pool sum — so a dropped best-effort tx
  // log can't leave creditsUsed over-counted against the org tier or workspace cap.
  // Normal case: authDeducted === totalRefunded (identical to before). Legacy txs
  // without the marker fall back to the persisted sum.
  const authDeducted = tx.metadata?.estimatedTotal ?? totalRefunded;
  if (authDeducted > 0 && tx.organizationId) {
    const { config } = await tierService.getOrgTierConfig(tx.organizationId);
    const period = tierService.getPeriod(config?.creditLimitType || 'monthly');
    await UsageTracker.increment(tx.organizationId, 'creditsUsed', period, -authDeducted);

    // Phase 17 (DARK): mirror on the client-billed workspace counter.
    const wsId = tx.metadata?.workspaceId;
    const wsPeriod = tx.metadata?.wsBilledPeriod;
    if (wsId && wsPeriod) {
      await WorkspaceUsageTracker.increment(wsId, 'creditsUsed', wsPeriod, -authDeducted);
    }
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

  const now = new Date();
  credit.subscriptionCredits = amount;
  credit.subscriptionCreditsExpireAt = expiresAt || null;
  credit.lastResetAt = now;
  // Phase 7: stamp the current month so the monthly cron / renewal path won't
  // ALSO grant this month (this REPLACE grant is used by initial checkout +
  // plan-change; the recurring path is grantMonthlyCreditsIfDue).
  credit.creditPeriodKey = monthKey(now);
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
 * Idempotent general-credit grant for one-time PURCHASES (credit packs).
 *
 * Money-safety invariant: the balance change (Credit $inc) and its
 * ledger/idempotency marker (a `purchase` CreditTransaction carrying
 * `metadata.stripeSessionId`) are committed in ONE MongoDB transaction, so no
 * crash, error, or Stripe redelivery between the two can ever grant twice or
 * grant-without-recording. The unique partial index on
 * `metadata.stripeSessionId` (see CreditTransaction) is the concurrency gate:
 * if two webhook deliveries race, the loser's marker insert throws 11000 and
 * its whole transaction aborts — the grant is rolled back with it.
 *
 * `idempotencyKey` is the dedup key (the Stripe checkout session id).
 * Returns { granted, alreadyFulfilled, balanceAfter }.
 */
async function grantGeneralCreditsIdempotent(orgId, amount, description, opts = {}) {
  const { idempotencyKey, userId = null, meta = {} } = opts;
  if (!idempotencyKey) throw new Error('grantGeneralCreditsIdempotent requires an idempotencyKey');
  if (!amount || amount <= 0) return { granted: false, alreadyFulfilled: false, balanceAfter: 0 };

  // Fast path: cheap dedup for the ordinary redelivery case. The unique index
  // is the real guarantee for the concurrent-delivery case.
  const existing = await CreditTransaction.findOne({ 'metadata.stripeSessionId': idempotencyKey }).lean();
  if (existing) return { granted: false, alreadyFulfilled: true, balanceAfter: 0 };

  const session = await mongoose.startSession();
  try {
    let balanceAfter = 0;
    await session.withTransaction(async () => {
      const updated = await Credit.findOneAndUpdate(
        { organizationId: orgId },
        { $inc: { generalCredits: amount }, $set: { lowBalanceNotifiedAt: null } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );
      balanceAfter = updated.generalCredits;
      // Marker + ledger entry in the SAME transaction. The unique index on
      // metadata.stripeSessionId aborts a racing duplicate right here.
      await CreditTransaction.create(
        [
          {
            organizationId: orgId,
            userId,
            type: 'purchase',
            amount,
            pool: 'general',
            description,
            metadata: { stripeSessionId: idempotencyKey, ...meta },
            balanceAfter,
            status: 'confirmed',
          },
        ],
        { session }
      );
    });
    console.log(`[creditService] Purchase granted ${amount} general credits for org ${orgId} (key=${idempotencyKey})`);
    return { granted: true, alreadyFulfilled: false, balanceAfter };
  } catch (err) {
    if (require('../utils/mongoErrors').isDuplicateKeyError(err)) {
      // A concurrent delivery won the race and committed the marker first —
      // already fulfilled, not an error. The aborted txn rolled back our grant.
      // (A duplicate-key inside a transaction can surface via writeErrors[],
      // not just top-level err.code — see isDuplicateKeyError.)
      return { granted: false, alreadyFulfilled: true, balanceAfter: 0 };
    }
    throw err; // transient DB error → propagate so the caller lets Stripe retry
  } finally {
    session.endSession();
  }
}

/**
 * Expire remaining subscription credits (on cancellation or before renewal).
 */
/**
 * Calendar-month key ("YYYY-MM", UTC) — the monthly-grant idempotency bucket.
 * UTC so the boundary is deterministic regardless of server timezone.
 */
function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Phase 7 — grant the monthly subscription allocation with ONE-MONTH ROLLOVER,
 * idempotent per calendar month. This is the recurring grant path (renewal
 * webhook + monthly cron); it makes yearly plans still grant every month.
 *
 * Rollover ("increment-with-expiry, not replace"): unused subscription credits
 * carry into the new month, CAPPED at one month's allocation, and take the new
 * period's expiry — so at most `amount` rolls over and it lives one more month.
 *   newBalance = min(currentUnexpired, amount) + amount        (≤ 2× amount)
 *
 * Idempotency + concurrency: an aggregation-pipeline `findOneAndUpdate` filtered
 * on `creditPeriodKey !== thisMonth` both (a) computes the rollover from the
 * CURRENT in-DB balance atomically — so a concurrent deduction is never lost to
 * a stale read — and (b) lets only ONE caller win per month (a racing
 * webhook+cron: the loser's filter misses). Returns { granted, ... }.
 *
 * Expiry is a ~1-month rollover window computed from `now` (start of the month
 * AFTER next, UTC) — NOT the Stripe billing-period end. This is what keeps a
 * YEARLY plan's credits expiring monthly instead of hoarding a year's worth: the
 * monthly grant cadence, not the invoice cadence, drives expiry. (The rollover
 * CAP — min(old, amount) — is the hard bound on the balance regardless.)
 *
 * @param {string} orgId
 * @param {number} amount     the tier's creditsPerMonth
 * @param {object} [opts]
 *   @param {Date}   [opts.now]        injectable clock (tests / cron); default new Date()
 *   @param {Date}   [opts.expiresAt]  override the computed rollover expiry (tests)
 */
async function grantMonthlyCreditsIfDue(orgId, amount, opts = {}) {
  if (!amount || amount <= 0) return { granted: false, reason: 'zero_amount' };
  const now = opts.now || new Date();
  // Start of the month after next → gives this month + one rollover month before
  // expiry, with a safe buffer so the NEXT monthly grant still sees these credits
  // as unexpired and can roll them over (a tighter "start of next month" would
  // expire them at the exact moment of the next grant).
  const expiresAt = opts.expiresAt !== undefined
    ? opts.expiresAt
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  const periodKey = monthKey(now);

  await getOrCreateCredit(orgId); // ensure the doc exists for the update below

  // {new:false} → returns the PRE-update doc (or null if the filter missed, i.e.
  // already granted this month). The $set pipeline computes the rollover in-DB.
  const pre = await Credit.findOneAndUpdate(
    { organizationId: orgId, creditPeriodKey: { $ne: periodKey } },
    [
      {
        $set: {
          subscriptionCredits: {
            $add: [
              amount,
              {
                $min: [
                  amount,
                  {
                    // current balance, but 0 if it already expired
                    $cond: [
                      {
                        $or: [
                          { $eq: [{ $ifNull: ['$subscriptionCreditsExpireAt', null] }, null] },
                          { $gt: ['$subscriptionCreditsExpireAt', now] },
                        ],
                      },
                      { $ifNull: ['$subscriptionCredits', 0] },
                      0,
                    ],
                  },
                ],
              },
            ],
          },
          subscriptionCreditsExpireAt: expiresAt,
          lastResetAt: now,
          creditPeriodKey: periodKey,
          lowBalanceNotifiedAt: null,
        },
      },
    ],
    { new: false }
  );

  if (!pre) return { granted: false, reason: 'already_granted', period: periodKey };

  // Mirror the pipeline math in JS for the ledger entry + return value.
  const priorUnexpired = (!pre.subscriptionCreditsExpireAt || pre.subscriptionCreditsExpireAt > now)
    ? (pre.subscriptionCredits || 0)
    : 0;
  const rolledOver = Math.min(priorUnexpired, amount);
  const balanceAfter = rolledOver + amount;

  await CreditTransaction.logTransaction({
    orgId,
    type: 'subscription_grant',
    amount,
    pool: 'subscription',
    description: `Monthly credits granted (${periodKey}${rolledOver ? `, +${rolledOver} rolled over` : ''})`,
    metadata: { period: periodKey, rolledOver, expiresAt },
    balanceAfter,
  }).catch((e) => console.error('[creditService] monthly grant log failed:', e.message));

  console.log(`[creditService] Monthly grant ${amount} (+${rolledOver} rollover) for org ${orgId} [${periodKey}]`);
  return { granted: true, amount, rolledOver, balanceAfter, period: periodKey };
}

async function expireSubscriptionCredits(orgId) {
  const credit = await getOrCreateCredit(orgId);
  const expired = credit.subscriptionCredits;

  if (expired <= 0) return { expired: 0 };

  credit.subscriptionCredits = 0;
  credit.subscriptionCreditsExpireAt = null;
  // Phase 7: clear the monthly-grant idempotency marker so a resubscribe in the
  // same calendar month re-grants (grantMonthlyCreditsIfDue keys on this).
  credit.creditPeriodKey = null;
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
      orgId, // Phase 11 sender identity
      data: {
        userName: owner.profile?.name || 'there',
        remainingCredits: String(balance),
        planName: tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Free',
      },
    };
    await applyCustomTemplate('credits_low', emailOptions, orgId);
    if (!emailOptions.subject) return;
    await sendEmail(emailOptions);
    console.log(`[creditService] credits_low email sent to ${owner.email} for org ${orgId} (balance=${balance})`);
  } catch (err) {
    console.error(`[creditService] Low-balance notify failed for org ${orgId}:`, err.message);
  }
}

/**
 * Finalized post-success deduction for request/response actions (Phase 6).
 *
 * WHY preDeduct + settle (not a bare preDeduct): preDeduct lands the tx in
 * `status: 'pending'`. The 30-min orphan-sweep (index.js) refunds ANY pending
 * tx it finds — it can't know the operation actually succeeded — so a bare
 * preDeduct is silently reversed after 30 min, making the action free. settle()
 * with actual == reserved refunds 0 and transitions the group to 'settled',
 * putting it out of the sweep's reach.
 *
 * Best-effort by design: the operation already ran and its result was delivered,
 * so a deduction failure (balance moved since the pre-flight gate, DB blip) must
 * NOT throw back into the response path. It logs and returns { deducted: 0 }.
 * The requireCredits gate's pre-flight 402 makes the insufficient case rare.
 *
 * @param {object} req  request carrying req.creditContext (from requireCredits)
 * @param {object} [opts]
 * @param {number} [opts.credits]  override amount for variable-cost actions
 *   (e.g. keyword lookup priced per delivered row); defaults to the
 *   gate-resolved req.creditContext.estimatedCredits.
 * @param {object} [opts.metadata]  extra tx metadata (merged into feature meta)
 * @returns {Promise<{deducted:number, error?:string}>}
 */
async function deductForRequest(req, { credits, metadata = {} } = {}) {
  const cc = req?.creditContext;
  if (!cc?.deductionEnabled) return { deducted: 0 };
  const amount = credits != null ? credits : cc.estimatedCredits;
  if (!amount || amount <= 0) return { deducted: 0 };
  try {
    const { transactionId } = await preDeduct(
      cc.orgId,
      cc.userId || req.user?.userId,
      amount,
      cc.featureKey,
      { feature: cc.featureKey, workspaceId: cc.workspaceId, ...metadata }
    );
    // Finalize immediately so the orphan-sweep can't refund it. A null tx id
    // means preDeduct short-circuited on amount<=0 (already handled above).
    if (transactionId) await settle(transactionId, amount);
    return { deducted: amount };
  } catch (e) {
    console.error('[credit] deductForRequest failed (non-fatal):', e.message);
    return { deducted: 0, error: e.message };
  }
}

/**
 * Post-hoc finalized charge for an action that runs OUTSIDE a requireCredits
 * gate — e.g. fire-and-forget background AI (avatar preview regen) that must not
 * block the foreground request (the avatar's field edits already saved). Resolves
 * the org tier + deduction flag itself, checks affordability, then preDeduct +
 * settle (orphan-sweep safe).
 *
 * Returns { deducted, charged, reason }:
 *  - charged:true  → caller SHOULD proceed with the AI work. Either credits were
 *    deducted, or deduction is legitimately off for this org/feature (no org,
 *    flag disabled, zero cost) — those must not block the work.
 *  - charged:false → caller should SKIP the AI work: the org can't afford it, so
 *    running it would be free. Lets the caller degrade gracefully (mark stale).
 *
 * @param {string} action  key in creditCosts
 * @param {object} p
 *   @param {string} p.orgId
 *   @param {string} [p.userId]
 *   @param {string} [p.workspaceId]
 *   @param {object} [p.ctx]       extra resolveCredits context (rows, tokens…)
 *   @param {object} [p.metadata]  extra tx metadata
 */
async function chargeAction(action, { orgId, userId, workspaceId, ctx = {}, metadata = {} } = {}) {
  if (!orgId) return { deducted: 0, charged: true, reason: 'no_org' };
  let config; let tier;
  try {
    ({ config, tier } = await tierService.getOrgTierConfig(orgId));
  } catch (e) {
    // Can't resolve tier → don't hold the AI work hostage to a lookup blip.
    return { deducted: 0, charged: true, reason: 'tier_lookup_failed' };
  }
  if (!config || !isFeatureEnabled(config, action)) {
    return { deducted: 0, charged: true, reason: 'disabled' };
  }
  let amount;
  try {
    amount = resolveCredits(action, { tier, ...ctx });
  } catch (e) {
    // Inactive/unknown action → fail OPEN (never charge a wrong amount).
    console.error('[credit] chargeAction resolve failed (non-fatal):', e.message);
    return { deducted: 0, charged: true, reason: 'resolve_failed' };
  }
  if (!amount || amount <= 0) return { deducted: 0, charged: true, reason: 'zero' };

  // Affordability pre-check mirrors the requireCredits gate (org pools + the
  // triggering member's personal free credits). Insufficient → skip the AI work.
  const balance = await getBalance(orgId, userId);
  if (balance.total < amount) return { deducted: 0, charged: false, reason: 'insufficient' };

  try {
    const { transactionId } = await preDeduct(orgId, userId, amount, action, {
      feature: action, workspaceId, ...metadata,
    });
    if (transactionId) await settle(transactionId, amount); // finalize (refund 0)
    return { deducted: amount, charged: true, reason: 'ok' };
  } catch (e) {
    // Lost the race for the last credits between the check and the deduct.
    console.error('[credit] chargeAction deduct failed:', e.message);
    return { deducted: 0, charged: false, reason: 'deduct_failed' };
  }
}

/**
 * Affordability check for an action WITHOUT deducting — the pre-gate for
 * background AI that is charged POST-success (avatar preview regen). We must not
 * run the paid AI for an org that can't afford the charge, but we also can't
 * finalize the charge until the work succeeds; this splits the two so the caller
 * can: pre-check → generate → chargeAction only on success. Mirrors chargeAction's
 * resolution exactly. Returns { ok, reason }:
 *   ok:true  → affordable, OR deduction legitimately off (no-org/disabled/zero).
 *   ok:false → org can't afford it → caller SKIPS the AI work.
 */
async function canAffordAction(action, { orgId, userId, ctx = {} } = {}) {
  if (!orgId) return { ok: true, reason: 'no_org' };
  let config; let tier;
  try {
    ({ config, tier } = await tierService.getOrgTierConfig(orgId));
  } catch (e) {
    return { ok: true, reason: 'tier_lookup_failed' };
  }
  if (!config || !isFeatureEnabled(config, action)) return { ok: true, reason: 'disabled' };
  let amount;
  try {
    amount = resolveCredits(action, { tier, ...ctx });
  } catch (e) {
    return { ok: true, reason: 'resolve_failed' };
  }
  if (!amount || amount <= 0) return { ok: true, reason: 'zero' };
  const balance = await getBalance(orgId, userId);
  return balance.total >= amount
    ? { ok: true, reason: 'affordable' }
    : { ok: false, reason: 'insufficient' };
}

/**
 * F4-13 — refund orphaned pending CreditTransactions.
 *
 * When a scan crashes between preDeduct and settle (process kill, OOM,
 * server restart), the pre-deducted credits stay locked in `pending`
 * forever. This sweep refunds every pending tx older than the cutoff,
 * releasing the debit. refund() is group-aware and idempotent (F10-01/02
 * atomic claims), so sweeping the same orphan twice — or racing a live
 * settle — refunds at most once.
 *
 * Extracted from the inline startup/cron blocks in index.js (test plan
 * Phase 3) so the sweep is testable and single-sourced; both callers and
 * the credits test suite invoke THIS function.
 *
 * @returns {{ scanned: number, refundedGroups: number, failed: number }}
 */
async function sweepOrphanedPendingCredits({ olderThanMs = 30 * 60 * 1000, logPrefix = '[credit-sweep]' } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const orphans = await CreditTransaction.find({
    status: 'pending',
    createdAt: { $lt: cutoff },
  }).select('_id').lean();

  let refundedGroups = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      const result = await refund(orphan._id.toString());
      if (result.refunded > 0) refundedGroups++;
    } catch (e) {
      failed++;
      console.error(`${logPrefix} refund failed for tx ${orphan._id}:`, e.message);
    }
  }
  if (refundedGroups > 0) {
    console.log(`${logPrefix} refunded ${refundedGroups} orphaned credit transaction group(s)`);
  }
  return { scanned: orphans.length, refundedGroups, failed };
}

module.exports = {
  wordsToCredits,
  deductForRequest,
  chargeAction,
  canAffordAction,
  isFeatureEnabled,
  getOrCreateCredit,
  getBalance,
  canAfford,
  preDeduct,
  settle,
  refund,
  sweepOrphanedPendingCredits,
  grantFreeCredits,
  grantFreeCreditsIfNew,
  grantSubscriptionCredits,
  grantMonthlyCreditsIfDue,
  grantGeneralCredits,
  grantGeneralCreditsIdempotent,
  expireSubscriptionCredits,
  monthKey,
};
