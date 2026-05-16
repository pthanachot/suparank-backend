const mongoose = require('mongoose');

/**
 * UserUsageTracker — per-user lifetime usage counters.
 *
 * One document per user. Always tracks lifetime usage (no period field).
 * These counters are personal — they track what this specific user has
 * consumed, shared across all organisations they belong to.
 *
 * Monthly/org-level usage stays on the UsageTracker model.
 */

const userUsageTrackerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    // ── Counters (same keys as UsageTracker for compatibility) ──
    articlesCreated: { type: Number, default: 0 },
    keywordSearches: { type: Number, default: 0 },
    auditsRun: { type: Number, default: 0 },
    aiTrackerPromptsCreated: { type: Number, default: 0 },
    creditsUsed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ─── Static helpers ─────────────────────────────────────────────

/**
 * Atomically increment a counter. Creates the document if it doesn't exist.
 * @param {ObjectId|string} userId
 * @param {string} counterKey - e.g. 'articlesCreated'
 * @param {number} [amount=1]
 * @returns {Promise<object>} The updated document
 */
userUsageTrackerSchema.statics.increment = function (userId, counterKey, amount = 1) {
  return this.findOneAndUpdate(
    { userId },
    { $inc: { [counterKey]: amount } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Get the current value of a single counter.
 * @returns {Promise<number>}
 */
userUsageTrackerSchema.statics.getCount = async function (userId, counterKey) {
  const doc = await this.findOne({ userId })
    .select(counterKey)
    .lean();
  return doc?.[counterKey] ?? 0;
};

/**
 * Get the full usage document (or null).
 */
userUsageTrackerSchema.statics.getUsage = function (userId) {
  return this.findOne({ userId }).lean();
};

module.exports = mongoose.model('UserUsageTracker', userUsageTrackerSchema);
