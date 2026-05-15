const mongoose = require('mongoose');

/**
 * Credit — tracks current credit balance per organization.
 *
 * Credits: 1 credit = 50 words of AI-generated content.
 * Two pools:
 *   - subscriptionCredits: granted each billing cycle, expire at cycle end.
 *   - generalCredits: free-tier grant, purchases, promos — never expire.
 *
 * See TierConfig for per-tier credit allotments.
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
    generalCredits: {
      type: Number,
      default: 0,
      min: 0,
      // Non-expiring credits — free-tier grant, purchases, promos.
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

// ─── Instance methods ────────────────────────────────────────

/**
 * Total balance across both pools.
 */
creditSchema.methods.totalBalance = function () {
  return this.subscriptionCredits + this.generalCredits;
};

// ─── Static methods ──────────────────────────────────────────

/**
 * Get or create credit document for an organization.
 * Uses upsert so it's safe to call concurrently.
 */
creditSchema.statics.getOrCreateForOrg = function (orgId) {
  return this.findOneAndUpdate(
    { organizationId: orgId },
    { $setOnInsert: { organizationId: orgId, subscriptionCredits: 0, generalCredits: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

creditSchema.index({ subscriptionCreditsExpireAt: 1 });

module.exports = mongoose.model('Credit', creditSchema);
