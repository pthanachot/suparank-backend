const mongoose = require('mongoose');

/**
 * UserCredit — tracks a user's personal free credit balance.
 *
 * One document per user (across all organisations they belong to).
 * Free credits are granted once on account creation and never expire.
 * They are personal — no other user can spend them.
 *
 * Purchased and subscription credits live on the org-level Credit model.
 */

const userCreditSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    freeCredits: {
      type: Number,
      default: 0,
      min: 0,
    },
    grantedAt: {
      type: Date,
      default: null,
      // Set on first grant — used for idempotency (prevent re-granting).
    },
  },
  { timestamps: true }
);

/**
 * Get or create a UserCredit document. Safe for concurrent calls.
 */
userCreditSchema.statics.getOrCreateForUser = function (userId) {
  return this.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, freeCredits: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('UserCredit', userCreditSchema);
