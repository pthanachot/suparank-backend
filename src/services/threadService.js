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
const writingEngine = require('./writingEngine');
const costLedger = require('./costLedgerService');

const MAX_TEXT = 32768;
const MAX_DISPLAY = 200;

/** ceil(chars/4) — the cheap token estimate Phase 3's compaction triggers on. */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Resolve (or create) the single ACTIVE shared thread for a content (D1).
 * Race-safety comes from the unique partial index one_active_thread_per_owner
 * (AiThread.js) — the upsert idiom alone is NOT atomic (two concurrent misses
 * can both insert without a unique index; review BUG-1). A loser's E11000 is
 * retried as a plain read of the winner's row. Returns the lean thread doc,
 * or null (flag off / error).
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
      // sort: belt-and-braces determinism if duplicates ever exist (pre-index
      // rows): always operate on the newest active.
      { new: true, upsert: true, lean: true, sort: { createdAt: -1 } },
    );
  } catch (err) {
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      // Lost the insert race — the winner's row is the shared thread.
      try {
        return await AiThread.findOne(
          { contentId: content._id, status: 'active', ownerUserId: null },
          null,
          { lean: true, sort: { createdAt: -1 } },
        );
      } catch { /* fall through to the log below */ }
    }
    console.error('[threads] getOrCreateActiveThread failed:', err.message);
    return null;
  }
}

/** Trim a sliced string's trailing unpaired high surrogate (a .slice() cut
 *  through an emoji leaves a lone surrogate that serializes as U+FFFD). */
