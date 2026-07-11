const mongoose = require('mongoose');

/**
 * WorkspaceUsageTracker — per-WORKSPACE usage counters (Phase 17, ships DARK).
 *
 * Mirrors UsageTracker exactly, but keyed by workspace instead of org. Written
 * and read ONLY for client-billed workspaces (those with an active
 * ClientSubscription to an AgencyPlan) — the org-scoped UsageTracker remains the
 * single source of truth for wholesale-tier quotas and is NEVER touched by this
 * model. With saasMode dark, no workspace is client-billed, so this table stays
 * empty and the live quota path is unaffected.
 *
 * One document per workspace per period.
 *   period = 'YYYY-MM' for monthly quotas (AgencyPlan limits are monthly)
 */

const workspaceUsageTrackerSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    period: {
      type: String,
      required: true,
      // 'YYYY-MM' or 'lifetime'
    },

    // ── Counters (defaults to 0) — same keys as UsageTracker ──
    articlesCreated: { type: Number, default: 0 },
    keywordSearches: { type: Number, default: 0 },
    auditsRun: { type: Number, default: 0 },
    aiTrackerPromptsCreated: { type: Number, default: 0 },
    creditsUsed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

workspaceUsageTrackerSchema.index({ workspaceId: 1, period: 1 }, { unique: true });

// ─── Static helpers (mirror UsageTracker) ───────────────────────

/**
 * Atomically increment a counter. Creates the document if it doesn't exist.
 * @param {ObjectId|string} workspaceId
 * @param {string} counterKey - e.g. 'articlesCreated'
 * @param {string} period     - e.g. '2026-05'
 * @param {number} [amount=1]
 */
workspaceUsageTrackerSchema.statics.increment = function (workspaceId, counterKey, period, amount = 1) {
  return this.findOneAndUpdate(
    { workspaceId, period },
    { $inc: { [counterKey]: amount } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Get the current value of a single counter.
 * @returns {Promise<number>}
 */
workspaceUsageTrackerSchema.statics.getCount = async function (workspaceId, counterKey, period) {
  const doc = await this.findOne({ workspaceId, period }).select(counterKey).lean();
  return doc?.[counterKey] ?? 0;
};

/**
 * Get the full usage document for a period (or null).
 */
workspaceUsageTrackerSchema.statics.getUsage = function (workspaceId, period) {
  return this.findOne({ workspaceId, period }).lean();
};

module.exports = mongoose.model('WorkspaceUsageTracker', workspaceUsageTrackerSchema);
