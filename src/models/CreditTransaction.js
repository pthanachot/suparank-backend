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
      required: true,
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
      enum: ['deduction', 'subscription_grant', 'purchase', 'refund', 'adjustment', 'expiration'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      // Positive for grants/purchases/refunds, negative for deductions.
    },
    pool: {
      type: String,
      enum: ['subscription', 'purchased'],
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
      enum: ['confirmed', 'pending', 'settled', 'refunded'],
      default: 'confirmed',
      // 'pending' = pre-deduction waiting for settle
      // 'settled' = pre-deduction confirmed with actual amount
      // 'refunded' = pre-deduction was fully refunded
      // 'confirmed' = immediate deduction (no reserve phase)
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