function safeSlice(s, max) {
  let out = String(s || '').slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * Append one message. `thread` is the doc from getOrCreateActiveThread (pass
 * null to no-op — lets callers do `appendMessage(maybeThread, …)` without
 * re-checking the flag). Returns { seq } or null. Never throws.
 *
 * Review BUG-2 (defense-in-depth): the $inc filters on status:'active'. A
 * thread captured pre-run can be ARCHIVED mid-run ("New conversation" from a
 * second tab / another user while this run is in flight — the FE disable is
 * per-tab state). Filing the run's reply on the archived thread would make it
 * invisible in history and excluded from Phase-2 replay; instead, when
 * `content` is provided we re-resolve the CURRENT active thread once and file
 * there. (Primary guard — P4 corrected: newThread/activateThread 409 while
 * the per-content threadWriteLock is held, which covers CHAT runs and the
 * agent registry's early-delete tail; this re-resolve remains defense-in-
 * depth for multi-instance deployments where the in-process lock is blind.)
 */
async function appendMessage(thread, { kind, text, displayText, meta }, content) {
  if (!thread) return null;
  try {
    const fullText = safeSlice(text, MAX_TEXT);
    // trim() guard (P3 lifecycle review BUG-2): a whitespace-only row would
    // 400 the engine's TrimSpace validation on EVERY future compact AND seed
    // — one blank chat prompt permanently wedging both. Never persist one.
    if (!fullText || !fullText.trim()) return null;
    const display = safeSlice(displayText, MAX_DISPLAY);

    let updated = await AiThread.findOneAndUpdate(
      { _id: thread._id, status: 'active' },
      {
        $inc: { messageCount: 1, tokenEstimate: estimateTokens(fullText) },
        $set: { lastMessageAt: new Date() },
      },
      { new: true, lean: true },
    );
    if (!updated && content) {
      const current = await getOrCreateActiveThread(content, meta?.userId);
      if (current) {
        updated = await AiThread.findOneAndUpdate(
          { _id: current._id, status: 'active' },
          {
            $inc: { messageCount: 1, tokenEstimate: estimateTokens(fullText) },
            $set: { lastMessageAt: new Date() },
          },
          { new: true, lean: true },
        );
      }
    }
    if (!updated) return null; // thread archived/deleted and no re-resolve
    const seq = updated.messageCount - 1;

    // First CONVERSATION message names the thread (picker label, Phase 4).
    // Channel-gated: a steer/clarify must never become the title (reachable
    // when a side-channel append creates/wins the fresh thread).
    const channel = meta?.channel || '';
    if (kind === 'user' && !updated.title && (channel === 'chat' || channel === 'agent')) {
      // Best-effort, guarded so a concurrent first-append can't overwrite.
      AiThread.updateOne(
        { _id: updated._id, title: '' },
        { $set: { title: safeSlice(display || fullText, 120) } },
      ).catch(() => {});
    }

    await AiThreadMessage.create({
      threadId: updated._id,
      seq,
      kind,
      text: fullText,
      displayText: display,
      meta: meta || {},
    });
    // threadId returned so the seeding invariant's post-run bump can verify
    // the row landed on the thread its marker tracks (a BUG-2 re-resolve may
    // have filed it elsewhere — then the marker must NOT advance).
    return { seq, threadId: String(updated._id) };
  } catch (err) {
    console.error('[threads] appendMessage failed:', err.message);
    return null;
  }
}

/**
 * Flip queued steers to applied (the run's SSE tap saw steering_applied).
 * Marks the still-unapplied steers queued SINCE this run started — the engine
 * drains its whole queue at once so per-message matching would be guesswork,
 * but the time bound (review BUG-3) stops a PREVIOUS run's provably-dropped
 * steer (engine logs "dropping N undelivered…" at run end) from being
 * retroactively flipped by a later run's application — the exact dishonesty
 * the `applied` flag exists to prevent.
 */
async function markSteersApplied(threadId, sinceMs) {
  if (!threadId) return;
  try {
    const filter = { threadId, kind: 'user', 'meta.channel': 'steer', 'meta.applied': false };
    if (sinceMs) filter.createdAt = { $gte: new Date(sinceMs) };
    await AiThreadMessage.updateMany(filter, { $set: { 'meta.applied': true } });
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
    // Deterministic under any legacy duplicate actives: newest wins (matches
    // getOrCreateActiveThread's sort).
    { lean: true, sort: { createdAt: -1 } },
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
 * state only, so history reloaded on refresh.
 *
 * Returns the new thread, `{ disabled: true }` when the flag is off (the
 * controller maps it to a clean 409 "not enabled"), or null on a real error
 * (controller 500s). A create that loses to a concurrent getOrCreate insert
 * (unique active index) adopts the winner's fresh thread — same end state.
 */
async function startNewThread(content, userId) {
  if (!(await isFlagLive('aiThreads'))) return { disabled: true };
  try {
    // P4 review: an EMPTY active thread already IS a new conversation —
    // no-op idempotently instead of minting an archived empty row per click
    // (button mashing / client retries were unbounded picker spam until the
    // Phase-5 prune).
    const current = await AiThread.findOne(
      { contentId: content._id, status: 'active', ownerUserId: null },
      null,
      { lean: true, sort: { createdAt: -1 } },
    );
    if (current && current.messageCount === 0) return current;

    await AiThread.updateMany(
      { contentId: content._id, status: 'active', ownerUserId: null },
      { $set: { status: 'archived', archivedAt: new Date() } },
    );
    try {
      return await AiThread.create({
        workspaceId: content.workspaceId,
        contentId: content._id,
        ownerUserId: null,
      });
    } catch (err) {
      if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
        // A concurrent run's getOrCreate won the fresh-thread insert between
        // our archive and create — its empty thread IS the new conversation.
        return await AiThread.findOne(
          { contentId: content._id, status: 'active', ownerUserId: null },
          null,
          { lean: true, sort: { createdAt: -1 } },
        );
      }
      throw err;
    }
  } catch (err) {
    console.error('[threads] startNewThread failed:', err.message);
    return null;
  }
}

// ─── Phase 2: replay shaping ─────────────────────────────────────────────

// Replay budget: the shaped history sent to the engine stays under this many
// estimated tokens (walked backward from the newest message). Compaction
// (Phase 3) keeps real threads well below it; this is the hard stop.
const REPLAY_TOKEN_BUDGET = 24000;
// How many raw rows we even consider (pre-compaction threads could be huge;
// the token budget re-caps inside this window anyway).
const REPLAY_MAX_ROWS = 200;

/** Channel-aware replay prefix so mid-run inputs read coherently as history. */
function replayText(m) {
  const channel = m.meta?.channel || '';
  if (channel === 'steer') {
    // Review fidelity CAVEAT-2: a steer the engine provably DROPPED must not
    // replay as if it was followed — the model would claim compliance with an
    // instruction that never reached it. Label it honestly; never exclude it
    // (it is real user input the history panel shows).
    return m.meta?.applied === false
      ? `[Mid-run steering note — the run ended before this was applied] ${m.text}`
      : `[Mid-run steering note] ${m.text}`;
  }
  if (channel === 'clarify') return `[Answer to the AI's question] ${m.text}`;
  return m.text; // plan-confirm rows already start "[Plan decision]"
}

/**
 * Shape durable thread rows into a wire-safe [{role, content}] history for
 * the engine seed (Phase 2, plan §5 — ALL SEVEN RULES ARE LOAD-BEARING).
 * Pure function; unit-test target #1.
 *
 * `messages`: ascending rows { seq, kind, text, meta }. `compaction`: the
 * latest kind:'compaction' row or null. Rows AFTER the compaction only.
 *
 * Rules: (2) full `text`, never displayText; (3) compaction renders as a
 * leading user/assistant pair; (4) consecutive same-role rows coalesce with
 * \n\n (Anthropic-routed models 400 on consecutive same-role — the engine
 * itself guards this, query.go:1146); (5) must start with user; (6) must end
 * with assistant — a dangling trailing user (crashed/failed run, D6) is
 * sealed with a synthetic assistant note; (7) token budget walked backward.
 */
function shapeThreadForReplay(messages, { compaction = null, forceTruncatedNote = false } = {}) {
  // Rule 7: budget walk, newest-first, reserving room for the compaction pair.
  let budget = REPLAY_TOKEN_BUDGET;
  if (compaction) budget -= estimateTokens(compaction.text) + 16;
  const tail = [];
  let truncated = forceTruncatedNote; // caller saw the DB window itself clip
  const source = (messages || []).slice(-REPLAY_MAX_ROWS);
  for (let i = source.length - 1; i >= 0; i--) {
    const m = source[i];
    if (!m || (m.kind !== 'user' && m.kind !== 'assistant') || !m.text || !String(m.text).trim()) continue;
    const cost = estimateTokens(m.text);
    if (budget - cost < 0 && tail.length > 0) {
      truncated = true;
      console.warn(`[threads] replay truncated at ${tail.length} rows (token budget)`);
      break;
    }
    budget -= cost;
    tail.unshift(m);
  }

  // Rules 2+4: map to roles with channel prefixes, coalescing same-role runs.
  const out = [];
  for (const m of tail) {
    const role = m.kind === 'user' ? 'user' : 'assistant';
    const content = replayText(m);
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].content += `\n\n${content}`;
    } else {
      out.push({ role, content });
    }
  }

  // Rule 5: must start with user. Integration review BUG-1(b): with a
  // compaction leading, a leading assistant row is a KEEP-BOUNDARY artifact
  // (the boundary landed mid-pair) — a real reply the panel shows. Dropping
  // it deleted it from memory; instead it merges into the compaction pair's
  // assistant message below. Without a compaction, a leading assistant can
  // only be a budget-cut artifact — dropped as before.
  let leadingAssistant = null;
  if (compaction && out.length && out[0].role === 'assistant') {
    leadingAssistant = out.shift();
  }
  while (out.length && out[0].role !== 'user') out.shift();

  // Rule 6: must end with assistant. A dangling trailing user message is a
  // crashed/failed run (D6 appends no assistant row on errors) — seal it so
  // the next prompt's user message doesn't create consecutive-user roles.
  if (out.length && out[out.length - 1].role === 'user') {
    // Parenthetical reported speech (CAVEAT-1) — assistant-role synthetics
    // must not model an imitable register.
    out.push({ role: 'assistant', content: '(that request was interrupted before completion)' });
  }

  // Review fidelity CAVEAT-3 + integration BUG-2: a cut must be VISIBLE to
  // the model — the user sees the full history in the panel; a model that
  // confidently denies a turn happened is the worst memory bug. Post-P3 the
  // hole can sit BETWEEN the summarized portion and the tail (budget/window
  // cut of kept rows the summary does NOT cover), so the note fires with or
  // without a compaction — wording covers both. Alternation-safe (prepended
  // into the first user message, BEFORE the pair leads).
  const NOTE = '[Note: some earlier messages in this conversation are not shown here.]';
  let noteCarried = false;
  if (truncated && out.length && out[0].role === 'user') {
    out[0].content = `${NOTE}\n\n${out[0].content}`;
    noteCarried = true;
  }

  // Rule 3: compaction leads as a user/assistant pair (keeps alternation).
  // A rescued keep-boundary assistant reply (BUG-1(b)) rides in the pair's
  // assistant slot so it stays in memory without breaking alternation. A
  // truncation note that found no user tail message to ride (assistant-only
  // tail — mock-test review B4c) rides the pair's user slot instead.
  if (compaction) {
    const ack = leadingAssistant
      ? `Understood — continuing from that context.\n\n${leadingAssistant.content}`
      : 'Understood — continuing from that context.';
    const summaryContent = truncated && !noteCarried
      ? `[Summary of the earlier conversation]\n${compaction.text}\n\n${NOTE}`
      : `[Summary of the earlier conversation]\n${compaction.text}`;
    out.unshift(
      { role: 'user', content: summaryContent },
      { role: 'assistant', content: ack },
    );
  }

  return out;
}

