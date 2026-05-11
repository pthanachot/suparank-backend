const mongoose = require('mongoose');

/**
 * CreditTransaction — audit log of every credit change.
 *
 * TODO: Not yet implemented. This is a placeholder model.
 *
 * Every deduction, grant, purchase, and refund creates a transaction record.
 * Required for: usage analytics, billing disputes, credit history page.
 *
 * See acequiz-backend/src/models/CreditTransaction.js for the reference implementation.
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
      required: true,
      // The user who triggered the action.
    },
    type: {
      type: String,
      enum: ['deduction', 'subscription_grant', 'purchase', 'refund', 'adjustment', 'expiration'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      // Positive for grants/purchases, negative for deductions.
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
  },
  { timestamps: true }
);

creditTransactionSchema.index({ organizationId: 1, createdAt: -1 });

// TODO: Add static method:
//   logTransaction({ orgId, userId, type, amount, pool, description, metadata })

module.exports = mongoose.model('CreditTransaction', creditTransactionSchema);
