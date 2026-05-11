const mongoose = require('mongoose');

/**
 * UsageTracker — per-organisation usage counters.
 *
 * One document per org per period.
 *   period = 'YYYY-MM' for monthly quotas
 *   period = 'lifetime' for lifetime quotas (free tier)
 *
 * Counters are incremented atomically via $inc (upsert).
 */

const usageTrackerSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    period: {
      type: String,
      required: true,
      // 'YYYY-MM' or 'lifetime'
    },

    // ── Counters (defaults to 0) ──
    articlesCreated: { type: Number, default: 0 },
    keywordSearches: { type: Number, default: 0 },
    auditsRun: { type: Number, default: 0 },
    aiTrackerPromptsCreated: { type: Number, default: 0 },
    creditsUsed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

usageTrackerSchema.index({ organizationId: 1, period: 1 }, { unique: true });

// ─── Static helpers ─────────────────────────────────────────────

/**
 * Atomically increment a counter. Creates the document if it doesn't exist.
 * @param {ObjectId|string} orgId
 * @param {string} counterKey - e.g. 'articlesCreated'
 * @param {string} period     - e.g. '2026-05' or 'lifetime'
 * @param {number} [amount=1]
 * @returns {Promise<object>} The updated document
 */
usageTrackerSchema.statics.increment = function (orgId, counterKey, period, amount = 1) {
  return this.findOneAndUpdate(
    { organizationId: orgId, period },
    { $inc: { [counterKey]: amount } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Get the current value of a single counter.
 * @returns {Promise<number>}
 */
usageTrackerSchema.statics.getCount = async function (orgId, counterKey, period) {
  const doc = await this.findOne({ organizationId: orgId, period })
    .select(counterKey)
    .lean();
  return doc?.[counterKey] ?? 0;
};

/**
 * Get the full usage document for a period (or null).
 */
usageTrackerSchema.statics.getUsage = function (orgId, period) {
  return this.findOne({ organizationId: orgId, period }).lean();
};

module.exports = mongoose.model('UsageTracker', usageTrackerSchema);
