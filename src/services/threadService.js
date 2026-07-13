/**
 * threadService — durable conversation threads (Phase 1 of
 * CONVERSATION-THREADS-PLAN.md).
 *
 * All WRITE entry points are gated on flagService.isFlagLive('aiThreads')
 * (route middleware rf() cannot gate writes that live inside the existing
 * chat/agent handlers) and NEVER THROW into their callers — capture is a
 * side-effect of the AI hot paths; a Mongo hiccup must not fail a run the
 * user paid for. Failures log and return null.
 *
 * Seq allocation: atomic $inc of AiThread.messageCount via findOneAndUpdate;
 * the returned value-1 is this message's seq. Concurrent appends (chat +
 * agent, two tabs) each get a distinct seq; the unique (threadId, seq) index
 * is the safety net, never the mechanism.
 */

const AiThread = require('../models/AiThread');
const AiThreadMessage = require('../models/AiThreadMessage');
const { isFlagLive } = require('./flagService');

const MAX_TEXT = 32768;
const MAX_DISPLAY = 200;

/** ceil(chars/4) — the cheap token estimate Phase 3's compaction triggers on. */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Resolve (or create) the single ACTIVE shared thread for a content (D1).
 * Concurrency-safe via the same findOneAndUpdate-upsert idiom the codebase
 * uses for counters: two simultaneous first-appends converge on one thread.
 * Returns the lean thread doc, or null (flag off / error).
 */
async function getOrCreateActiveThread(content, userId) {
  if (!(await isFlagLive('aiThreads'))) return null;
  try {
    return await AiThread.findOneAndUpdate(
      { contentId: content._id, status: 'active', ownerUserId: null },
      {
        $setOnInsert: {
          workspaceId: content.workspaceId,
          contentId: content._id,
          ownerUserId: null,
          title: '',
        },
      },
      { new: true, upsert: true, lean: true },
    );
  } catch (err) {
    console.error('[threads] getOrCreateActiveThread failed:', err.message);
    return null;
  }
}

/**
 * Append one message. `thread` is the doc from getOrCreateActiveThread (pass
 * null to no-op — lets callers do `appendMessage(maybeThread, …)` without
 * re-checking the flag). Returns { seq } or null. Never throws.
 */
async function appendMessage(thread, { kind, text, displayText, meta }) {
  if (!thread) return null;
  try {
    const fullText = String(text || '').slice(0, MAX_TEXT);
    if (!fullText) return null;
    const display = String(displayText || '').slice(0, MAX_DISPLAY);

    const updated = await AiThread.findOneAndUpdate(
      { _id: thread._id },
      {
        $inc: { messageCount: 1, tokenEstimate: estimateTokens(fullText) },
        $set: { lastMessageAt: new Date() },
      },
      { new: true, lean: true },
    );
    if (!updated) return null; // thread deleted between resolve and append
    const seq = updated.messageCount - 1;

    if (kind === 'user' && !updated.title) {
      // Best-effort, guarded so a concurrent first-append can't overwrite.
      AiThread.updateOne(
        { _id: thread._id, title: '' },
        { $set: { title: (display || fullText).slice(0, 120) } },
      ).catch(() => {});
    }

    await AiThreadMessage.create({
      threadId: thread._id,
      seq,
      kind,
      text: fullText,
      displayText: display,
      meta: meta || {},
    });
    return { seq };
  } catch (err) {
    console.error('[threads] appendMessage failed:', err.message);
    return null;
  }
}

/**
 * Flip a queued steer to applied (the run's SSE tap saw steering_applied).
 * Marks ALL still-unapplied steers for the run's thread — the engine drains
 * its whole queue at once, so per-message matching would be guesswork.
 */
async function markSteersApplied(threadId) {
  if (!threadId) return;
  try {
    await AiThreadMessage.updateMany(
      { threadId, kind: 'user', 'meta.channel': 'steer', 'meta.applied': false },
      { $set: { 'meta.applied': true } },
    );
  } catch (err) {
    console.error('[threads] markSteersApplied failed:', err.message);
  }
}

/**
 * Read a page of the active thread's messages for the history view.
 * Newest-first pagination (page 0 = most recent), each page returned in
 * ascending seq order ready to render. READ path — throws propagate to the
 * route handler (it has its own error envelope).
 */
async function getThreadHistory(contentId, { page = 0, pageSize = 50 } = {}) {
  const thread = await AiThread.findOne(
    { contentId, status: 'active', ownerUserId: null },
    null,
    { lean: true },
  );
  if (!thread) return { thread: null, messages: [], hasMore: false };

  const size = Math.min(Math.max(1, pageSize), 100);
  const messages = await AiThreadMessage.find({ threadId: thread._id })
    .sort({ seq: -1 })
    .skip(page * size)
    .limit(size + 1)
    .lean();
  const hasMore = messages.length > size;
  if (hasMore) messages.pop();
  messages.reverse(); // ascending for the renderer

  return {
    thread: {
      id: thread._id,
      title: thread.title,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt,
    },
    messages: messages.map((m) => ({
      seq: m.seq,
      kind: m.kind,
      text: m.text,
      displayText: m.displayText,
      meta: m.meta,
      createdAt: m.createdAt,
    })),
    hasMore,
  };
}

/**
 * Archive the active thread and start a fresh one ("New conversation").
 * Fixes the resurrect bug: the FE's New-chat previously cleared component
 * state only, so history reloaded on refresh. Returns the new thread or null.
 */
async function startNewThread(content, userId) {
  if (!(await isFlagLive('aiThreads'))) return null;
  try {
    await AiThread.updateMany(
      { contentId: content._id, status: 'active', ownerUserId: null },
      { $set: { status: 'archived', archivedAt: new Date() } },
    );
    return await AiThread.create({
      workspaceId: content.workspaceId,
      contentId: content._id,
      ownerUserId: null,
    });
  } catch (err) {
    console.error('[threads] startNewThread failed:', err.message);
    return null;
  }
}

module.exports = {
  getOrCreateActiveThread,
  appendMessage,
  markSteersApplied,
  getThreadHistory,
  startNewThread,
  estimateTokens,
};
