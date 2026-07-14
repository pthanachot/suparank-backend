const mongoose = require('mongoose');

/**
 * AgentUsageLog — one row per completed agent/chat run. Captures token
 * consumption keyed on the dimensions the cost-estimate UI aggregates on:
 * workspace, content, contentType, and mode (chat | plan | execute).
 *
 * Written by aiController's SSE tap (it accumulates `usage` events from
 * the writing-engine stream and persists one row per stream). Read by
 * `GET /plan/estimate` which returns p25/p50/p75 of inputTokens +
 * outputTokens for the user's contentType in plan mode.
 *
 * Schema is intentionally narrow: only the fields that drive the
 * aggregation. Anything richer (per-tool, per-iteration) belongs in a
 * separate analytics sink, not in this hot path.
 */
const agentUsageLogSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Content',
      required: true,
      index: true,
    },
    // Frozen at write time. Lets us aggregate per contentType without
    // joining Content (which may have changed type since).
    contentType: { type: String, default: '' },
    // chat | plan | execute. Same enum as Content.mode.
    mode: { type: String, enum: ['chat', 'plan', 'execute'], required: true },
    inputTokens: { type: Number, required: true, min: 0 },
    outputTokens: { type: Number, required: true, min: 0 },
    // SSE endpoint that produced this row: 'chat' or 'agent'. Useful
    // signal for filtering; cost estimate aggregates across both.
    source: { type: String, enum: ['chat', 'agent'], required: true },

    // ── W4-c prerequisite: run-record fields ─────────────────────────────
    // Enough for a run-status/catch-up UI to tell a finished run from a
    // died one without a separate collection. All optional/additive.
    sessionId: { type: String, default: '' },
    // P4 review: sessions are REUSED across runs (and threads), so sessionId
    // is ambiguous as a run identifier — the catch-up UI's "changes not
    // applied yet" annotation needs the backend-minted per-run id.
    runId: { type: String, default: '' },
    // Engine stopReason from the complete event ('done', 'stale',
    // 'token_budget', …). '' when the stream ended without a complete event.
    stopReason: { type: String, default: '' },
    // Server-observed document_diff count for this run.
    docWrites: { type: Number, default: 0 },
    // True when the client disconnected/stopped before stream end.
    aborted: { type: Boolean, default: false },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

// Aggregation hot path: filter by (workspaceId, contentType, mode) over the
// last N days, ordered by createdAt. The compound index covers it directly.
agentUsageLogSchema.index({ workspaceId: 1, contentType: 1, mode: 1, createdAt: -1 });

// TTL: rows older than 90 days are pruned automatically. The cost estimate
// only reads the last 30 days, so keeping a 60-day buffer beyond that
// gives us room to widen the window later without losing history. Without
// this index the collection grows unboundedly for high-traffic workspaces.
agentUsageLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'createdAt_ttl_90d' }
);

/**
 * Compute p25/p50/p75 of (inputTokens + outputTokens) for a given
 * workspace+contentType+mode combo. Returns null when the sample is too
 * small to show a meaningful band — caller should fall back to a static
 * estimate or hide the UI.
 */
agentUsageLogSchema.statics.computeBand = async function (
  workspaceId,
  { contentType, mode, sinceMs },
  { minSampleSize = 5, maxSampleSize = 200 } = {}
) {
  const since = new Date(Date.now() - (sinceMs || 30 * 24 * 60 * 60 * 1000));
  const docs = await this.find(
    {
      workspaceId,
      contentType: contentType || '',
      mode,
      createdAt: { $gte: since },
    },
    { inputTokens: 1, outputTokens: 1 }
  )
    .sort({ createdAt: -1 })
    .limit(maxSampleSize)
    .lean();

  if (docs.length < minSampleSize) {
    return { sampleSize: docs.length, p25: null, p50: null, p75: null };
  }

  const totals = docs
    .map((d) => (d.inputTokens || 0) + (d.outputTokens || 0))
    .sort((a, b) => a - b);
  const pick = (q) => totals[Math.min(totals.length - 1, Math.floor(q * totals.length))];
  return {
    sampleSize: totals.length,
    p25: pick(0.25),
    p50: pick(0.5),
    p75: pick(0.75),
  };
};

module.exports = mongoose.model('AgentUsageLog', agentUsageLogSchema);