/**
 * Build the seed payload for a content's active thread: shaped messages plus
 * the identity the seeding invariant tracks ({threadId, lastSeq}).
 *
 * Returns null when there is nothing to seed (flag off, no thread, empty
 * thread) — callers skip the engine call entirely. READ path: throws
 * propagate to setupSession, whose seed task decides fatality.
 *
 * In-flight-turn exclusion is BY ORDERING: both run handlers append the
 * current turn's user message AFTER setupSession completes, so a read here
 * never contains it. (A concurrent OTHER run's just-appended user row can
 * appear — the shaper's rule-6 seal keeps the history valid; rare + benign.)
 */
async function getReplayPayload(contentId) {
  if (!(await isFlagLive('aiThreads'))) return null;
  const thread = await AiThread.findOne(
    { contentId, status: 'active', ownerUserId: null },
    null,
    { lean: true, sort: { createdAt: -1 } },
  );
  if (!thread || thread.messageCount === 0) return null;

  // Review BUG-3 fetch contract (P3-corrected): the summary is the newest
  // kind:'compaction' ROW; the verbatim window is everything the summary does
  // NOT cover — seq > meta.coversThroughSeq. NOT seq > compaction.seq: the
  // keep-last-8 verbatim rows are appended BEFORE the compaction row (their
  // seqs sit between coversThroughSeq and the row's own seq) and a row-seq
  // window would silently drop them from replay. The shaper's kind filter
  // discards the compaction row itself (and any older ones) from the window.
  // thread.lastCompactionSeq remains TRIGGER bookkeeping only.
  const compaction = await AiThreadMessage.findOne(
    { threadId: thread._id, kind: 'compaction' },
    null,
    { lean: true, sort: { seq: -1 } },
  );
  const coveredThrough = compaction
    ? (Number.isFinite(compaction.meta?.coversThroughSeq) ? compaction.meta.coversThroughSeq : compaction.seq)
    : -1;

  const rows = await AiThreadMessage.find({
    threadId: thread._id,
    seq: { $gt: coveredThrough },
  })
    .sort({ seq: -1 })
    .limit(REPLAY_MAX_ROWS)
    .lean();
  rows.reverse();

  // Lifecycle review CAVEAT-2: a full DB window means rows older than the
  // window were clipped with NO budget signal — surface the note anyway.
  const shaped = shapeThreadForReplay(rows, { compaction, forceTruncatedNote: rows.length === REPLAY_MAX_ROWS });
  if (!shaped.length) return null;

  // lastSeq = the max row seq this payload ACTUALLY covers (review BUG-2's
  // marker source — never a counter high-water mark).
  const lastSeq = rows.length ? rows[rows.length - 1].seq : (compaction ? compaction.seq : -1);
  return { threadId: thread._id.toString(), lastSeq, messages: shaped };
}

