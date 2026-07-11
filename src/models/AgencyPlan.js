const mongoose = require('mongoose');

/**
 * AgencyPlan (Phase 16) — a subscription plan an agency defines for its clients.
 *
 * The agency (an Organization on the `agency` tier with `custom.saasMode`) owns
 * a connected Stripe account (Connect Standard). The Stripe product and price
 * backing a plan live ON THE AGENCY'S CONNECTED ACCOUNT, not the platform
 * account — `stripeProductId` / `stripePriceId` are ids in the connected
 * account's namespace. Clients paying for a plan pay the agency directly; this
 * money flow never touches the platform credit system.
 *
 * `amount` is in the smallest currency unit (CENTS for usd).
 */
const agencyPlanSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
      // The AGENCY that owns this plan.
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      default: '',
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      // Price in the smallest currency unit (CENTS for usd). e.g. 4900 = $49.00
    },
    currency: {
      type: String,
      default: 'usd',
      lowercase: true,
    },
    interval: {
      type: String,
      enum: ['month', 'year'],
      default: 'month',
    },
    // Stripe ids CREATED ON THE AGENCY'S CONNECTED ACCOUNT (not the platform).
    stripeProductId: { type: String, default: null },
    stripePriceId: { type: String, default: null },

    // Per-plan usage limits. null = unlimited for that dimension.
    limits: {
      maxArticlesPerMonth: { type: Number, default: null },
      maxAiTrackerPromptsPerMonth: { type: Number, default: null },
      maxKeywordLookupsPerMonth: { type: Number, default: null },
      maxAuditsPerMonth: { type: Number, default: null },
      creditsPerMonth: { type: Number, default: null },
      maxSeats: { type: Number, default: null },
    },

    trialDays: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

agencyPlanSchema.index({ organizationId: 1, active: 1 });

module.exports = mongoose.model('AgencyPlan', agencyPlanSchema);
