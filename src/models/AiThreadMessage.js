const mongoose = require('mongoose');

/**
 * AiThreadMessage — one append-only conversation event (Phase 1 of
 * CONVERSATION-THREADS-PLAN.md).
 *
 * D3: `text` is the FULL text (the engineered goal the model actually saw for
 * user turns; the accumulated assistant reply for assistant turns) — it is the
 * Phase-2 replay source. `displayText` is what the FE bubble shows (e.g.
 * "/auto-optimize" while `text` holds the ~150-word engineered goal) — never
 * replayed, purely presentational. '' → render `text`.
 *
 * kind 'compaction' (Phase 3) holds an LLM summary of all messages with
 * seq ≤ its thread's lastCompactionSeq.
 *
 * meta.channel distinguishes how a user message arrived: 'chat' | 'agent' |
 * 'steer' | 'clarify' | 'plan-confirm'. Side-channel messages (steer/clarify/
 * plan-confirm) are user inputs delivered MID-run — persisting them is what
 * keeps a replayed conversation coherent (the assistant visibly reacts to
 * them). meta.applied (steers only): false at queue time, flipped true when
 * the run's SSE tap sees steering_applied — a queued-but-never-applied steer
 * stays false so replay/history can label it honestly.
 */
const aiThreadMessageSchema = new mongoose.Schema(
  {
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AiThread',
      required: true,
    },
    seq: { type: Number, required: true },
    kind: {
      type: String,
      enum: ['user', 'assistant', 'compaction'],
      required: true,
    },
    // 32KB cap — a full engineered goal or accumulated reply fits comfortably;
    // anything bigger is truncated by threadService before write.
    text: { type: String, required: true, maxlength: 32768 },
    displayText: { type: String, default: '', maxlength: 200 },
    meta: {
      // Backend-minted crypto.randomUUID() per run — idempotency key for the
      // run's appends (no engine-side run identifier exists).
      runId: { type: String, default: '' },
      // Engine session that served this turn. Phase 2 uses it as the
      // Mongo-backed tenancy fallback for post-restart catch-up reads.
      sessionId: { type: String, default: '' },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      channel: { type: String, default: '' },
      commandName: { type: String, default: '' },
      model: { type: String, default: '' },
      tokensIn: { type: Number, default: 0 },
      tokensOut: { type: Number, default: 0 },
      docWrites: { type: Number, default: 0 },
      stopReason: { type: String, default: '' },
      turns: { type: Number, default: 0 },
      applied: { type: Boolean, default: undefined },
    },
  },
  { timestamps: true }
);

// The one structural invariant: seq is unique per thread. The atomic $inc
// allocator makes collisions impossible in normal operation; this index is
// the safety net that turns any future allocator bug into a loud E11000
// instead of a silently-forked conversation.
aiThreadMessageSchema.index({ threadId: 1, seq: 1 }, { unique: true });

module.exports = mongoose.model('AiThreadMessage', aiThreadMessageSchema);