/**
 * Cheap identity read for the seeding invariant: the active thread's id and
 * its seq high-water mark (messageCount - 1).
 *
 * Returns null ONLY when there is genuinely nothing to seed (flag off, no
 * active thread, empty thread). A Mongo READ FAILURE THROWS — the seed task
 * is fatal by contract, and a swallowed stamp error would let the run proceed
 * as a silent amnesiac (the worst failure mode this phase exists to prevent;
 * P2 review). Flag-service failures fail-closed to "off" inside isFlagLive,
 * which is consistent: with the flag layer down, capture is off too, so the
 * thread isn't advancing either.
 */
async function getActiveThreadStamp(contentId) {
  if (!(await isFlagLive('aiThreads'))) return null;
  const thread = await AiThread.findOne(
    { contentId, status: 'active', ownerUserId: null },
    { messageCount: 1 },
    { lean: true, sort: { createdAt: -1 } },
  );
  if (!thread || !thread.messageCount) return null;
  return { threadId: thread._id.toString(), lastSeq: thread.messageCount - 1 };
}

/**
 * Phase 2 tenancy fallback (design review GAP-6): has `sessionId` served this
 * content recently, per the DURABLE record? The in-memory contentSessionMap
 * dies with the process, which used to make post-restart catch-up reads
 * (engine-content) 409 even though the session lives on in engine SQLite.
 * Bounded to 24h — stale sessions are engine-evicted long before that.
 * Fail-closed (false) on any error.
 */
