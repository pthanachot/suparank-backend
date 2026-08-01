const mongoose = require('mongoose');

/**
 * AiThread — one durable AI conversation for a content document (Phase 1 of
 * CONVERSATION-THREADS-PLAN.md). The thread + its AiThreadMessages are the
 * SOURCE OF TRUTH for the conversation; the engine session is a disposable
 * working copy re-seeded from here (Phase 2).
 *
 * D1: one SHARED thread per content — ownerUserId stays null (reserved for a
 * later per-user mode; messages carry meta.userId for attribution).
 *
 * `messageCount` doubles as the seq allocator: appendMessage $inc's it via
 * findOneAndUpdate and uses the returned value-1 as the message's seq. That
 * makes allocation atomic under concurrent appends (chat + agent on one
 * content, two tabs) — never compute max(seq)+1 from a read.
 *
 * Retention (D4): archived threads are pruned by the Phase-5 nightly cron
 * (messages first, then the thread — the deletionService children-first
 * discipline). Deliberately NO TTL index here: a TTL delete on the thread
 * cannot cascade to its messages and would orphan them.
 */
const aiThreadSchema = new mongoose.Schema(
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
    },
    // null = shared thread (D1). Reserved for future per-user threads.
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // First user displayText, capped — the picker label (Phase 4).
    title: { type: String, default: '', maxlength: 120 },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    archivedAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    // Seq allocator + picker metadata in one counter.
    messageCount: { type: Number, default: 0 },
    // Running ceil(text.length/4) sum — Phase 3's compaction trigger.
    tokenEstimate: { type: Number, default: 0 },
    // Phase-3 TRIGGER BOOKKEEPING ONLY (the replay fetch keys off the newest
    // kind:'compaction' row's meta.coversThroughSeq, never these fields):
    // seq of the newest compaction row, -1 = never compacted…
    lastCompactionSeq: { type: Number, default: -1 },
    // …and the thread's cumulative tokenEstimate AT that moment — the trigger
    // fires on (tokenEstimate - tokenEstimateAtCompaction) > threshold, i.e.
    // tokens accumulated SINCE the last compaction.
    tokenEstimateAtCompaction: { type: Number, default: 0 },
    // Conversations Phase 7: cumulative ENGINE TURNS across every run filed on
    // this conversation.
    //
    // Nothing else in the system bounds repeated work. Every engine budget —
    // max_turns, max_edits, the cumulative token ceiling — resets to zero on
    // each run, `creditsUsed` is written to three tables and read by nobody who
    // blocks, and the only aggregate USD kill-switch in the codebase is a
    // $10/day cap on anonymous public tools that never touches /ai/agent. So a
    // one-click "continue" is an unbounded spend loop unless something counts
    // ACROSS runs. This is that something.
    //
    // Turns rather than credits (decision §4 #5): legible to a user ("42 of 150
    // turns"), and already carried per run in AiThreadMessage.meta.turns, so the
    // increment point exists rather than needing new plumbing.
    turnsUsed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Hot path: resolve the active thread for a content (getOrCreateActiveThread)
// and the Phase-4 picker (recent threads for a content, newest first).
aiThreadSchema.index({ contentId: 1, status: 1, lastMessageAt: -1 });

// Review BUG-1: at most ONE active thread per (content, owner). The
// getOrCreateActiveThread upsert is only race-free when a unique index backs
// its filter — without this, two concurrent first-runs (two tabs, shared
// thread) could both insert an active thread and split the conversation
// across independent seq counters (nondeterministic history, Phase-2 replay
// seeding from whichever wins). Partial: archived threads are unlimited.
aiThreadSchema.index(
  { contentId: 1, ownerUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_thread_per_owner' },
);

// P5 review: the nightly prune's find({ status:'archived', archivedAt:{$lt} })
// .sort({ archivedAt:1 }) was an unindexed collection scan — none of the
// indexes above prefix on status alone.
aiThreadSchema.index({ status: 1, archivedAt: 1 });

module.exports = mongoose.model('AiThread', aiThreadSchema);
