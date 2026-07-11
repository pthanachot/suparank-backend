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

module.exports = mongoose.model('AiCostLedger', aiCostLedgerSchema);
