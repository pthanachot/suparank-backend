const mongoose = require('mongoose');

/**
 * AiCostLedger — one row per LLM call, with its computed USD cost.
 *
 * This is the keystone of the v4.1 pricing work (Phase 1): it is the ground
 * truth for cost-of-goods, tier-routing decisions, and the margin invariants
 * (Phase 14). Written by costLedgerService.record() from every LLM call site
 * (writing-engine chat/agent/image, engine pipeline, AI Tracker scans, audits).
 *
 * Distinct from AgentUsageLog (which drives the per-workspace cost-estimate UI
 * over a 90-day TTL window) — this ledger is financial history and is NOT
 * TTL-pruned. Distinct from CreditTransaction (customer-facing credit balance);
 * this records our real COGS in dollars, not credits.
 *
 * Writes are best-effort and must never break the hot path — see
 * costLedgerService.record(), which swallows errors.
 */
const aiCostLedgerSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null,
      index: true,
    },
    // The user who triggered the call. Null for system/scheduled runs.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Logical activity, e.g. 'article' | 'chat' | 'agent' | 'audit' |
    // 'tracker_scan' | 'image' | 'brief' | 'rescore' | 'voice_extraction' |
    // 'avatar' | 'keyword'. Frozen at write time; drives COGS-by-action.
    action: { type: String, required: true, index: true },
    // Actual model id passed to the provider (registry key form when known).
    model: { type: String, required: true },
    // Resolved provider: 'openrouter' | 'openai' | 'google' | 'anthropic' | 'perplexity'.
    provider: { type: String, default: '' },
    tokensIn: { type: Number, default: 0, min: 0 },
    tokensOut: { type: Number, default: 0, min: 0 },
    // Images bought on this row. Already fed the costUsd calculation but was
    // never stored, which left the count unqueryable — and `calls` cannot stand
    // in for it, because the one-shot endpoint writes one row per image while
    // an agent run writes ONE row carrying the whole run's total. Recorded so
    // "which org is generating hundreds of images" is answerable at all.
    // Rows written before this field exists read back as 0, so any total is a
    // lower bound over a window that spans the deploy.
    images: { type: Number, default: 0, min: 0 },
    // Computed USD cost from modelRegistry.costFor(). 0 when the model is not
    // in the registry (unknown=true flags that so it can be back-filled).
    costUsd: { type: Number, default: 0, min: 0 },
    // True when the model id was not found in modelRegistry — cost is 0 and
    // needs pricing. Alarming signal for the margin dashboard.
    unknownModel: { type: Boolean, default: false },
    // Org tier at call time: 'free' | 'standard' | 'professional' | 'agency'.
    tier: { type: String, default: '' },
    // Whether the caller supplied their own key (BYOK) — our COGS is 0 then.
    byok: { type: Boolean, default: false },
    // Arbitrary context: { contentId, trackerId, engine, sessionId, step, ... }
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// COGS aggregation hot paths.
aiCostLedgerSchema.index({ action: 1, createdAt: -1 });
aiCostLedgerSchema.index({ tier: 1, createdAt: -1 });
aiCostLedgerSchema.index({ organizationId: 1, createdAt: -1 });

/**
 * Aggregate cost + token totals grouped by a field ('action' | 'tier' |
 * 'model' | 'provider'), optionally filtered by a since date and org.
 * Returns [{ _id, costUsd, tokensIn, tokensOut, calls }] sorted by cost desc.
 */
aiCostLedgerSchema.statics.cogsBy = async function (
  groupBy = 'action',
  { sinceMs = 30 * 24 * 60 * 60 * 1000, organizationId = null } = {}
) {
  const match = { createdAt: { $gte: new Date(Date.now() - sinceMs) } };
  if (organizationId) match.organizationId = new mongoose.Types.ObjectId(organizationId);
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: `$${groupBy}`,
        costUsd: { $sum: '$costUsd' },
        tokensIn: { $sum: '$tokensIn' },
        tokensOut: { $sum: '$tokensOut' },
        calls: { $sum: 1 },
      },
    },
    { $sort: { costUsd: -1 } },
  ]);
};

/**
 * Image spend per organisation, worst first — the monitoring view for /image.
 *
 * Images are the only thing the engine buys per UNIT rather than per token, so
 * they are the one cost that a single tenant can run up quickly without moving
 * any token-based dashboard. cogsBy('organizationId') cannot answer this: it
 * sums every action together, so image spend hides inside a much larger article
 * and chat total.
 *
 * `images` is 0 on rows written before that field existed, so a window spanning
 * the deploy under-reports the count. costUsd is correct throughout — it was
 * always computed from the image count even when the count was not stored — so
 * prefer cost when the two disagree.
 *
 * @returns [{ organizationId, costUsd, images, rows }] sorted by costUsd desc
 */
aiCostLedgerSchema.statics.imageSpendByOrg = async function (
  { sinceMs = 7 * 24 * 60 * 60 * 1000, limit = 20 } = {}
) {
  const capped = Math.max(1, Math.min(100, Number(limit) || 20));
  return this.aggregate([
    { $match: { action: 'image', createdAt: { $gte: new Date(Date.now() - sinceMs) } } },
    {
      $group: {
        _id: '$organizationId',
        costUsd: { $sum: '$costUsd' },
        images: { $sum: '$images' },
        rows: { $sum: 1 },
      },
    },
    { $sort: { costUsd: -1 } },
    { $limit: capped },
    { $project: { _id: 0, organizationId: '$_id', costUsd: 1, images: 1, rows: 1 } },
  ]);
};

module.exports = mongoose.model('AiCostLedger', aiCostLedgerSchema);
