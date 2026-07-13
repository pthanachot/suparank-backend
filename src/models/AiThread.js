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
    // Seq of the newest 'compaction' message; -1 = never compacted. Replay
    // (Phase 2) sends the compaction summary + everything after this seq.
    lastCompactionSeq: { type: Number, default: -1 },
  },
  { timestamps: true }
);

// Hot path: resolve the active thread for a content (getOrCreateActiveThread)
// and the Phase-4 picker (recent threads for a content, newest first).
aiThreadSchema.index({ contentId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('AiThread', aiThreadSchema);