async function sessionSeenForContent(contentId, sessionId) {
  if (!sessionId) return false;
  try {
    const threads = await AiThread.find({ contentId }).select('_id').lean();
    if (!threads.length) return false;
    const hit = await AiThreadMessage.exists({
      threadId: { $in: threads.map((t) => t._id) },
      'meta.sessionId': sessionId,
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    return !!hit;
  } catch (err) {
    console.error('[threads] sessionSeenForContent failed:', err.message);
    return false;
  }
}

// ─── Phase 3: compaction ─────────────────────────────────────────────────

// Trigger thresholds — env-tunable so the live smoke can force a compaction
// without generating 24k real tokens. Production defaults per the plan.
const COMPACT_TRIGGER_TOKENS = parseInt(process.env.THREAD_COMPACT_TRIGGER_TOKENS, 10) || 24000;
const COMPACT_TRIGGER_MSGS = parseInt(process.env.THREAD_COMPACT_TRIGGER_MSGS, 10) || 60;
const COMPACT_KEEP_LAST = parseInt(process.env.THREAD_COMPACT_KEEP_LAST, 10) || 8;
// Below this many compactable rows a summary buys nothing.
const COMPACT_MIN_ROWS = 4;
// P3 review BUG-2: the span sent to the summarizer is TOKEN-BUDGETED. Without
// this, a thread that grew far past the trigger (engine down for days,
// repeated rejections) ships an ever-growing span that eventually exceeds the
// engine's byte cap → 400 → retried IDENTICALLY forever = compaction
// permanently wedged. Budgeted passes compact the OLDEST slice first; the
// previousSummary chain makes multi-pass catch-up natural (each pass's
// coversThroughSeq advances the window).
const COMPACT_SPAN_MAX_TOKENS = parseInt(process.env.THREAD_COMPACT_SPAN_MAX_TOKENS, 10) || 20000;

// One compaction per thread at a time (a detached trigger racing the next
// run's trigger would double-summarize the same span).
const compactionInFlight = new Set();

/** COGS for a compact call — SUCCESS OR REJECTED (a rejected length-truncated
 *  call still burned ~24k real input tokens; P3 review caveat). */
function recordCompactCogs(thread, result, rows, failed) {
  if (!result?.usage?.model) return;
  costLedger.recordForWorkspace({
    action: 'threadCompact',
    model: result.usage.model,
    tokensIn: result.usage.input_tokens || 0,
    tokensOut: result.usage.output_tokens || 0,
    workspaceId: thread.workspaceId,
    metadata: { threadId: thread._id.toString(), rows, ...(failed ? { failed: true } : {}) },
  });
}

/**
 * Compact the content's active thread when it has grown past the trigger:
 * summarize everything after the previous compaction EXCEPT the newest
 * COMPACT_KEEP_LAST rows (kept verbatim), append the summary as a
 * kind:'compaction' row carrying meta.coversThroughSeq (THE replay-window
 * contract — P2 review BUG-3), and update the thread's trigger bookkeeping.
 *
 * FIRE-AND-FORGET by contract: called detached after run convergence, never
 * throws, and any failure (engine down, truncated summary rejected) simply
 * retries after a later run. COGS-only ('threadCompact') — maintenance is
 * never billed to the user.
 */
async function maybeCompactThread(content) {
  let threadIdStr = null;
  try {
    if (!(await isFlagLive('aiThreads'))) return null;
    const thread = await AiThread.findOne(
      { contentId: content._id, status: 'active', ownerUserId: null },
      null,
      { lean: true, sort: { createdAt: -1 } },
    );
    if (!thread) return null;

    const tokensSince = (thread.tokenEstimate || 0) - (thread.tokenEstimateAtCompaction || 0);
    const msgsSince = thread.messageCount - 1 - (thread.lastCompactionSeq >= 0 ? thread.lastCompactionSeq : -1);
    if (tokensSince <= COMPACT_TRIGGER_TOKENS && msgsSince <= COMPACT_TRIGGER_MSGS) return null;

    threadIdStr = thread._id.toString();
    if (compactionInFlight.has(threadIdStr)) return null;
    compactionInFlight.add(threadIdStr);

    const prev = await AiThreadMessage.findOne(
      { threadId: thread._id, kind: 'compaction' },
      null,
      { lean: true, sort: { seq: -1 } },
    );
    const coveredThrough = prev
      ? (Number.isFinite(prev.meta?.coversThroughSeq) ? prev.meta.coversThroughSeq : prev.seq)
      : -1;

    const candidates = await AiThreadMessage.find({
      threadId: thread._id,
      seq: { $gt: coveredThrough },
      kind: { $in: ['user', 'assistant'] },
    })
      .sort({ seq: 1 })
      .limit(400)
      .lean();

    // Keep the newest rows verbatim — recency deserves fidelity, and the
    // replay window (seq > coversThroughSeq) keeps serving them unsummarized.
    const base = candidates.slice(0, Math.max(0, candidates.length - COMPACT_KEEP_LAST));
    if (base.length < COMPACT_MIN_ROWS) return null;

    // BUG-2: budget the span — oldest-first walk until the token budget,
    // always taking at least COMPACT_MIN_ROWS (rows cap at 32KB ≈ 8k tokens,
    // so the floor is bounded). The remainder waits for the next pass.
    const toCompact = [];
    let spanTokens = 0;
    for (const m of base) {
      if (spanTokens >= COMPACT_SPAN_MAX_TOKENS && toCompact.length >= COMPACT_MIN_ROWS) break;
      toCompact.push(m);
      spanTokens += estimateTokens(m.text);
    }
    // Integration review BUG-1(a): the coverage boundary must not split a
    // user→assistant pair — a kept window that STARTS with an assistant row
    // makes that reply a replay orphan (the shaper can't lead with assistant).
    // Extend the span forward until the next kept row is a user row.
    while (toCompact.length < candidates.length && candidates[toCompact.length].kind === 'assistant') {
      const m = candidates[toCompact.length];
      toCompact.push(m);
      spanTokens += estimateTokens(m.text);
    }
    if (toCompact.length < base.length) {
      console.log(`[threads] compact span budgeted: ${toCompact.length}/${base.length} rows this pass (~${spanTokens} tokens)`);
    }

    // Mock-test review CONFIRMED-BUG: rows persisted BEFORE the trim guard
    // can be whitespace-only; unfiltered they 400 the engine's per-message
    // validation and the byte-identical doomed span retries forever —
    // compaction wedged for that thread. Filter here; coversThroughSeq still
    // advances past the blanks (they carry nothing to summarize).
    const compactRows = toCompact.filter((m) => m.text && String(m.text).trim());
    if (!compactRows.length) {
      // All-blank span (pathological legacy data): nothing to summarize and
      // nothing worth a compaction row — leave it; the shaper filters blanks
      // from replay anyway.
      return null;
    }
    const compactArgs = {
      messages: compactRows.map((m) => ({
        role: m.kind === 'user' ? 'user' : 'assistant',
        content: replayText(m),
      })),
      previousSummary: prev?.text || '',
    };
    let result = await writingEngine.compact(compactArgs);
    // BUG-3: a fact-dense span can overflow the default 1200-token summary
    // budget → honest rejection. Escalate ONCE to the engine's 2000 cap
    // within this pass instead of retrying the same doomed call next run.
    if (result && result.error && /truncated/i.test(result.error)) {
      console.warn('[threads] compact truncated at default budget — escalating maxTokens to 2000');
      recordCompactCogs(thread, result, toCompact.length, true);
      result = await writingEngine.compact({ ...compactArgs, maxTokens: 2000 });
    }
    if (!result || result.error || !result.summary) {
      // Rejected calls still burned real tokens — ledger them (review caveat).
      recordCompactCogs(thread, result, toCompact.length, true);
      console.warn('[threads] compact rejected/failed (will retry after a later run):', result?.error || 'no summary');
      return null;
    }

    const coversThroughSeq = toCompact[toCompact.length - 1].seq;
    const appended = await appendMessage(thread, {
      kind: 'compaction',
      text: result.summary,
      meta: {
        channel: 'compaction',
        coversThroughSeq,
        model: result.usage?.model || '',
        tokensIn: result.usage?.input_tokens || 0,
        tokensOut: result.usage?.output_tokens || 0,
      },
    });
    if (!appended) {
      // Archived mid-flight: summary cleanly dropped — but its tokens were
      // real; ledger them (P4 review, mirrors the rejection-path discipline).
      recordCompactCogs(thread, result, toCompact.length, true);
      return null;
    }

    // Trigger bookkeeping. FULL pass: baseline resets to the thread's CURRENT
    // cumulative estimate (fresh read — includes the summary row and racing
    // appends) so tokensSince ≈ 0. PARTIAL (budgeted) pass: keep the OLD
    // baseline — the residual span must keep the token trigger hot so the
    // backlog drains one bite per run; resetting to full would stall the next
    // pass until another 24k FRESH tokens accumulate (lifecycle review,
    // BUG-1 companion).
    const partial = toCompact.length < base.length;
    const bookkeeping = { lastCompactionSeq: appended.seq };
    if (!partial) {
      const fresh = await AiThread.findById(thread._id).select('tokenEstimate').lean();
      bookkeeping.tokenEstimateAtCompaction = fresh?.tokenEstimate || 0;
    }
    await AiThread.updateOne({ _id: thread._id }, { $set: bookkeeping });

    recordCompactCogs(thread, result, toCompact.length, false);
    console.log(`[threads] compacted thread ${threadIdStr}: ${toCompact.length} rows → summary (coversThroughSeq=${coversThroughSeq})`);
    return { coversThroughSeq, rows: toCompact.length };
  } catch (err) {
    console.error('[threads] maybeCompactThread failed (non-fatal):', err.message);
    return null;
  } finally {
    if (threadIdStr) compactionInFlight.delete(threadIdStr);
  }
}

// ─── Phase 4: thread UX ──────────────────────────────────────────────────

/**
 * List a content's conversations for the picker — active first, then
 * archived newest-first. READ path: throws propagate to the route handler.
 */
async function listThreads(contentId, { limit = 20 } = {}) {
  const threads = await AiThread.find(
    // Empty ARCHIVED threads are legacy New-conversation artifacts — noise
    // in the picker (the active one shows even when empty: it's "current").
    { contentId, ownerUserId: null, $or: [{ status: 'active' }, { messageCount: { $gt: 0 } }] },
    { title: 1, status: 1, messageCount: 1, lastMessageAt: 1, createdAt: 1 },
  )
    .sort({ status: 1, lastMessageAt: -1 }) // 'active' < 'archived' lexically ✓
    .limit(Math.min(Math.max(1, limit), 50))
    .lean();
  return threads.map((t) => ({
    id: t._id.toString(),
    title: t.title || '',
    status: t.status,
    messageCount: t.messageCount,
    lastMessageAt: t.lastMessageAt,
    createdAt: t.createdAt,
  }));
}

/**
 * Resume an archived conversation: archive the current active thread and
 * re-activate the target ("Claude Code --resume"). Content-scoped — a
 * threadId from another content 404s (returns null). NO session surgery
 * needed: the P2 seeding invariant re-seeds the next run automatically
 * because the marker's threadId no longer matches the active thread.
 *
 * Returns the activated thread, { disabled: true } (flag off), or null
 * (not found / error). The unique active index makes archive→activate safe:
 * after the archive updateMany there is no active row to collide with; a
 * concurrent getOrCreate's fresh insert could win the slot first — the
 * E11000 on our activate updateOne is caught and surfaced as a retryable
 * failure rather than a half-state.
 */
async function activateThread(content, threadId) {
  if (!(await isFlagLive('aiThreads'))) return { disabled: true };
  let prevActiveId = null;
  try {
    const target = await AiThread.findOne(
      { _id: threadId, contentId: content._id, ownerUserId: null },
      null,
      { lean: true },
    );
    if (!target) return null; // genuine miss (foreign/unknown id) → 404
    if (target.status === 'active') return target; // already the active one

    // P4 review BUG-1: archive→activate is NOT atomic — in the zero-active
    // window a concurrent getOrCreateActiveThread (chat run start, a
    // convergence re-resolve, side-channels) can upsert a fresh active row,
    // and our activate then E11000s against the unique active index. The old
    // code's blanket catch returned null → a lying 404 with the user's thread
    // STRANDED archived and an empty upstart active. Now: bounded retry that
    // re-archives the upstart each round (its own append re-resolves onto the
    // target once active), and on terminal failure the ORIGINAL active is
    // best-effort restored so the user is never stranded.
    const prevActive = await AiThread.findOne(
      { contentId: content._id, status: 'active', ownerUserId: null },
      { _id: 1 },
      { lean: true, sort: { createdAt: -1 } },
    );
    prevActiveId = prevActive ? prevActive._id : null;

    for (let attempt = 0; attempt < 3; attempt++) {
      await AiThread.updateMany(
        { contentId: content._id, status: 'active', ownerUserId: null },
        { $set: { status: 'archived', archivedAt: new Date() } },
      );
      try {
        return await AiThread.findOneAndUpdate(
          { _id: target._id },
          { $set: { status: 'active', archivedAt: null } },
          { new: true, lean: true },
        );
      } catch (err) {
        if (!(err && (err.code === 11000 || err.codeName === 'DuplicateKey'))) throw err;
        // Upstart active appeared in the window — loop re-archives it.
      }
    }
    // Terminal (pathological contention): restore the original conversation.
    if (prevActiveId) {
      try {
        await AiThread.updateMany(
          { contentId: content._id, status: 'active', ownerUserId: null },
          { $set: { status: 'archived', archivedAt: new Date() } },
        );
        await AiThread.updateOne({ _id: prevActiveId }, { $set: { status: 'active', archivedAt: null } });
      } catch { /* best effort */ }
    }
    return { error: true }; // P4 review BUG-3: failures are NOT 404s
  } catch (err) {
    console.error('[threads] activateThread failed:', err.message);
    return { error: true };
  }
}

// ─── Phase 5: retention ──────────────────────────────────────────────────

// P5 review: clamp to >= 1. `0 || 90` silently meant 90 (fine), but a
// NEGATIVE retention put the cutoff in the future — next run would delete
// every archived thread regardless of age — and a negative cap flowed into
// .limit() as "no limit".
function envPositiveInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
const THREAD_ARCHIVE_RETENTION_DAYS = envPositiveInt('THREAD_ARCHIVE_RETENTION_DAYS', 90);
// Per-run cap so a huge backlog drains over nights instead of one giant pass
// (mirrors the Phase-18C purge discipline).
const THREAD_PRUNE_MAX_PER_RUN = envPositiveInt('THREAD_PRUNE_MAX_PER_RUN', 500);

/**
 * Nightly prune of ARCHIVED threads past retention (D4). Children-first —
 * deliberately NOT a TTL index (a TTL delete on the thread cannot cascade to
 * its messages; Phase-1 review). Self-gates on the aiThreads flag like the
 * Phase-18C purge gates on dataErasure. Returns counts for the cron log.
 */
async function pruneArchivedThreads() {
  if (!(await isFlagLive('aiThreads'))) return { due: 0, threads: 0, messages: 0 };
  const cutoff = new Date(Date.now() - THREAD_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // P5 review: oldest-first so a sustained backlog drains FIFO under the cap
  // — natural order let arbitrary rows outlive retention indefinitely.
  // Served by the { status, archivedAt } index on AiThread.
  const due = await AiThread.find(
    { status: 'archived', archivedAt: { $ne: null, $lt: cutoff } },
    { _id: 1 },
  )
    .sort({ archivedAt: 1 })
    .limit(THREAD_PRUNE_MAX_PER_RUN)
    .lean();
  if (!due.length) return { due: 0, threads: 0, messages: 0 };
  const ids = due.map((t) => t._id);
  const dm = await AiThreadMessage.deleteMany({ threadId: { $in: ids } });
  const dt = await AiThread.deleteMany({ _id: { $in: ids } });
  return { due: due.length, threads: dt.deletedCount, messages: dm.deletedCount };
}

module.exports = {
  getOrCreateActiveThread,
  appendMessage,
  markSteersApplied,
  getThreadHistory,
  startNewThread,
  estimateTokens,
  shapeThreadForReplay,
  getReplayPayload,
  getActiveThreadStamp,
  sessionSeenForContent,
  maybeCompactThread,
  listThreads,
  activateThread,
  pruneArchivedThreads,
};
