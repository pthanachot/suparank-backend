const mongoose = require('mongoose');

/**
 * Credit — tracks current credit balance per organization.
 *
 * TODO: Not yet implemented. This is a placeholder model.
 *
 * Credits: 1 credit = 50 words of AI-generated content.
 * Two pools:
 *   - subscriptionCredits: granted each billing cycle, expire at cycle end.
 *   - purchasedCredits: bought via credit packs, never expire.
 *
 * See TierConfig for per-tier credit allotments.
 * See acequiz-backend/src/models/Credit.js for the reference implementation.
 */

const creditSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      unique: true,
    },
    subscriptionCredits: {
      type: Number,
      default: 0,
      min: 0,
      // Expiring credits — reset each billing cycle based on TierConfig.creditsPerMonth.
    },
    purchasedCredits: {
      type: Number,
      default: 0,
      min: 0,
      // Non-expiring credits — purchased via credit packs.
    },
    subscriptionCreditsExpireAt: {
      type: Date,
      default: null,
      // When subscription credits expire (end of current billing period).
    },
    lastResetAt: {
      type: Date,
      default: null,
      // When subscription credits were last granted.
    },
  },
  { timestamps: true }
);

// TODO: Add instance methods:
//   deductCredits(amount)  — subscription first, then purchased
//   canAfford(amount)      — check if total balance >= amount
//   resetSubscriptionCredits(amount, expiresAt) — grant new cycle credits
//
// TODO: Add static methods:
//   getOrCreateForOrg(orgId)
//   expireAllExpiredCredits()  — batch job

creditSchema.index({ subscriptionCreditsExpireAt: 1 });

module.exports = mongoose.model('Credit', creditSchema);
