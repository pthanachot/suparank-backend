const mongoose = require('mongoose');

/**
 * CreditTransaction — audit log of every credit change.
 *
 * Every deduction, grant, purchase, and refund creates a transaction record.
 * Required for: usage analytics, billing disputes, credit history page.
 */

const creditTransactionSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // The user who triggered the action. Null for system actions (grants, expiry).
      default: null,
    },
    type: {
      type: String,
      enum: ['deduction', 'subscription_grant', 'general_grant', 'purchase', 'refund', 'adjustment', 'expiration'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      // Positive for grants/purchases/refunds, negative for deductions.
    },
    pool: {
      type: String,
      enum: ['subscription', 'general', 'user_free'],
      required: true,
      // Which credit pool was affected.
    },
    description: {
      type: String,
      default: '',
      // e.g., "AI generation: 450 words (9 credits)", "Monthly subscription grant"
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      // Arbitrary context: { contentId, wordCount, feature: 'aiChat' }
    },
    balanceAfter: {
      type: Number,
      default: 0,
      // Snapshot of pool balance after this transaction.
    },
    status: {
      type: String,
      enum: ['confirmed', 'pending', 'settling', 'refunding', 'settled', 'refunded'],
      default: 'confirmed',
      // 'pending'    = pre-deduction waiting for settle
      // 'settling'   = atomic claim by settle() in progress (F10-02)
      // 'refunding'  = atomic claim by refund() in progress (F10-02)
      // 'settled'    = pre-deduction confirmed with actual amount
      // 'refunded'   = pre-deduction was fully refunded
      // 'confirmed'  = immediate deduction (no reserve phase)
    },
    relatedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CreditTransaction',
      default: null,
      // Links a refund/settlement to the original pending transaction.
    },
  },
  { timestamps: true }
);

creditTransactionSchema.index({ organizationId: 1, createdAt: -1 });

// Money-safety: at most ONE transaction may carry a given Stripe checkout
// session id. This unique partial index is the concurrency gate for
// idempotent one-time purchases (grantGeneralCreditsIdempotent) — a racing
// duplicate webhook delivery fails to insert its marker (11000) and its
// transaction aborts, so credits can never be granted twice for one payment.
// Partial so the vast majority of transactions (no stripeSessionId) are exempt.
creditTransactionSchema.index(
  { 'metadata.stripeSessionId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'metadata.stripeSessionId': { $exists: true } },
  }
);

/**
 * Create a transaction record.
 */
creditTransactionSchema.statics.logTransaction = function (params) {
  return this.create({
    organizationId: params.orgId,
    userId: params.userId || null,
    type: params.type,
    amount: params.amount,
    pool: params.pool,
    description: params.description || '',
    metadata: params.metadata || {},
    balanceAfter: params.balanceAfter ?? 0,
    status: params.status || 'confirmed',
    relatedTransactionId: params.relatedTransactionId || null,
  });
};

module.exports = mongoose.model('CreditTransaction', creditTransactionSchema);
