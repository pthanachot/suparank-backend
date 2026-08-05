const crypto = require('crypto');
const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const BrandVoice = require('../models/BrandVoice');
const Avatar = require('../models/Avatar');
const CreditTransaction = require('../models/CreditTransaction');
const Plan = require('../models/Plan');
const AgentUsageLog = require('../models/AgentUsageLog');
const { blocksToMarkdown } = require('../services/blocksToMarkdown');
const { benchmarkToContentBrief, buildAvailableLinks, buildAllowlistUrls } = require('../services/benchmarkToContentBrief');
const { buildResearchOutlineMd, buildSeoTargetsMd, buildContentAuditMd } = require('../services/contextFileGenerators');
const { mapEditsToPatches } = require('../services/mapEditsToPatches');
const writingEngine = require('../services/writingEngine');
const { toGoPlan } = require('../services/planSerializer');
const imageStorage = require('../services/imageStorage');
const creditService = require('../services/creditService');
const { resolveCredits, agentRunCredits } = require('../config/creditRules');
const { classifyAgentRun, isPlanArticleWrite, resolveAgentRun } = require('../config/agentBilling');
const systemSettings = require('../services/systemSettingsService');
const UsageTracker = require('../models/UsageTracker');
const UserUsageTracker = require('../models/UserUsageTracker');
const costLedger = require('../services/costLedgerService');
const tierService = require('../services/tierService');
const threadService = require('../services/threadService');
const { tierToPreset } = require('../config/modelPreset');

/**
 * Resolve the tier model preset for a request (Phase 4). Free → "budget"
 * (writing-engine drops to flash-lite via the X-Model-Preset header); paid → ""
 * (base models). Best-effort — any failure yields "" (base), never blocks the call.
 */
async function resolvePreset(req) {
  const orgId = req?.creditContext?.orgId || null;
  if (!orgId) return '';
  try {
    const tier = (await tierService.getOrgTierConfig(orgId))?.tier || '';
    return tierToPreset(tier);
  } catch { return ''; }
}

// Default writing-engine models per SSE source, used only when the engine's
// usage event does not tag the serving model. Chat uses the `writer` role,
// agent uses the `agent` role — both default to gemini-2.5-flash in models.json.
// Phase 4 (tier-aware presets) will make the engine always tag the real model.
const WRITING_ENGINE_DEFAULT_MODEL = 'google/gemini-2.5-flash';
// Only used when the engine's image_usage event reports images but no model
// name (older engine build). The engine normally reports the model it resolved
// from models.json, so the ledger prices what actually ran instead of drifting
// from a hardcoded id here.
const IMAGE_MODEL_FALLBACK = 'google/gemini-2.5-flash-image';
// The engine tools that can mint an image and therefore need somewhere durable
// to put it. Mirrors the engine's own whitelistHasImageTool.
const IMAGE_TOOLS = ['ImageGenTool', 'ImageSearchTool'];

// ─── Session reuse map ───────────────────────────────────────
// Maps contentId → { sessionId, lastUsed } for conversation memory.
// When reuseSession is true, we reuse the engine session so the AI
// keeps its conversation history (like Claude Code).
const contentSessionMap = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

// Max lifetime for an in-flight agent-run registry entry (W4-b/c). A run that
// never reaches its handler's deletion (a hang inside the awaited settle/
// commit, or a stream that never terminates) would otherwise leak the entry
// forever — making run-status lie "active" and stop-revert a silent no-op.
// Generous vs the engine's ~58-turn / token-budget ceilings so it never
// evicts a genuinely-live run.
const AGENT_RUN_TTL_MS = 30 * 60 * 1000;

// Concurrent AGENT runs ONE USER may hold across all their documents. The
// shadow guard is per document, so without this a single user could hold an
// unbounded number of simultaneous runs — each an engine session, an image
// budget and a credit hold. Three is comfortably above real use (a person
// works on one document at a time, occasionally two).
//
// Scope, precisely: this counts activeAgentRuns, and CHAT runs never register
// there, so concurrent chat turns are bounded only by the per-IP limiter and
// the credit pre-deduct. Per-process too — with N backend replicas the real
// ceiling is 3N; a shared store is the multi-instance-safe version.
// AGENT_MAX_RUNS_PER_USER overrides it; values below 1 fall back to the
// default rather than blocking every run.
const MAX_RUNS_PER_USER = (() => {
  const n = parseInt(process.env.AGENT_MAX_RUNS_PER_USER, 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();

// Clean up stale sessions every 10 minutes. unref() so this housekeeping
// timer never holds the process open (tests, graceful shutdown).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of contentSessionMap) {
    if (now - entry.lastUsed > SESSION_TTL_MS) {
      contentSessionMap.delete(key);
    }
  }
  // W4-b/c: evict stale in-flight run entries (see AGENT_RUN_TTL_MS).
  for (const [key, entry] of activeAgentRuns) {
    if (now - entry.startedAt > AGENT_RUN_TTL_MS) {
      // W4-c-2 review: a detached run that never completes would otherwise pin
      // its engine reader + response forever (run-status also lies "active").
      // ABORT it at the TTL, not just forget it — this is the hard server-side
      // ceiling. The abort unwinds the handler, which deletes its own entry;
      // delete here too in case the run already errored past its abort.
      try { entry.abort?.(); } catch { /* best effort */ }
      activeAgentRuns.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

// Record that `sessionId` is a live engine session for `contentId`. Keeps a
// BOUNDED SET of recent sessionIds per content (not just the latest) alongside
// the primary `sessionId` (used for reuse/resync) and `lastUsed` (used by the
// sweep). The set lets the resume tenancy check accept a still-paused session
// even after a concurrent setupSession (a second tab, image-gen, or a
// non-reusing chat/agent run) mints a newer session for the SAME content —
// otherwise answering the paused session would spuriously 409.
function rememberSession(contentId, sessionId) {
  const existing = contentSessionMap.get(contentId);
  const sessionIds = existing?.sessionIds || new Set();
  sessionIds.add(sessionId);
  // Bound growth defensively; the whole entry is evicted by the TTL sweep.
  while (sessionIds.size > 32) {
    sessionIds.delete(sessionIds.values().next().value);
  }
  contentSessionMap.set(contentId, { sessionId, lastUsed: Date.now(), sessionIds });
}

// Threads Phase 2: register a ONE-SHOT session (chat turns) in the tenancy
// set WITHOUT replacing the primary. Pre-fix, every chat turn's fresh session
// became the primary via rememberSession — silently truncating the freeform
// agent's warm-session memory chain (Phase-1 review finding). With no
// existing entry there is nothing to protect, so the session becomes the
// primary normally.
function rememberSessionSecondary(contentId, sessionId) {
  const existing = contentSessionMap.get(contentId);
  if (!existing || !(existing.sessionIds instanceof Set)) {
    rememberSession(contentId, sessionId);
    return;
  }
  existing.sessionIds.add(sessionId);
  while (existing.sessionIds.size > 32) {
    existing.sessionIds.delete(existing.sessionIds.values().next().value);
  }
  existing.lastUsed = Date.now();
}

/**
 * Conversations Phase 4 — MAKE FORGETTING REAL.
 *
 * Drop this content's warm engine session so the next run mints a fresh one.
 *
 * THE PROBLEM. The engine has no `deleteSession`; the only way to displace a
 * session's conversation is a REPLACING seed (`POST /session/{id}/messages`,
 * which is a full `DELETE FROM messages` + re-insert). But `taskSeed` skips
 * seeding entirely when the active thread is empty or gone —
 * `getActiveThreadStamp` returns null and it returns early. So removing a
 * conversation from Mongo does NOT remove it from the warm engine session: the
 * next freeform run reuses that session and answers from a conversation the
 * user just deleted.
 *
 * THE FIX, and why eviction is enough. Deleting the map entry means
 * `setupSession` finds nothing to reuse, calls `createSession`, and
 * `rememberSession` installs a REPLACEMENT entry with no `pushHashes`. The skip
 * guard reads hashes only when `entry.sessionId === sessionId`, so a fresh
 * session can never inherit the old one's hashes — document, brief, context
 * files, brand voice and mode are all re-pushed. The orphaned engine session
 * holds the old conversation but is now unreachable, and ages out on the
 * engine's own 1-hour idle TTL.
 *
 * Costs one full setup (~6-8 engine round trips) on the next run. That is the
 * price of the guarantee, and it is paid once per destructive thread action.
 *
 * WHAT THIS DOES NOT DO. The engine's SQLite retains `messages` for
 * ENGINE_DB_RETENTION_DAYS (default 14) regardless. A Mongo delete is not a
 * full erasure, and any UI that implies otherwise is overclaiming.
 *
 * Also drops the `sessionIds` tenancy set, so a catch-up for a detached run on
 * the OLD session will fail its tenancy check. Both callers 409 while a run is
 * in flight, so that window requires a run that finished, went un-caught-up,
 * and was then followed by a destructive action.
 */
function forgetSession(contentId) {
  contentSessionMap.delete(contentId);
}

// Resume tenancy: is `sessionId` one of the recent sessions bound to THIS
// content? Rejects an arbitrary / other-content engine sessionId while
// tolerating concurrent same-content session creation.
function sessionBoundToContent(contentId, sessionId) {
  const bound = contentSessionMap.get(contentId);
  return !!bound && bound.sessionIds instanceof Set && bound.sessionIds.has(sessionId);
}

/**
 * Build a lightweight tap that scans SSE bytes for `usage` events and
 * accumulates input/output token counts across the stream. Go emits one
 * usage event per agent turn with per-turn counts (see query.go:497-503),
 * so we sum them. The tap is *read-only* — the raw bytes still go to
 * `res.write` unchanged; we just observe them in flight.
 */
/**
 * Stop reasons that mean the run was CUT OFF mid-work by a ceiling, as opposed
 * to ending on its own terms. Sources, all engine-side:
 *   max_turns, token_budget, output_limit  → query.go
 *   max_edits                              → strategy_execute.go
 *   max_iterations                         → strategy_sequential.go
 *
 * Mirrors the `truncated` map in the frontend's completionChip. The two are
 * hand-kept in step; a reason added to one and not the other degrades a message
 * rather than breaking a run, which is why this is a duplicated constant and
 * not a shared fixture.
 *
 * NOT in this set, deliberately: nudges_exhausted and stale. Those describe a
 * model that stopped calling tools, which over 48 measured /auto-optimize runs
 * was the NORMAL way a successful run ended — 42 of 48, every one of them with
 * edits applied. Treating them as failures is the exact error completionChip
 * was written to correct.
 */
const TRUNCATED_STOPS = new Set([
  'max_turns', 'max_edits', 'max_iterations', 'token_budget', 'output_limit',
]);

function makeUsageTap() {
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let model = '';
  let docWrites = 0;
  // W4-c prerequisite: capture the run's terminal metadata from the complete
  // event so the run record (AgentUsageLog) can persist stopReason — the
  // future catch-up UI needs to tell a finished run from a died one.
  let stopReason = '';
  // Threads Phase 1: accumulate the run's ASSISTANT TEXT across the whole
  // stream. `complete.fullText` is last-turn-only (the engine's accumulator
  // resets per turn), and the engine's message list is unusable as a capture
  // source (compacted mid-run, no run markers, wiped by sequential runs) —
  // the tap is the canonical capture point. Chat streams `text_delta`;
  // freeform-agent text turns stream `agent_commentary` (same textDelta
  // payload field). tool_start marks a turn boundary → new segment.
  let segments = [];
  let currentSegment = '';
  let lastFullText = '';
  let turns = 0;
  let steeringApplied = false;
  // UX-2 Phase 2 (reload consistency): the engine's completion carries the
  // model's closing message (finalText). For COMMENTARY-mode runs (agent/
  // sequential — no text_delta ever streams) the live FE renders exactly that
  // as the reply bubble, so the thread must record the same text or a reload
  // would swap the bubble for the joined working narration. Chat runs stream
  // text_delta into the transcript live, so THEIR record stays the joined
  // deltas — sawTextDelta picks the branch.
  let completionFinalText = '';
  let sawTextDelta = false;
  // Phase 3 (image COGS): images are billed PER IMAGE by the provider, so they
  // contribute no tokens and were invisible to this tap — the most expensive
  // operation the engine performs recorded $0.00. The engine emits one
  // terminal `image_usage` event per run carrying the RUN total (the
  // completion payload's count predates the post-agent pass and would
  // undercount). Read only this event, so nothing can double-count.
  let images = 0;
  let imageModel = '';
  return {
    addChunk(buf) {
      buffer += buf.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]' || data[0] !== '{') continue;
        try {
          const ev = JSON.parse(data);
          if (ev && (ev.type === 'text_delta' || ev.type === 'agent_commentary') && typeof ev.textDelta === 'string') {
            currentSegment += ev.textDelta;
            if (ev.type === 'text_delta') sawTextDelta = true;
          } else if (ev && ev.type === 'steering_applied') {
            steeringApplied = true;
          }
          if (ev && ev.type === 'complete') {
            if (typeof ev.fullText === 'string' && ev.fullText) lastFullText = ev.fullText;
          }
          if (ev && ev.type === 'complete' && ev.completion && typeof ev.completion.stopReason === 'string') {
            stopReason = ev.completion.stopReason;
            // UX-2: capture the closing message only from clean "done" stops —
            // mirrors the FE's display gate (on truncation/stale exits the
            // engine's finalText may be mid-work narration).
            if (ev.completion.stopReason === 'done'
                && typeof ev.completion.finalText === 'string' && ev.completion.finalText.trim()) {
              completionFinalText = ev.completion.finalText.trim();
            }
          }
          // Review (capture BUG-1/BUG-4): the engine emits exactly ONE usage
          // event per successful turn, AFTER that turn's text — the only true
          // turn boundary on the wire. Sealing here (not on tool_start, which
          // fires per tool CALL and misses text→text turns around nudges/
          // steers) keeps consecutive text turns from fusing char-to-char,
          // and `turns` counts real turns, not tool invocations.
          if (ev && ev.type === 'usage' && ev.usage) {
            if (currentSegment.trim()) segments.push(currentSegment.trim());
            currentSegment = '';
            turns++;
          }
          // W4-c (review V5): the token-budget / output-limit caps emit an
          // `error` event (with a code) and break WITHOUT a `complete` event,
          // so the run record would otherwise store stopReason=''. Threads
          // P1 review (CAVEAT-5): capture ANY coded error, not just the two
          // W4 knew about — an api_error run's partial text was otherwise
          // indistinguishable from a clean reply in the thread record.
          if (ev && ev.type === 'error' && typeof ev.code === 'string' && ev.code) {
            stopReason = ev.code;
          }
          // Terminal image-spend report. fullText carries the JSON payload,
          // matching how the engine ships other structured events
          // (agent_progress). Last one wins — there is exactly one per run.
          if (ev && ev.type === 'image_usage' && typeof ev.fullText === 'string') {
            try {
              const usage = JSON.parse(ev.fullText);
              // Clamped, not just coerced. `Number(x) || 0` still admits
              // Infinity (JSON.parse turns 1e999 into it) and negatives, and
              // this value is multiplied into a currency figure: one Infinity
              // row makes every $sum over that window Infinity forever, and a
              // negative would credit the org. The engine is trusted, but
              // IMAGE_BUDGET_PER_RUN is operator-settable and the clamp is free.
              const n = Number(usage.images);
              images = Number.isFinite(n) ? Math.max(0, Math.min(500, Math.round(n))) : 0;
              if (typeof usage.model === 'string') imageModel = usage.model;
            } catch { /* malformed payload — leave the count at 0 */ }
          }
          if (ev && ev.type === 'usage' && ev.usage) {
            // Go emits snake_case (input_tokens/output_tokens) — see
            // writing-engine api.Usage json tags. Accept camelCase too for
            // resilience. (Pre-fix this read only camelCase and silently
            // captured 0 for every turn.)
            inputTokens += Number(ev.usage.input_tokens ?? ev.usage.inputTokens) || 0;
            outputTokens += Number(ev.usage.output_tokens ?? ev.usage.outputTokens) || 0;
            // The engine tags the serving model on the usage event; keep the last.
            if (ev.model) model = ev.model;
          } else if (ev && ev.type === 'document_diff') {
            // Phase 6 article gate: server-observed document writes. ONLY
            // document_diff proves an APPLIED change (streaming_executor emits
            // it on successful mutations; engine.go on the image pass).
            // document_update means the doc-mutating tool ran but changed
            // NOTHING (failed EditTool old_string, step-by-step SKIP/REJECT
            // revert) — counting it charged 100 + an article slot for a
            // byte-identical doc (review MAJOR-3). 'draft' is a frontend-legacy
            // type the Go engine never emits.
            docWrites++;
          }
        } catch { /* malformed event — skip */ }
      }
    },
    snapshot() {
      return { inputTokens, outputTokens, model, docWrites, stopReason, images, imageModel };
    },
    // Threads Phase 1: the run's full assistant text (all text turns joined),
    // with the last complete.fullText as fallback ("Cancelled" is deliberately
    // NOT text the model wrote — never fall back to it when segments exist).
    // P2 fidelity review (BUG-1 defense-in-depth): consecutive IDENTICAL
    // segments collapse to one — a nudged model re-stating its answer verbatim
    // must not persist the duplicate into the thread it will be re-seeded from.
    finalAssistantText() {
      // UX-2 Phase 2: commentary-mode runs record the closing message the
      // live bubble showed — not the joined narration (which the FE keeps
      // session-only behind the "Working" toggle). Chat runs (sawTextDelta)
      // keep the full joined deltas: their live transcript showed all of it.
      if (completionFinalText && !sawTextDelta) return completionFinalText;
      // A TRUNCATED commentary run has no closing message (completionFinalText
      // is captured only on stopReason === 'done') and its trailing segments are
      // a PROMISE, not a summary: the ceiling landed mid-work, so the last thing
      // the model said is "First, I will update the Overview section", wrapped
      // in internal tool names and retry chatter. Persisting that made a reload
      // replay a wall of first-person commentary over a run that delivered
      // nothing — the live UI showed only "⚠ Turn limit reached".
      //
      // Scoped to TRUNCATED_STOPS on purpose. An earlier version of this guard
      // keyed on `stopReason !== 'done'`, which swept in nudges_exhausted and
      // stale — 42 of 48 measured runs, all of which had applied edits — and
      // replaced their genuine wrap-up text with a robotic run summary. Whether
      // the run was cut off is the question; "did it end on the happy path"
      // is not.
      //
      // Chat runs are excluded: their deltas streamed into the transcript live,
      // so the record must match what the user already read.
      if (!sawTextDelta && TRUNCATED_STOPS.has(stopReason)) return '';
      const all = [...segments];
      if (currentSegment.trim()) all.push(currentSegment.trim());
      const deduped = all.filter((seg, i) => i === 0 || seg !== all[i - 1]);
      const joined = deduped.join('\n\n').trim();
      if (joined) return joined;
      return lastFullText === 'Cancelled' ? '' : lastFullText.trim();
    },
    steeringWasApplied() {
      return steeringApplied;
    },
    turnCount() {
      return turns;
    },
  };
}

/**
 * Persist the accumulated usage at stream end. Best-effort: a failed write
 * must NOT block the response that already went to the user.
 */
async function persistUsage(req, content, tap, source, runMeta = {}) {
  const totals = tap.snapshot();
  // `|| images` : image calls bill per image and carry no tokens, so a run
  // whose only measurable spend was images would otherwise return here and
  // record nothing at all — the exact blind spot this phase closes.
  if (totals.inputTokens === 0 && totals.outputTokens === 0 && !totals.images) return;
  AgentUsageLog.create({
    workspaceId: content.workspaceId,
    contentId: content._id,
    contentType: content.contentType || '',
    mode: content.mode || 'chat',
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    source,
    // W4-c prerequisite run-record fields: what the future catch-up UI reads.
    // stopReason '' + aborted=true ⇒ the stream died/was stopped mid-run.
    sessionId: runMeta.sessionId || '',
    runId: runMeta.runId || '', // P4: unambiguous run identity (sessions are reused)
    stopReason: totals.stopReason || '',
    docWrites: totals.docWrites || 0,
    images: totals.images || 0,
    aborted: !!runMeta.aborted,
    completedAt: new Date(),
  }).catch((err) => {
    // Never throw past the SSE response — observability hygiene only.
    console.warn('[usage-tap] persist failed', err.message);
  });

  // AI cost ledger (Phase 1): our real COGS for this chat/agent turn.
  try {
    const orgId = req?.creditContext?.orgId || null;
    let tier = '';
    if (orgId) {
      try { tier = (await tierService.getOrgTierConfig(orgId))?.tier || ''; } catch { /* best-effort */ }
    }
    costLedger.record({
      action: source, // 'chat' | 'agent'
      model: totals.model || WRITING_ENGINE_DEFAULT_MODEL,
      tokensIn: totals.inputTokens,
      tokensOut: totals.outputTokens,
      organizationId: orgId,
      workspaceId: content.workspaceId,
      userId: req?.user?.userId || null,
      tier,
      metadata: { contentId: content._id?.toString(), source },
    });

    // Images get their OWN row, never folded into the one above. That row's
    // model is the TEXT model: passing `images` alongside it would price the
    // images at the text model's flat rate (usually absent ⇒ $0) and, for a
    // flat-priced model, would REPLACE the token cost entirely. Mirrors the
    // per-image row the standalone /ai/generate-image route already writes.
    if (totals.images > 0) {
      costLedger.record({
        action: 'image',
        model: totals.imageModel || IMAGE_MODEL_FALLBACK,
        images: totals.images,
        organizationId: orgId,
        workspaceId: content.workspaceId,
        userId: req?.user?.userId || null,
        tier,
        // Phase 6: the count now has a real `images` column on the ledger, so
        // it aggregates (imageSpendByOrg) instead of being recoverable only as
        // costUsd/unit-price — which broke the moment the price changed. The
        // metadata copy stays: it predates the column, so it is the only count
        // on rows written before it existed, and re-deriving those from cost is
        // exactly the fragile step the column removes.
        //
        // The mismatch this row still carries: one-shot /ai/generate-image
        // writes ONE row per image, while this writes one row for a whole run —
        // so `rows` is not an image count on either path, and the column is.
        // runId keeps this joinable to AgentUsageLog, which is pruned at 90 days.
        metadata: {
          contentId: content._id?.toString(),
          source,
          images: totals.images,
          runId: runMeta.runId || '',
        },
      });
    }
  } catch (e) {
    console.warn('[costLedger] chat/agent skipped:', e.message);
  }
}

// ─── Article count-gate (Phase 6, money#1) ───────────────────
// "Regeneration consumes a slot on all tiers" (product decision). The FIRST
// successful generation on a doc is covered by the content-creation counter;
// every RE-generation decrements the article allowance (Free: 3 lifetime,
// paid: monthly). Failed/aborted runs never count — the counter moves on
// COMPLETION, alongside the credit settle.
//
// The 429 body copy below is user-facing: EditorChatBar renders `error`
// verbatim in the chat, so this text and the UI block message agree by
// construction. Keep it in sync with the pre-run warning copy in
// EditorChatBar.tsx (Free auto-write confirm).

async function checkArticleAllowance(req, content) {
  const isFirstGen = !content.articleGeneratedAt;
  const orgId = req.creditContext?.orgId || req.workspace?.organizationId || null;
  if (!orgId) return { isFirstGen, blocked: false, quotaCtx: null };

  const { tier, config } = await tierService.getOrgTierConfig(orgId);
  const limit = config?.maxArticlesPerMonth;
  const limitType = config?.articleLimitType || 'monthly';
  const period = tierService.getPeriod(limitType);
  const isUserLevel = !!(limitType === 'lifetime' && req.user?.userId);
  const quotaCtx = { orgId, userId: req.user?.userId, counterKey: 'articlesCreated', period, isUserLevel };

  // First generation on this doc: covered by the creation count — no check,
  // no decrement (the completion handler stamps articleGeneratedAt instead).
  if (isFirstGen || limit == null) return { isFirstGen, blocked: false, quotaCtx };

  const used = isUserLevel
    ? await UserUsageTracker.getCount(req.user.userId, 'articlesCreated')
    : await UsageTracker.getCount(orgId, 'articlesCreated', period);

  if (used >= limit) {
    const isFree = tier === 'free';
    return {
      isFirstGen,
      blocked: true,
      payload: {
        error: isFree
          ? `You've used all ${limit} articles included in the free plan (regenerating an article uses a slot). Upgrade to keep writing — paid plans start at 20 articles per month.`
          : `You've reached your plan's monthly article limit (${used} of ${limit} used — regenerations count too). Your allowance resets next billing cycle, or upgrade for a higher limit.`,
        code: 'ARTICLE_LIMIT_REACHED',
        quota: { used, limit, tier, limitKey: 'maxArticlesPerMonth', limitType },
        upgradeUrl: '/pricing',
      },
    };
  }
  return { isFirstGen, blocked: false, quotaCtx };
}

/**
 * On successful completion of a run that ACTUALLY wrote the document: stamp
 * the generation (articleGeneratedAt + which plan produced it — each approved
 * plan buys exactly one generation), and count the re-generation against the
 * article allowance. First-gen stamps without counting (creation counted it).
 */
async function commitArticleGeneration(content, gate) {
  try {
    // Re-read the CURRENT plan state — the doc was loaded at request start and
    // the run takes minutes; a plan approved/reopened mid-run would otherwise
    // stamp a stale (or null) plan id, leaving the new plan's one-generation
    // credit unconsumed and re-billable (review MINOR-8).
    let cur = content;
    try {
      const fresh = await Content.findById(content._id).select('mode activePlanId').lean();
      if (fresh) cur = fresh;
    } catch { /* fall back to the request-time snapshot */ }
    await Content.findByIdAndUpdate(content._id, {
      $set: {
        articleGeneratedAt: new Date(),
        articleGeneratedPlanId: cur.mode === 'execute' ? (cur.activePlanId || null) : null,
      },
    });
    if (!gate.isFirstGen && gate.quotaCtx) {
      await tierService.incrementQuota(gate.quotaCtx);
    }
  } catch (e) {
    console.error('[article-gate] commit failed (non-fatal):', e.message);
  }
}

// Per-mode default tool allowlist for setupSession's pushMode call. Go's
// FilterByMode is the authoritative source — these mirror it but let
// Express tighten further in the future (e.g. trial-tier feature gating).
// Empty array means "let Go default from the mode."
const MODE_ALLOWED_TOOLS = {
  chat: [],
  plan: [],
  execute: [],
};

// Workspace resolved by permissions middleware (req.workspace).
// This helper finds the content within that workspace.
async function resolveContent(req, res) {
  const { contentNumber } = req.params;
  // W2-d: the agent route's credit estimator (estAgent) already fetched this
  // exact document — reuse it instead of a second identical indexed read.
  const pre = req._prefetchedContent;
  const content = (pre && String(pre.contentNumber) === String(contentNumber))
    ? pre
    : await Content.findByNumber(req.workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  // B4: locked content must not accept AI ops (chat/agent/image/inline-edit) or
  // leak its data to the engine/LLM. Same gate as contentController.getContent,
  // applied here BEFORE any session/credit work so a blocked run costs nothing.
  if (content.locked) {
    res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });
    return null;
  }
  return content;
}

/**
 * Set up a Writing Engine session with document + brief + brand voice.
 * Returns { sessionId, markdown } or throws.
 *
 * @param {Object} content - Content document from MongoDB
 * @param {Object} [opts]
 * @param {string} [opts.avatarId] - Selected avatar ID (optional)
 * @param {boolean} [opts.reuseSession] - Reuse existing session for conversation memory
 */
/**
 * W0 timing helper: run fn(), recording its duration under `label` in the
 * timings map. Failures propagate unchanged — timing must never alter
 * control flow.
 */
async function timed(timings, label, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    timings[label] = (timings[label] || 0) + (Date.now() - t0);
  }
}

/** W2-b: content hash for push-skip decisions (safe subset only). */
function pushHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * W2-b: record how many engine-side document writes the last run made for
 * this content. The document push may be skipped ONLY when the FE markdown
 * is unchanged AND this is 0 — after any engine write the engine's copy is
 * ahead of what we last pushed, and re-pushing is how FE stays authoritative.
 */
// ─── W4-b/c: in-flight agent-run registry ────────────────────────────────
// One entry per streaming agent run: powers the stop-&-revert intent flag
// (billing honors an EXPLICIT revert — refund + no article slot — while plain
// disconnects keep the docWrites anti-abuse guard) and the run-status
// endpoint. markdownBefore is the pre-run document, used to restore the
// ENGINE's copy on revert so the revert is real server-side, not just a
// client-side setBlocks.
const activeAgentRuns = new Map(); // contentId → { sessionId, markdownBefore, startedAt, revertIntent }

// P4 review BUG-2: per-content THREAD-WRITE lock. activeAgentRuns only covers
// agent runs (registered late, deleted early at the W4-b V3 point — before
// the convergence append), and CHAT runs never register at all. An
// archive/activate landing between a run's user append and its assistant
// append splits the pair across threads: the reply re-resolves onto the
// newly active thread as a contextless foreign row. Both run handlers hold
// this from just before their user append until after the convergence
// append (finally); newThread/activateThread 409 while held.
const threadWriteLocks = new Map(); // contentId → count
function lockThreadWrites(contentId) {
  threadWriteLocks.set(contentId, (threadWriteLocks.get(contentId) || 0) + 1);
}
function unlockThreadWrites(contentId) {
  const n = (threadWriteLocks.get(contentId) || 1) - 1;
  if (n <= 0) threadWriteLocks.delete(contentId);
  else threadWriteLocks.set(contentId, n);
}

function recordRunDocWrites(contentId, sessionId, docWrites) {
  const entry = contentSessionMap.get(contentId);
  // Review fix (W2-1b): guard on the run's OWN session. A concurrent setup on
  // the same content may have REPLACED the map entry with a newer session —
  // an orphaned older run must lose its record (safe: next setup re-pushes)
  // rather than clobber the live session's marker back to 0 and re-arm a
  // document-push skip while that session's engine copy is ahead.
  if (entry && entry.sessionId === sessionId) entry.lastRunDocWrites = docWrites;
}

/**
 * P2 (review BUG-2): advance the seeding marker past a freeform run's own
 * thread rows — ONLY when the interval it would cover is exactly this run's
 * user+assistant pair, CONTIGUOUS from the current marker. Any interleaved
 * foreign row (a second tab's chat turn, another user on the shared thread)
 * or this run's own side-channel rows (steer/clarify — separate requests we
 * don't track here) leaves the marker stale, which re-seeds next run (3ms).
 * An over-eager bump would instead hide the interleaved rows from the warm
 * session INDEFINITELY (each later run's own bump keeps stamp == marker) —
 * always err toward re-seeding. Exported for tests.
 */
function maybeBumpSeededMarker(contentId, sessionId, userAppended, assistantAppended) {
  if (!userAppended || !assistantAppended) return false;
  const entry = contentSessionMap.get(contentId);
  if (!entry || entry.sessionId !== sessionId || !entry.seeded) return false;
  if (entry.seeded.threadId !== assistantAppended.threadId) return false;
  if (userAppended.threadId !== assistantAppended.threadId) return false;
  // Contiguity: marker → user → assistant with nothing in between.
  if (userAppended.seq !== entry.seeded.seq + 1) return false;
  if (assistantAppended.seq !== userAppended.seq + 1) return false;
  entry.seeded.seq = assistantAppended.seq;
  return true;
}

async function setupSession(content, { avatarId, reuseSession, secondary, memoryRun = true } = {}) {
  const contentId = content._id.toString();
  let sessionId;
  // W0: per-push timing map, logged as one [timing] line at the end so a
  // slow setup is diagnosable to the specific engine hop / Mongo fetch.
  const timings = {};
  const tSetup = Date.now();
  let reused = false;

  // Reuse existing session if available (conversation memory)
  if (reuseSession) {
    const existing = contentSessionMap.get(contentId);
    if (existing) {
      existing.lastUsed = Date.now();
      sessionId = existing.sessionId;
      reused = true;
    }
  }

  // Create new session if needed. Threads P2: `secondary` (chat turns) joins
  // the tenancy set without dethroning the warm primary — a chat turn must
  // not truncate the agent's memory chain.
  if (!sessionId) {
    sessionId = await timed(timings, 'createSession', () => writingEngine.createSession());
    if (secondary) rememberSessionSecondary(contentId, sessionId);
    else rememberSession(contentId, sessionId);
  }

  // W2-b: per-session push hashes. rememberSession REPLACES the map entry on
  // session creation, so a fresh session always starts with empty hashes
  // (never skips). Skips are restricted to the review-verified SAFE subset —
  // document (guarded), brandVoice, imageStyle, mode, plan — all of which the
  // engine rehydrates from its DB after a restart. brief / context files /
  // CFS config are NOT skippable: the engine does NOT rehydrate them on the
  // run path, and a restarted engine returns 200 (not 404), so a hash-skip
  // there would silently run the agent with an empty brief.
  const entry = contentSessionMap.get(contentId);
  let hashes = entry && entry.sessionId === sessionId ? (entry.pushHashes ||= {}) : {};
  const skipped = [];

  const markdown = blocksToMarkdown(content.blocks || []);

  // ── W2-a: parallel fan-out ────────────────────────────────────────────
  // The pushes and their Mongo prefetches are independent (engine session
  // fields are individually mutex-guarded; the run is only submitted after
  // ALL of these settle, so cross-push ordering doesn't matter — the old
  // "mode before plan" comment was disproven in review). createSession is
  // the only hard prerequisite and completed above.
  //
  // Wrapped in runFanout() so a REUSED session the engine has since evicted
  // (redeploy with a fresh store, or the engine's own session TTL — more
  // reachable now that W5-b autocomplete seeds bare sessions for content the
  // user is merely typing in) can be recreated and the WHOLE fan-out retried
  // once. The pushes run in parallel against `sessionId`, so recovering only
  // the document push would leave the siblings pointed at the dead session —
  // hence a fan-out-level retry, not a per-push one. Mirrors setupSessionLite.
  const runFanout = () => {
    // 2. Document push (FATAL on failure, as before).
    const taskDocument = async () => {
      if (!markdown) return;
      const h = pushHash(markdown);
      if (hashes.document === h && entry?.lastRunDocWrites === 0) {
        skipped.push('document');
        return;
      }
      await timed(timings, 'pushDocument', () => writingEngine.pushDocument(sessionId, markdown));
      hashes.document = h;
    };

    // 3. Brief assembly + push (FATAL on failure, as before). Context files
    // need the ASSEMBLED brief, so hand it over via a promise that resolves
    // even when this task throws (else allSettled would hang on taskContext).
    let briefResolve;
    const briefReady = new Promise((resolve) => { briefResolve = resolve; });
    const taskBrief = async () => {
      try {
        const brief = benchmarkToContentBrief(content);

        // 3b. Style-reference article → authorContext (STYLE ONLY header).
        // B4: never feed a LOCKED reference's text to the LLM.
        if (content.styleReferenceContentNumber) {
          const ref = await timed(timings, 'styleRefLookup', () => Content.findByNumber(
            content.workspaceId,
            content.styleReferenceContentNumber,
          ));
          if (ref && !ref.locked && Array.isArray(ref.blocks) && ref.blocks.length > 0) {
            const refMd = blocksToMarkdown(ref.blocks);
            if (refMd.trim()) {
              const styleBlock =
                `\n\n---\n## Writing style reference (STYLE ONLY — do NOT copy topics or facts)\n` +
                `Match the tone, voice, sentence rhythm, paragraph pacing, and formality of ` +
                `the following reference article written by the same author. The reference is ` +
                `about a DIFFERENT topic — do NOT reuse any of its facts, examples, structure, ` +
                `headings, or subject matter. Only emulate HOW it's written.\n\n` +
                `### Reference: "${ref.title || 'Untitled'}"\n\n` +
                refMd;
              brief.authorContext = (brief.authorContext || '') + styleBlock;
            }
          }
        }

        // 3c. Internal-link inventory (non-fatal — engine skips the signal).
        try {
          const workspaceId = content.workspaceId || content.workspace;
          brief.availableLinks = await timed(timings, 'buildLinks', () => buildAvailableLinks(
            workspaceId,
            brief.targetKeyword,
            brief.secondaryKeywords,
          ));
          // R3: full crawled-URL allowlist for hallucination classification.
          brief.allowlistUrls = await timed(timings, 'buildLinks', () => buildAllowlistUrls(workspaceId));
        } catch (err) {
          console.error('availableLinks build failed (non-fatal):', err.message);
        }

        briefResolve(brief);
        await timed(timings, 'pushBrief', () => writingEngine.pushBrief(sessionId, brief));
      } catch (err) {
        briefResolve(null); // unblock taskContextFiles; brief failure stays fatal
        throw err;
      }
    };

    // 4. Context files (non-fatal, needs the assembled brief).
    const taskContextFiles = async () => {
      const brief = await briefReady;
      if (!brief) return; // brief assembly failed — its error is already fatal
      try {
        const contextFiles = {};
        if (content.recommendedOutline || content.competitorPages?.length || content.peopleAlsoAsk?.length) {
          contextFiles['research-outline.md'] = buildResearchOutlineMd(content);
        }
        if (brief.nlpTerms?.length || brief.secondaryKeywords?.length || brief.targetKeyword) {
          contextFiles['seo-targets.md'] = buildSeoTargetsMd(brief);
        }
        const latestAudit = content.audits?.[content.audits.length - 1];
        if (latestAudit) {
          const auditMd = buildContentAuditMd(latestAudit);
          if (auditMd) contextFiles['content-audit.md'] = auditMd;
        }
        if (Object.keys(contextFiles).length > 0) {
          await timed(timings, 'pushContextFiles', () => writingEngine.pushContextFiles(sessionId, contextFiles));
        }
      } catch (err) {
        console.error('Context files push failed (non-fatal):', err.message);
      }
    };

    // 5. Brand voice + image style (non-fatal; both W2-b skippable).
    const taskBrandVoice = async () => {
      try {
        const workspaceId = content.workspaceId || content.workspace;
        const [brandVoice, avatar] = await Promise.all([
          timed(timings, 'brandVoiceLookup', () => BrandVoice.findOne({ workspace: workspaceId, active: true }).lean()),
          avatarId
            ? Avatar.findOne({ _id: avatarId, workspace: workspaceId, active: true }).lean()
            : Promise.resolve(null),
        ]);
        let combinedMarkdown = '';
        if (brandVoice && brandVoice.content) combinedMarkdown += brandVoice.content;
        if (avatar && avatar.content) {
          combinedMarkdown += (combinedMarkdown ? '\n\n---\n\n' : '') + avatar.content;
        }

        if (combinedMarkdown.trim()) {
          const h = pushHash(combinedMarkdown);
          if (hashes.brandVoice === h) {
            skipped.push('brandVoice');
          } else {
            await timed(timings, 'pushBrandVoice', () => writingEngine.pushBrandVoice(sessionId, combinedMarkdown));
            hashes.brandVoice = h;
          }
        }

        // Image style: pushed (even empty) so a reused session is CLEARED when
        // the user removes the style — skipped only when unchanged for this
        // exact session.
        const style = brandVoice?.imageStyle || '';
        const sh = pushHash(style);
        if (hashes.imageStyle === sh) {
          skipped.push('imageStyle');
        } else {
          await timed(timings, 'pushImageStyle', () => writingEngine.pushImageStyle(sessionId, style));
          hashes.imageStyle = sh;
        }
      } catch (err) {
        console.error('Brand voice push failed (non-fatal):', err.message);
      }
    };

    // 6. Plan-mode orchestration: mode + plan + CFS. Aggregated and non-fatal,
    //    EXCEPT a failed non-chat mode push, which aborts setup (see below).
    const taskPlanMode = () =>
      timed(timings, 'planModeContext', () => pushPlanModeContext(sessionId, content, timings, hashes, skipped));

    // 7. Threads Phase 2: seed the session's conversation from the durable
    // thread (THE SEEDING INVARIANT). A session's history is valid only when
    // its `seeded` marker matches the active thread's identity AND covers its
    // newest durable message; otherwise re-seed. One rule covers: fresh
    // sessions, backend restarts (marker gone), thread switch / New
    // conversation (threadId mismatch), chat turns advancing the thread on a
    // separate session (seq stale), and sequential-run history wipes (their
    // sessions are never marked seeded). FATAL like document/brief — memory
    // is a contract now, not best-effort. The in-flight turn's user message
    // is excluded BY ORDERING (handlers append it after setupSession).
    const taskSeed = async () => {
      // P2 review BUG-1: sequential/parallel runs are OUTSIDE the memory
      // contract (D5) — the engine runs them on a nil baseline and full-
      // rewrites their session history afterward, DESTROYING any seed. The
      // old code seeded + marked them anyway; the wipe then hid behind a
      // current-looking marker and the NEXT freeform run skipped its re-seed
      // over gutted history (silent wrong memory, triggered by every slash
      // command). Non-memory runs skip seeding entirely (the engine would
      // never read it) and never set a marker — their fresh primary entry
      // stays unmarked, so the next freeform run re-seeds. Capture of these
      // runs into the thread is unaffected.
      if (!memoryRun) return;
      const stamp = await threadService.getActiveThreadStamp(contentId);
      if (!stamp) return; // flag off / no thread / empty — nothing to seed
      const e = contentSessionMap.get(contentId);
      const marker = e && e.sessionId === sessionId ? e.seeded : null;
      if (reused && marker && marker.threadId === stamp.threadId && marker.seq >= stamp.lastSeq) {
        skipped.push('seed');
        return;
      }
      const payload = await threadService.getReplayPayload(content._id);
      if (!payload || !payload.messages.length) return;
      try {
        await timed(timings, 'seedMessages', () => writingEngine.seedMessages(sessionId, payload.messages));
      } catch (err) {
        // Engine 409 = a run (typically a detached one still draining) holds
        // this warm session's single-flight lock. Pre-P2 the same collision
        // surfaced as the engine's friendly busy bounce at run start; keep
        // that UX — rewrite the message and let the handler map err.status.
        if (err.status === 409) {
          err.message = 'Another AI run is still working on this document — wait for it to finish (or stop it), then try again.';
        }
        throw err;
      }
      // Review BUG-2: the marker records what was ACTUALLY REPLAYED
      // (payload.lastSeq = max fetched row seq), NOT the stamp. A concurrent
      // append can allocate its seq (bumping the stamp's counter) before its
      // row lands — a stamp-based marker would then claim coverage of a row
      // the seed never contained, and the skip check would hide that turn
      // from the warm session FOREVER. A lagging marker merely re-seeds next
      // run (3ms) — always err on the side of re-seeding.
      const eNow = contentSessionMap.get(contentId);
      if (eNow && eNow.sessionId === sessionId) {
        eNow.seeded = { threadId: payload.threadId, seq: payload.lastSeq };
      }
    };

    return Promise.allSettled([
      taskDocument(), taskBrief(), taskContextFiles(), taskBrandVoice(), taskPlanMode(), taskSeed(),
    ]);
  };

  let results = await runFanout();

  // A REUSED session the engine no longer holds → its (unskipped) pushes 404.
  // Recreate a fresh session and retry the fan-out ONCE. A fresh session starts
  // with EMPTY hashes so nothing is skipped (the doc/brief WILL be pushed and so
  // WILL surface a real 404, not silently skip) — and `reused=false` here means
  // the retry itself can never recurse. Only fires on the fatal (document/brief)
  // pushes; a genuine non-404 error still aborts.
  // Threads P2: the seed task (index 5) joins BOTH positional lists — a 404
  // from a reused-but-evicted session must trigger the recreate-retry, and a
  // seed failure is FATAL (running without contracted memory silently answers
  // as an amnesiac; the run would look fine and be wrong).
  const isGone = (r) => r.status === 'rejected' && r.reason?.status === 404;
  // results[4] (planMode) joins the list now that a non-chat pushMode is fatal.
  // It is the ONLY fatal push that is not hash-skippable when the mode changes,
  // so on a reused-but-evicted session with an unchanged document and no brief
  // keyword it can be the only 404 anyone sees — without it here, entering plan
  // mode on an evicted session would hard-fail instead of recreating.
  if (reused && (isGone(results[0]) || isGone(results[1]) || isGone(results[4]) || isGone(results[5]))) {
    console.warn(`[setup] engine session ${sessionId} gone (404) — recreating and retrying setup once`);
    contentSessionMap.delete(contentId);
    sessionId = await timed(timings, 'createSession', () => writingEngine.createSession());
    rememberSession(contentId, sessionId);
    hashes = (contentSessionMap.get(contentId).pushHashes ||= {}); // persist retry's hashes on the new entry
    skipped.length = 0;
    reused = false;
    results = await runFanout();
  }

  // Preserve the old sequential fatality: document + brief failures abort
  // setup (thrown to the handler); everything else is internally non-fatal.
  // P2: + seed (results[5]) — see above.
  for (const r of [results[0], results[1], results[5]]) {
    if (r.status === 'rejected') throw r.reason;
  }
  // taskPlanMode (results[4]) is fatal only for a DELIBERATELY MARKED step —
  // today a non-chat mode that failed to reach the engine (modeTask), or a CFS
  // failure in plan mode, where every plan-building tool depends on it. Keying
  // on the marker rather than the index keeps unmarked rejections non-fatal, so
  // a crash added inside pushPlanModeContext later cannot silently become a
  // hard failure.
  if (results[4].status === 'rejected' && results[4].reason?.fatalStep) {
    throw results[4].reason;
  }

  console.log(
    `[timing] setupSession content=${content.contentNumber} reused=${reused} ` +
    `total=${Date.now() - tSetup}ms skipped=[${skipped.join(',')}] ${JSON.stringify(timings)}`
  );

  return { sessionId, markdown };
}

/**
 * Minimal session setup for the fast inline-edit path (R15 finding #2).
 *
 * The engine's InlineEdit only reads the pushed DOCUMENT to locate the selected
 * text — it never uses the brief / brand-voice / context-files / plan-mode that
 * full setupSession pushes (and ApplyInlineEdit persists to the engine's OWN
 * store, not via CFS, so no CFS push is needed either). Doing the full setup per
 * quick-action cost ~6-8 engine round-trips + 2-3 Mongo queries for nothing.
 *
 * Uses the SAME contentSessionMap as setupSession, so the session is shared with
 * chat/agent: a prior full setup's brief/brand-voice persist in the session, and
 * a fresh session simply doesn't need them for an inline edit. A later chat call
 * reuses this session and runs the full setup itself.
 */
async function setupSessionLite(content) {
  const contentId = content._id.toString();
  let sessionId;

  const existing = contentSessionMap.get(contentId);
  let reused = false;
  if (existing) {
    existing.lastUsed = Date.now();
    sessionId = existing.sessionId;
    reused = true;
  } else {
    // Signal: session creation is sub-second; without it a hung engine holds
    // the request on undici's ~300s default (first edit per content).
    sessionId = await writingEngine.createSession(AbortSignal.timeout(10000));
    rememberSession(contentId, sessionId);
  }

  // Push the current document so the engine can locate selectedText verbatim.
  // Signal: same rationale — every hop in this fast path is now bounded.
  const markdown = blocksToMarkdown(content.blocks || []);
  if (markdown) {
    try {
      await writingEngine.pushDocument(sessionId, markdown, AbortSignal.timeout(15000));
    } catch (err) {
      // 13b: mirror generate-image's stale-session recovery. A REUSED session
      // the engine no longer has (redeploy with a fresh store) 404s here;
      // without a retry the poisoned map entry is re-pinned via lastUsed and
      // every inline edit fails (falling back to chat) until reload. Drop the
      // entry, recreate, and re-push ONCE. Non-404s (and first-session
      // failures) propagate — the inline-edit handler 502s to the chat path.
      if (!reused || err.status !== 404) throw err;
      console.warn(`[inline-edit] engine session ${sessionId} gone (404) — recreating and retrying once`);
      contentSessionMap.delete(contentId);
      sessionId = await writingEngine.createSession(AbortSignal.timeout(10000));
      rememberSession(contentId, sessionId);
      await writingEngine.pushDocument(sessionId, markdown, AbortSignal.timeout(15000));
    }
  }
  return { sessionId, markdown };
}

/**
 * Image-only session setup (R2b). The engine's direct /generate-image route
 * reads ONLY the session's image style — never the document, brief, brand
 * voice, plan, or CFS config that full setupSession pushes (8+ engine
 * round-trips + several Mongo queries per generation, all wasted).
 *
 * Same contentSessionMap as setupSession/setupSessionLite, so chat and image
 * generation share one engine session. Style is always pushed (even empty)
 * for the same reason as setupSession: a reused session should be CLEARED
 * when the user removes the workspace style. Best-effort: on a transient
 * push failure the engine keeps its previously persisted style for this
 * generation (self-corrects on the next successful push).
 */
async function setupSessionImage(content) {
  const contentId = content._id.toString();
  let sessionId;

  const existing = contentSessionMap.get(contentId);
  if (existing) {
    existing.lastUsed = Date.now();
    sessionId = existing.sessionId;
  } else {
    // 11d: bound session creation (sub-second) so a hung engine can't hold the
    // image path on undici's ~300s default — same rationale as setupSessionLite.
    sessionId = await writingEngine.createSession(AbortSignal.timeout(10000));
    rememberSession(contentId, sessionId);
  }

  try {
    const workspaceId = content.workspaceId || content.workspace;
    const brandVoice = await BrandVoice.findOne({ workspace: workspaceId, active: true }).lean();
    // 11d: bound the style push too. Still best-effort (see the catch) — a
    // transient/timed-out push leaves the engine's previously persisted style.
    await writingEngine.pushImageStyle(sessionId, brandVoice?.imageStyle || '', AbortSignal.timeout(15000));
  } catch (err) {
    console.error('Image style push failed (non-fatal):', err.message);
  }

  return { sessionId };
}

/**
 * W5-b: ghost-text autocomplete session setup — the LIGHTEST of all the setup
 * variants. The engine's /complete reads NO document (only the optional
 * SEO-brief keyword already persisted in the session), so unlike
 * setupSessionLite this pushes NOTHING: it reuses the shared contentSessionMap
 * session if one exists (getting the keyword hint for free), else mints a BARE
 * session purely to satisfy the engine's requireSession gate. A later
 * chat/agent/inline-edit reuses this same session and runs the real setup — so
 * seeding a bare session here is harmless (rememberSession resets its push
 * hashes; the first real setup pushes everything).
 *
 * Returns the sessionId. Callers must handle a 404 from the engine (an evicted
 * reused session) by recreating a bare session and retrying once.
 */
async function setupSessionAutocomplete(content) {
  const contentId = content._id.toString();
  const existing = contentSessionMap.get(contentId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.sessionId;
  }
  const sessionId = await writingEngine.createSession(AbortSignal.timeout(10000));
  rememberSession(contentId, sessionId);
  return sessionId;
}

/**
 * Push mode + plan + CFS config to the Go session. M5 orchestration glue.
 *
 * Mode comes from Content.mode (persistent — Plan transition statics
 * update it via reconcile hooks). Plan comes from the proposed > draft >
 * approved fallback; null when no editable plan exists.
 *
 * The CFS push is gated on INTERNAL_API_KEY being set; without it, the
 * Go tools can't authenticate against /api/internal/cfs/* and would
 * fail mid-call. Better to fail loudly here than silently in the loop.
 */
async function pushPlanModeContext(sessionId, content, timings = {}, hashes = {}, skipped = []) {
  // Bug #H fix: aggregate failures into one structured log line at the
  // end so a misconfigured session is visible in a single grep, not
  // spread across three separate errors. Includes sessionId + content
  // identifiers so the line is correlatable in multi-tenant logs.
  const failures = [];
  // Function-scoped: the aggregate failure log at the bottom reads `mode`.
  // It used to be declared inside modeTask, so that log threw a ReferenceError
  // on every failure path instead of printing — and because setupSession
  // swallowed this function's rejection entirely, the throw was invisible too.
  // Net effect: the CFS-misconfiguration error line this code exists to emit
  // has never once been logged.
  const mode = content.mode || 'chat';

  // W2-a: the three pushes are independent engine session fields (mutex-
  // guarded per field; the run starts only after all pushes settle), so run
  // them concurrently. Each sub-task catches into failures[] as before.
  const modeTask = async () => {
    const allowed = MODE_ALLOWED_TOOLS[mode] || [];
    // W2-b: mode is engine-DB-hydrated — safe to skip when unchanged.
    const h = pushHash(JSON.stringify({ mode, allowed }));
    if (hashes.mode === h) {
      skipped.push('mode');
      return;
    }
    try {
      await timed(timings, 'pushMode', () => writingEngine.pushMode(sessionId, mode, allowed));
      hashes.mode = h;
    } catch (err) {
      // A failed mode push used to be a warning, which was harmless only while
      // the engine ignored session mode on the agent path. It does not any
      // more: RunFreeformAgent now picks its strategy FROM the mode, so a lost
      // push leaves the engine on its default (chat) while Mongo says plan or
      // execute — and the run proceeds under the WRONG contract. In plan mode
      // that means the document is writable when the user was promised it is
      // read-only, and UpdatePlan/ExitPlanMode are denied so no plan can ever
      // be produced. Silent, and indistinguishable from the feature simply not
      // working.
      //
      // Fatal only when the mode being pushed is NOT chat. The engine's own
      // default IS chat (state.NewSession), so a lost chat push leaves the
      // session in exactly the state we wanted — failing the run there would
      // block the common path for no gain.
      if (mode !== 'chat') {
        err.fatalStep = 'pushMode';
        throw err;
      }
      failures.push({ step: 'pushMode', error: err.message });
    }
  };

  const planTask = async () => {
    // Plan resolution mirrors planController.get: proposed > draft > approved.
    let plan = null;
    try {
      plan = await Plan.findProposed(content._id);
      if (!plan) plan = await Plan.findDraft(content._id);
      if (!plan && content.activePlanId) {
        plan = await Plan.findById(content.activePlanId);
      }
    } catch (err) {
      failures.push({ step: 'planLookup', error: err.message });
    }

    const goPlan = plan ? toGoPlan(plan) : null;
    // W2-b: plan is engine-DB-hydrated — safe to skip when unchanged. The
    // lookup above still runs every turn (the plan can change server-side);
    // only the engine round-trip is elided.
    const h = pushHash(JSON.stringify(goPlan));
    if (hashes.plan === h) {
      skipped.push('plan');
      return;
    }
    try {
      await timed(timings, 'pushPlan', () => writingEngine.pushPlan(sessionId, goPlan));
      hashes.plan = h;
    } catch (err) {
      failures.push({ step: 'pushPlan', error: err.message });
    }
  };

  // A CFS failure is FATAL in plan mode and only in plan mode.
  //
  // Plan mode's entire tool allowlist is CFS-dependent (registry.go modeRules):
  // ListContext/ReadContext/GrepContext are CFS by definition, and UpdatePlan,
  // AddSource and ExitPlanMode all refuse outright without a config. What is
  // left is web search and AskUserTool — nothing that can produce a plan. So a
  // plan run without CFS cannot succeed; it can only spend the user's turn
  // budget discovering that, one tool rejection at a time.
  //
  // Measured: three consecutive runs, 5-9 turns each, every turn erroring with
  // "the session has no CFS configuration", zero sections produced, and nothing
  // said to the user beyond a generic no-proposal. Failing setup costs one
  // clear error instead.
  //
  // NOT fatal for chat or execute: both keep their write/edit tools when CFS is
  // down (chat denies only the plan-edit tools, execute only the plan tools), so
  // they degrade rather than break. Failing them would take the common paths
  // down over context that merely enriches them.
  const throwIfPlanMode = (step, cause) => {
    if (mode !== 'plan') return;
    const message = cause instanceof Error ? cause.message : String(cause);
    const err = new Error(
      `Plan mode requires the context file system, and it is unavailable (${step}: ${message}). ` +
      'Every plan-building tool depends on it, so the run cannot proceed.'
    );
    err.fatalStep = step;
    // Carry the HTTP status THROUGH the wrapper. setupSession's recreate-retry
    // keys off reason.status === 404, and a fresh Error() drops it — so without
    // this, wrapping an evicted-session 404 in a friendlier message is exactly
    // what stops it being recognised as an evicted session. CFS is never
    // hash-skipped, so it 404s on every evicted reuse and is the likeliest push
    // to hit this.
    if (cause instanceof Error && cause.status) err.status = cause.status;
    throw err;
  };

  const cfsTask = async () => {
    // CFS config — required for Go's context tools. NEVER hash-skipped: the
    // engine does not rehydrate it after a restart (memory-only), so a skip
    // could silently disable the context tools for the whole run.
    const apiKey = process.env.INTERNAL_API_KEY;
    const expressBaseUrl = process.env.EXPRESS_INTERNAL_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      'http://localhost:4001';
    if (!apiKey) {
      failures.push({ step: 'cfsConfig', error: 'INTERNAL_API_KEY not set — context tools will be unavailable' });
      throwIfPlanMode('cfsConfig', 'INTERNAL_API_KEY is not set');
      return;
    }
    // Workspace number is denormalized only on Workspace, not Content —
    // do one targeted lookup to resolve it.
    let workspaceNumber = 0;
    try {
      const ws = await Workspace.findById(content.workspaceId).select('workspaceNumber');
      if (ws) workspaceNumber = ws.workspaceNumber;
    } catch (err) {
      failures.push({ step: 'workspaceLookup', error: err.message });
    }

    try {
      await timed(timings, 'pushCFSConfig', () => writingEngine.pushCFSConfig(sessionId, {
        baseUrl: expressBaseUrl,
        apiKey,
        workspaceNumber,
        contentNumber: content.contentNumber || 0,
      }));
    } catch (err) {
      failures.push({ step: 'pushCFSConfig', error: err.message });
      throwIfPlanMode('cfsConfig', err);
    }
  };

  // allSettled, not all: modeTask now THROWS for a non-chat mode, and a
  // Promise.all would short-circuit past the aggregate log below — losing the
  // plan/CFS diagnostics for exactly the run that failed hardest. Collect
  // everything, log once, then rethrow the fatal one.
  const settled = await Promise.allSettled([modeTask(), planTask(), cfsTask()]);
  const rejected = settled.filter((r) => r.status === 'rejected');
  // Prefer the MARKED error rather than the first rejection. modeTask happens
  // to be first in the array today, so `find` would pick it — but only by
  // accident of ordering. If a sibling ever rejects too (planTask's toGoPlan
  // is outside its try, for one) and the array is reordered, the unmarked
  // error would shadow the marked one, setupSession's fatalStep check would
  // not match, and a lost plan-mode push would go back to being silent — the
  // exact bug this change exists to kill.
  const fatal = rejected.find((r) => r.reason?.fatalStep) || rejected[0];

  if (failures.length > 0 || fatal) {
    // CFS/config failures silently disable the plan-mode context tools (the
    // engine's ListContext/ReadContext/etc. go unavailable), so surface those
    // at error level — a misconfigured deployment must be greppable, not
    // buried among warnings. Other push failures stay at warn.
    const hasCfsFailure = failures.some(
      (f) => f.step === 'cfsConfig' || f.step === 'pushCFSConfig',
    );
    const logFn = hasCfsFailure || fatal ? console.error : console.warn;
    logFn('[setupSession] plan-mode push had failures', {
      sessionId,
      contentId: content._id,
      contentNumber: content.contentNumber,
      mode,
      failures,
      ...(fatal && { fatal: fatal.reason?.message }),
    });
  }

  // Rethrow so the caller can see it at all. Whether it ABORTS setup is
  // setupSession's call, and it aborts only for fatalStep === 'pushMode' —
  // an unmarked rejection here (a crash in one of the siblings) surfaces as a
  // logged failure and is then swallowed, exactly as it was before.
  if (fatal) throw fatal.reason;
}

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/chat
// SSE streaming chat — streams thinking_delta, text_delta, tool events,
// and final draft/patch events so the UI can show live progress.
// ─────────────────────────────────────────────────────────────
const chat = async (req, res) => {
  let creditTxId = null;
  let threadLockKey = null; // P4: released in the finally
  const tReq = Date.now(); // W0: request-start reference for [timing] lines
  // Threads Phase 1: backend-minted run identifier (no engine runId exists) —
  // the CORRELATION id linking this run's thread appends (user + assistant +
  // side-channels). Not a dedup key: each append site fires at most once per
  // request, and a browser retry is genuinely a new run (it re-charges).
  const runId = crypto.randomUUID();
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { prompt, avatarId, displayLabel } = req.body;
    // trim(): a whitespace-only prompt would persist a blank thread row that
    // 400s every future compact AND seed (P3 lifecycle review BUG-2).
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // Set up Writing Engine session. Threads P2: chat is STATELESS — a fresh
    // one-shot session per turn (never collides with a detached agent run's
    // single-flight lock), seeded from the durable thread by the setup fan-out
    // so it still has full conversation memory. `secondary` keeps it out of
    // the primary slot (pre-fix, every chat turn truncated agent memory).
    const { sessionId } = await setupSession(content, { avatarId, secondary: true });
    // W2-b: poison the doc-write marker until this run completes cleanly — a
    // crashed run must not leave a stale 0 that would let the next setup skip
    // the document push while the engine's copy is ahead of the FE's.
    recordRunDocWrites(content._id.toString(), sessionId, -1);

    // Pre-deduct credits before starting the stream
    if (req.creditContext?.deductionEnabled) {
      try {
        const result = await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId,
          req.creditContext.estimatedCredits,
          req.creditContext.featureKey,
          { contentId: content._id.toString(), feature: 'aiChat', workspaceId: req.creditContext.workspaceId }
        );
        creditTxId = result.transactionId;
      } catch (creditErr) {
        return res.status(402).json({
          error: creditErr.message,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    // Threads Phase 1: record the user turn POST-GATE (a 402/400-bounced
    // request must not write a phantom prompt) and pre-run (a mid-run crash
    // must not lose it). Best-effort — appendMessage never throws.
    // P4: hold the thread-write lock across the whole user→assistant span so
    // an archive/activate can't split the pair across threads.
    threadLockKey = content._id.toString();
    lockThreadWrites(threadLockKey);
    const thread = await threadService.getOrCreateActiveThread(content, req.user?.userId);
    await threadService.appendMessage(thread, {
      kind: 'user',
      text: prompt,
      displayText: typeof displayLabel === 'string' ? displayLabel : '',
      meta: { runId, sessionId, userId: req.user?.userId || null, channel: 'chat' },
    });

    // AbortController tied to the client request so that if the browser
    // disconnects (user pressed Stop / Esc), we abort the fetch to the Go
    // engine — which in turn cancels the handler's r.Context(), stopping
    // the query loop mid-turn.
    const abortCtrl = new AbortController();
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
      abortCtrl.abort();
    });

    // Start streaming request to the engine (Phase 4: tier preset → model set)
    const preset = await resolvePreset(req);
    const tConnect = Date.now();
    const chatRes = await writingEngine.sendChatMessageStream(sessionId, prompt, abortCtrl.signal, preset);
    console.log(`[timing] ai.chat engine-connect=${Date.now() - tConnect}ms (request+${Date.now() - tReq}ms)`);

    // Set up SSE headers for the client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Raw byte pipe — forward Go engine SSE stream directly to the client.
    // All event transformation (document_diff → patch/draft) is now handled
    // client-side in EditorChatBar.tsx.
    const reader = chatRes.body.getReader();
    const usageTap = makeUsageTap();

    let firstByteAt = 0; // W0: time-to-first-engine-byte
    const processEvents = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstByteAt) {
          firstByteAt = Date.now();
          console.log(`[timing] ai.chat first-engine-byte=+${firstByteAt - tReq}ms (from request start)`);
        }
        const buf = Buffer.from(value);
        usageTap.addChunk(buf);
        res.write(buf);
      }
    };

    // Cancel reader on abort (belt-and-braces — the fetch signal already
    // aborts the upstream, but cancel() releases the reader lock cleanly).
    abortCtrl.signal.addEventListener('abort', () => {
      reader.cancel().catch(() => {});
    });

    try {
      await processEvents();
    } catch (streamErr) {
      if (clientDisconnected || abortCtrl.signal.aborted) {
        console.log('[chat-sse] stream aborted by client disconnect');
        // Refund credits on client abort
        if (creditTxId) {
          creditService.refund(creditTxId).catch((e) =>
            console.error('[credit] chat abort refund failed:', e.message)
          );
          creditTxId = null;
        }
      } else {
        throw streamErr;
      }
    }

    // Stream completed — settle to the ACTUAL chat cost. Table 2: ≤8K tokens = 1,
    // above = 2. The gate reserved 2 (the max), so settle refunds 1 back on a
    // small message; a large one settles at the full reserved 2.
    if (creditTxId) {
      const { inputTokens, outputTokens } = usageTap.snapshot();
      const actual = resolveCredits('aiChatMessage', {
        tier: req.creditContext?.tier,
        tokens: (inputTokens || 0) + (outputTokens || 0),
      });
      creditService.settle(creditTxId, actual).catch((e) =>
        console.error('[credit] chat settle failed:', e.message)
      );
    }

    console.log(`[timing] ai.chat stream-total=${Date.now() - tReq}ms`);
    // W2-b: gate the next setup's document-push skip on whether THIS run
    // wrote to the engine-side document.
    recordRunDocWrites(content._id.toString(), sessionId, usageTap.snapshot().docWrites);
    persistUsage(req, content, usageTap, 'chat', { sessionId, runId, aborted: clientDisconnected });
    // Threads Phase 1: record the assistant turn at the single convergence
    // point (success AND client-abort funnel here; hard errors go to the
    // outer catch and deliberately append nothing — D6, the replay shaper
    // seals a dangling user message).
    {
      const t = usageTap.snapshot();
      let finalText = usageTap.finalAssistantText();
      // Review BUG-2 (chat variant): a tool-only chat reply that edited the
      // doc but narrated nothing still gets an honest assistant row.
      if (!finalText && !clientDisconnected && t.docWrites > 0) {
        // Parenthetical reported speech — see the agent convergence note.
        finalText = `(run summary: ${t.docWrites} document edit${t.docWrites === 1 ? '' : 's'} were applied)`;
      }
      // Review CAVEAT-5: a client-aborted chat reply is partial — mark it.
      if (finalText && clientDisconnected) {
        finalText += '\n\n(response interrupted before completion)';
      }
      if (finalText) {
        await threadService.appendMessage(thread, {
          kind: 'assistant',
          text: finalText,
          meta: {
            runId, sessionId, channel: 'chat',
            model: t.model, tokensIn: t.inputTokens, tokensOut: t.outputTokens,
            docWrites: t.docWrites, stopReason: t.stopReason, turns: usageTap.turnCount(),
          },
        }, content); // re-resolve target if the thread was archived mid-run
      } else {
        // Phase 7: same gap as the agent convergence — a chat turn that spent
        // turns but persisted no reply (client aborted before any text, and no
        // document writes to trigger the run-summary fallback) would otherwise
        // cost nothing against the conversation's budget.
        await threadService.recordTurns(thread, usageTap.turnCount());
      }
      if (usageTap.steeringWasApplied() && thread) {
        threadService.markSteersApplied(thread._id, tReq);
      }
      // P3: compaction trigger — detached (never delays the response, never
      // throws; failures retry after a later run).
      void threadService.maybeCompactThread(content);
    }
    if (!clientDisconnected) res.end();
  } catch (err) {
    // Refund credits on error
    if (creditTxId) {
      creditService.refund(creditTxId).catch((e) =>
        console.error('[credit] chat error refund failed:', e.message)
      );
    }

    // AbortError from fetch when client disconnected — silent.
    if (err.name === 'AbortError') {
      console.log('[chat-sse] upstream fetch aborted');
      return;
    }
    console.error('AI chat error:', err);
    if (!res.headersSent) {
      // P2 (review CAVEAT-1): a seed-409 (busy warm session) surfaces as the
      // SAME SSE busy event the engine's own single-flight bounce produces —
      // the FE already renders that as its neutral busy chip. An HTTP 409
      // would hit the generic !res.ok throw → red error bubble.
      if (err.status === 409) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'error', code: 'busy', error: err.message })}\n\n`);
        return res.end();
      }
      return res.status(500).json({ error: err.message || 'AI chat failed' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  } finally {
    if (threadLockKey) unlockThreadWrites(threadLockKey); // P4
  }
};

// R9: clamp client-supplied agent budgets. The engine derives its turn budget
// from maxIterations (MaxTurns = maxIter*3+10 freeform, maxIter+10 sequential),
// so an uncapped value lets a single flat-priced (10-credit) request buy an
// enormous turn budget. The 16 ceiling matches the highest value any real
// slash command sends (/research, /facts), so legitimate commands are
// unaffected; only abusive values are clamped. targetScore is bounded to a
// sane band (the only value commands send is 80; default is 75).
const AGENT_MAX_ITERATIONS = 16;
const AGENT_TARGET_SCORE_MIN = 50;
const AGENT_TARGET_SCORE_MAX = 90;
function clampAgentBudget(maxIterations, targetScore) {
  const iter = parseInt(maxIterations, 10) || 5;
  const score = parseInt(targetScore, 10) || 75;
  return {
    safeIterations: Math.min(Math.max(iter, 1), AGENT_MAX_ITERATIONS),
    safeTargetScore: Math.min(Math.max(score, AGENT_TARGET_SCORE_MIN), AGENT_TARGET_SCORE_MAX),
  };
}

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/agent
// SSE streaming — agent writes/edits, streams progress
// ─────────────────────────────────────────────────────────────
const agent = async (req, res) => {
  let creditTxId = null;
  // W4-b/c: hoisted so the catch can clean the in-flight registry (content
  // itself is block-scoped to the try). myRunEntry is hoisted too so the catch
  // can identity-check before deleting (a shadowing same-content run must stay).
  let runRegistryKey = null;
  let myRunEntry = null;
  // Phase 3: hoisted for the same reason — the catch settles an image run to
  // the images it already bought instead of refunding them, and needs both the
  // billing class and the stream's observed image count to do it.
  let billingAction = null;
  let usageTap = null;
  let threadLockKey = null; // P4: released in the finally
  const tReq = Date.now(); // W0: request-start reference for [timing] lines
  // Threads Phase 1: backend-minted run identifier (see chat).
  const runId = crypto.randomUUID();
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    // allowedTools is deliberately NOT destructured: the body's tool list is
    // never read. resolveAgentRun below is the only source of a whitelist.
    // `mode` is deliberately absent too: every read below uses runGate.mode,
    // the canonicalized value, so no code path can re-derive a different
    // answer from the raw field.
    const { goal, targetScore, maxIterations, avatarId, displayLabel, commandName } = req.body;
    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ error: 'goal is required' });
    }

    // Phase 2 enforcement: the server, not the browser, decides what a run may
    // do. Sequential runs need a known, non-disabled commandName (whitelist
    // comes from the server registry, verbatim); the no-command case is legal
    // only for the plan-approve article write, verified from server-side
    // content state; freeform forwards no tools at all. Checked before the
    // shadow guard, credit hold and thread append — a refused run costs
    // nothing and leaves no trace.
    const runGate = resolveAgentRun(req.body, content, systemSettings.getSettings().disabledAgentCommands);
    if (!runGate.ok) {
      // Log it: with no admin UI for the disabled list and a frontend whose
      // own gate is a build-time literal, this line is the only way an
      // operator sees enforcement firing or spots a drifted deploy.
      // COMMAND_MISCONFIGURED in particular is a pure config bug.
      console.warn(`[agent] refusing run content=${content.contentNumber} `
        + `code=${runGate.code} command=${JSON.stringify(req.body?.commandName ?? null)} `
        + `mode=${JSON.stringify(req.body?.mode ?? null)}`);
      return res.status(runGate.status).json({ error: runGate.error, code: runGate.code });
    }
    const enforcedTools = runGate.allowedTools;

    // Durable-storage pre-flight for image-capable runs.
    //
    // REACHABILITY, so nobody mistakes this for the durability guarantee: on a
    // default config NOTHING reaches it. /image is the only command whose
    // whitelist carries an image tool, it ships disabled and is 403'd above,
    // COMMAND_IMAGE_PASS is empty, and freeform/plan-write forward no tools at
    // all. Those other paths — freeform (the editor's Auto-write), chat,
    // skills, actions, the parallel runner — no longer mint images either:
    // they are granted an image budget of zero, so the engine hides the image
    // tools from them entirely. The engine's REQUIRE_DURABLE_IMAGES, which removes the image
    // tools from the registry at startup, is the control that covers all six
    // TOOL paths — not POST /ai/generate-image, which mints an image directly
    // and is deliberately left ungated as a per-image-billed user action;
    // this block is the nicer error for the day /image is enabled, and it
    // deliberately ALLOWS engine-memory + backend-B2, which the engine-side
    // switch refuses.
    //
    // Without B2 the engine stores generated images in memory: they are served
    // from the engine's own host and expire within the hour. THIS tier is the
    // one that can judge it, because it also knows whether the rescue exists —
    // contentController re-hosts /api/images/ links to the backend's bucket
    // when a document is saved. So: refuse only when NEITHER side is durable,
    // which is the configuration where every generated image is guaranteed to
    // break. An unknown engine answer (health blip) is never treated as
    // "not durable" — that would refuse legitimate work over a timeout.
    if (IMAGE_TOOLS.some((t) => enforcedTools?.includes(t)) || runGate.imagePass) {
      const caps = await writingEngine.getEngineCapabilities();
      if (caps.imageStorage === 'memory' && !imageStorage.isEnabled()) {
        console.warn(`[agent] refusing image-capable run content=${content.contentNumber}: `
          + 'engine image storage is ephemeral and the backend has no B2 fallback');
        return res.status(503).json({
          error: 'Image generation is unavailable right now — this server has nowhere durable to store images, so they would stop loading within the hour. Your document is unchanged.',
          code: 'IMAGE_STORAGE_UNAVAILABLE',
        });
      }
    }
    // Forward the CANONICAL mode, never req.body.mode: the engine dispatches
    // on an exact `mode == "sequential"` comparison, so a raw "SEQUENTIAL"
    // would route to the freeform agent while this tier treated it as a
    // slash command.
    const safeMode = runGate.mode;

    // Article count-gate (Phase 6): runs classified as articleGenerate consume
    // the article allowance on RE-generation. Classification is content-aware:
    // plan-execute runs under a not-yet-generated approved plan are the plan's
    // article write (SERVER-side state — unspoofable), alongside the client-
    // declared auto-write intent and unknown sequential commands. Check BEFORE
    // any session/credit work so a blocked run does nothing. AT-1: the honest
    // write path hard-blocks past the allowance regardless of credit balance;
    // the finite-pool pricing is only the spoof backstop (AT-2). The slot is
    // consumed at COMPLETION and only if the run actually wrote the document.
    billingAction = classifyAgentRun(req.body, content);
    // SLOT enforcement is decoupled from the client-declared billing class
    // (review BLOCKER-1): a spoofed mode/commandName can lower the PRICE — an
    // accepted, pool-bounded floor — but must NEVER bypass the article
    // allowance or the plan's one-generation stamp. isPlanArticleWrite reads
    // only server-side content state, so any run under an unwritten approved
    // plan is slot-gated no matter what the body claims.
    // Known accepted limits: (a) the allowance check→increment is TOCTOU like
    // the platform-wide requireQuota pattern — two concurrent re-gens can land
    // used=limit+1 once, then block; (b) typed freeform rewrites on NON-plan
    // docs bill inlineAction with no slot (intent is client-declared there) —
    // bounded by the finite pools.
    const slotGated = billingAction === 'articleGenerate' || isPlanArticleWrite(content);
    let articleGate = null;

    // Conversations Phase 8: refuse rather than SHADOW a live run.
    //
    // activeAgentRuns.set() on an occupied key silently orphans whatever was
    // there. The victim is usually a DETACHED run still draining server-side:
    // once its entry is replaced it becomes unreachable — /ai/run-status reports
    // nothing active, /ai/stop 409s because the sessionId no longer matches, and
    // the 30-minute TTL sweep can never abort it. It keeps writing the document
    // with no way to see or stop it.
    //
    // Continue is clicked at exactly the moment such a twin may still be
    // draining, which turns a rare race into a routine one. The frontend guards
    // too, but per-tab only — a second tab, or a detached run from a closed one,
    // reaches here regardless.
    //
    // Checked HERE, before setupSession, the credit hold and the user-row
    // append: a refused run must cost nothing and leave no trace. Guarding after
    // those (as the first cut did) still burned a session setup and left a
    // dangling user message that the replay shaper later seals as an
    // "interrupted" turn the user never actually made.
    //
    // The AbortController is created here, above the reservation, because the
    // registry entry carries abort() and that entry now goes in BEFORE
    // setupSession. The close handler that drives `detached` is still installed
    // further down, once the state it writes to exists.
    const abortCtrl = new AbortController();
    runRegistryKey = content._id.toString();
    {
      const live = activeAgentRuns.get(runRegistryKey);
      if (live) {
        console.warn(`[agent] refusing to shadow a live run content=${content.contentNumber} `
          + `existing=${live.runId} incoming=${runId}`);
        runRegistryKey = null; // that entry is not ours — the finally must not free it
        return res.status(409).json({
          error: 'Another AI run is still working on this document — wait for it to finish (or stop it), then try again.',
          code: 'busy',
        });
      }

      // Per-USER in-flight cap. The guard above is per DOCUMENT, so one user
      // could hold N simultaneous runs across N documents — N engine sessions,
      // N image budgets, N credit holds — and the only other limiter is a
      // per-IP request-rate limit, which counts starts rather than in-flight
      // work and is shared by everyone behind a NAT.
      //
      // Counted from the same map, in the same synchronous step as the check
      // and reserve below: an await here would reopen exactly the
      // check-then-act window the comment underneath warns about.
      const uid = req.user?.userId ? String(req.user.userId) : null;
      if (uid) {
        let mine = 0;
        for (const entry of activeAgentRuns.values()) {
          if (entry.userId === uid) mine++;
        }
        if (mine >= MAX_RUNS_PER_USER) {
          console.warn(`[agent] refusing run content=${content.contentNumber} user=${uid}: `
            + `${mine} runs already in flight (cap ${MAX_RUNS_PER_USER})`);
          runRegistryKey = null; // nothing reserved — the finally must not free it
          return res.status(429).json({
            error: `You already have ${mine} AI runs going. Wait for one to finish, then try again.`,
            code: 'TOO_MANY_RUNS',
          });
        }
      }
    }
    // RESERVE the slot in the same synchronous step as the check above.
    //
    // The check alone was not a guard, it was check-then-act: it read the map
    // here and registered ~100 lines and FIVE awaits later — setupSession's 6-8
    // engine round trips, the credit pre-deduct, the thread read, the user-row
    // append. Two requests arriving inside that multi-second window both saw an
    // empty map, both passed, and the second orphaned the first — exactly the
    // failure this block exists to prevent, and Continue makes it routine by
    // being clicked while a twin may still be draining. Node runs a handler to
    // its first await without interleaving, so has()+set() with no await between
    // them is atomic and the window closes.
    //
    // sessionId and markdownBefore are filled in below, once setupSession
    // returns. Readers are unaffected: /ai/stop and /ai/stop-revert already
    // reject any entry whose sessionId does not match the caller's, which is how
    // they behaved during this window when there was no entry at all.
    myRunEntry = {
      sessionId: null,
      markdownBefore: '',
      startedAt: Date.now(),
      revertIntent: false,
      abort: () => abortCtrl.abort(),
      // Threads P1 review (CAVEAT-8): lets side-channel appends (steer/
      // clarify/plan-confirm) correlate their rows to the run they landed in
      // — sessionId alone is ambiguous (freeform reuses sessions across runs).
      runId,
      // Owner, for the per-user in-flight cap above. Entries are removed on
      // completion and swept after AGENT_RUN_TTL_MS, so the count self-heals
      // even if a run dies without cleaning up.
      userId: req.user?.userId ? String(req.user.userId) : null,
    };
    activeAgentRuns.set(runRegistryKey, myRunEntry);

    // The article allowance is checked AFTER the shadow guard, not before.
    // Ordered the other way, a free-tier document at its article limit with a
    // run already in flight answered the second request with "You've used all 3
    // articles included in the free plan" — reporting a permanent, plan-level
    // condition for what is actually a transient one that clears the moment the
    // running job finishes. Still before any session, credit or thread work, so
    // a blocked run does nothing; checkArticleAllowance is read-only (the
    // increment lives in commitArticleGeneration), and the finally frees the
    // slot this reserved.
    if (slotGated) {
      articleGate = await checkArticleAllowance(req, content);
      if (articleGate.blocked) {
        return res.status(429).json(articleGate.payload);
      }
    }

    // Set up Writing Engine session (reuse for conversation memory in freeform
    // mode). P2: memoryRun mirrors isFreeform — sequential runs are outside
    // the memory contract (D5): no seed (the engine wipes it), no marker.
    const isFreeform = safeMode === 'freeform';
    const { sessionId, markdown: markdownBefore } = await setupSession(content, { avatarId, reuseSession: isFreeform, memoryRun: isFreeform });
    // Complete the reservation placed above. Until this line the entry holds the
    // slot but matches no sessionId, so stop/stop-revert correctly report "no
    // matching run in flight" rather than acting on a run that has not started.
    myRunEntry.sessionId = sessionId;
    myRunEntry.markdownBefore = markdownBefore || '';
    // W2-b: poison the doc-write marker until this run completes cleanly (see chat).
    recordRunDocWrites(content._id.toString(), sessionId, -1);

    // Pre-deduct credits before starting the stream
    if (req.creditContext?.deductionEnabled) {
      try {
        const result = await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId,
          req.creditContext.estimatedCredits,
          req.creditContext.featureKey,
          { contentId: content._id.toString(), feature: 'aiAgent', workspaceId: req.creditContext.workspaceId }
        );
        creditTxId = result.transactionId;
      } catch (creditErr) {
        return res.status(402).json({
          error: creditErr.message,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    // Threads Phase 1: record the user turn POST-GATE (article-gate 429 and
    // credit 402 bounces above must not write phantom prompts), pre-run.
    // `text` = the full engineered goal (the replay source); `displayLabel` =
    // what the FE bubble showed ('/auto-optimize'). Best-effort, never throws.
    // P4: thread-write lock across user→assistant appends (covers the
    // pre-registration window AND the post-registry-delete tail — the
    // registry is removed at the W4-b V3 point ~100 lines before the append).
    threadLockKey = content._id.toString();
    lockThreadWrites(threadLockKey);
    const thread = await threadService.getOrCreateActiveThread(content, req.user?.userId);
    // userAppended feeds the convergence bump's CONTIGUITY check (P2 review
    // BUG-2) — the marker may only advance across rows this run itself wrote.
    const userAppended = await threadService.appendMessage(thread, {
      kind: 'user',
      text: goal,
      displayText: typeof displayLabel === 'string' ? displayLabel : '',
      meta: {
        runId, sessionId, userId: req.user?.userId || null, channel: 'agent',
        commandName: typeof commandName === 'string' ? commandName.slice(0, 64) : '',
      },
    });

    // W4-c-2 DETACHED RUNS: a passive client disconnect (tab close / navigate
    // away) no longer aborts the engine — the run keeps going server-side and
    // the user catches up on reopen (run-status → engine-content reconcile).
    // An EXPLICIT Stop / Stop&Revert instead reaches the server out-of-band
    // (POST /ai/stop[-revert]) and calls the registry's abort() BEFORE the
    // socket closes, so by the time req.on('close') fires the controller is
    // already aborted and this is a stop, not a detach.
    let clientDisconnected = false;
    let detached = false;
    req.on('close', () => {
      clientDisconnected = true;
      // Already aborted ⇒ an explicit stop drove this close; leave detached
      // false so the catch/settle path treats it as a stop. Otherwise the
      // client simply vanished — detach and let the run finish.
      if (!abortCtrl.signal.aborted) detached = true;
    });

    // W4-b/c: the in-flight run is already registered — the reservation above
    // IS the registration, completed with its sessionId once setupSession
    // returned. Every read and delete below is identity-checked against
    // myRunEntry rather than trusting whatever currently occupies the key
    // (mirrors the W2 session guard), so a finishing run can never delete or
    // read a different run's entry. The finally releases the slot on any early
    // return (a 402 credit bounce) that exits before the normal delete.

    // Start agent — returns a raw SSE response from the Writing Engine
    // mode: "freeform" (default, Claude Code-style) or "sequential" (legacy phases)
    const agentPreset = await resolvePreset(req);
    const { safeIterations, safeTargetScore } = clampAgentBudget(maxIterations, targetScore);
    const tConnect = Date.now();
    const agentRes = await writingEngine.startAgent(
      sessionId, goal, safeTargetScore, safeIterations, abortCtrl.signal, enforcedTools, safeMode, agentPreset, runGate.imagePass, runGate.imageBudget
    );
    console.log(`[timing] ai.agent engine-connect=${Date.now() - tConnect}ms (request+${Date.now() - tReq}ms)`);

    // If the client already detached during the engine-connect await, the socket
    // is dead — skip the header + session_init writes (they'd hit a closed
    // response) but let the run continue detached below.
    if (!detached && !res.writableEnded) {
      // Set up SSE headers for the client
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Emit session_init event so frontend knows the sessionId for mid-run actions
      res.write(`data: ${JSON.stringify({ type: 'session_init', sessionId })}\n\n`);
    }

    // Raw byte pipe — forward Go engine SSE stream directly to the client.
    // All event transformation (document_diff → patch/draft) is now handled
    // client-side in EditorChatBar.tsx. This eliminates per-event JSON
    // parse/serialize overhead for text_delta and thinking_delta events.
    const reader = agentRes.body.getReader();
    usageTap = makeUsageTap();

    let firstByteAt = 0; // W0: time-to-first-engine-byte
    const processEvents = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstByteAt) {
          firstByteAt = Date.now();
          console.log(`[timing] ai.agent first-engine-byte=+${firstByteAt - tReq}ms (from request start)`);
        }
        const buf = Buffer.from(value);
        usageTap.addChunk(buf);
        // W4-c-2: once the client has detached, its socket is dead — keep
        // DRAINING the engine stream (so the run finishes and usage is tallied)
        // but stop forwarding to the closed response (a write would throw
        // EPIPE / ERR_STREAM_WRITE_AFTER_END).
        if (!detached && !res.writableEnded) {
          try {
            res.write(buf);
          } catch (writeErr) {
            // Client vanished between the close event and this write — treat
            // the rest of the run as detached and keep draining the engine.
            detached = true;
          }
        }
      }
    };

    // Cancel reader on abort (explicit Stop / Stop&Revert only — a passive
    // detach never aborts, so the reader keeps draining to completion).
    abortCtrl.signal.addEventListener('abort', () => {
      reader.cancel().catch(() => {});
    });

    // W4-b: the stop-revert endpoint sets revertIntent on THIS entry (identity
    // via sessionId match) while the stream is live. Read it off myRunEntry —
    // the object stop-revert mutated — not a re-get, so a concurrent same-content
    // run that shadowed the key can't feed us its markdownBefore/revertIntent.
    const runEntry = myRunEntry;

    // W4-c-2: distinguishes a run that ran to completion (detached or attached)
    // from one cut short by an explicit Stop — drives the run record's `aborted`
    // flag that the catch-up UI reads to decide "finished" vs "was stopped".
    let streamCompleted = false;
    try {
      await processEvents();
      streamCompleted = true;
    } catch (streamErr) {
      if (clientDisconnected || abortCtrl.signal.aborted) {
        console.log('[agent-sse] stream aborted by explicit stop');
        // Refund when nothing was written (review BLOCKER-2) OR when the user
        // EXPLICITLY stopped-and-reverted (W4-b): the doc edits stream to the
        // client BEFORE completion, so a silent "read until the final
        // document_diff, then drop the connection" must never refund — but a
        // declared revert also restores the ENGINE document below.
        const revertNow = !!myRunEntry.revertIntent;
        const abortTotals = usageTap.snapshot();
        const wroteBeforeAbort = abortTotals.docWrites > 0;
        // Images already generated are spend we cannot take back, and they
        // are billed PER IMAGE by the provider. A slash command generates
        // every image BEFORE it embeds any, so "no document write yet" was
        // true for a run that had already bought eight images — stopping
        // there refunded the credits in full. A revert restores the document;
        // it cannot un-buy an image, so it does not excuse this either.
        const spentImages = (abortTotals.images || 0) > 0;
        if (creditTxId && (!wroteBeforeAbort || revertNow) && !spentImages) {
          creditService.refund(creditTxId).catch((e) =>
            console.error('[credit] agent abort refund failed:', e.message)
          );
          creditTxId = null;
        }
      } else {
        throw streamErr;
      }
    }

    // Re-read after the stream ended — the flag is now authoritative.
    const revertFinal = !!myRunEntry.revertIntent;
    // W4-b (review V3): delete the entry HERE, before the awaited settle/
    // commit below. A concurrent stop-revert POST landing during that await
    // then deterministically 409s (no matching in-flight run) instead of
    // setting an intent this handler has already read past. W4-c-2 review:
    // identity-guarded — only clear the key if it's still OURS, so a
    // same-content run that shadowed it (and is still live) is left intact.
    if (activeAgentRuns.get(runRegistryKey) === myRunEntry) activeAgentRuns.delete(runRegistryKey);

    // Stream completed — settle the deduction. Most agent runs cost a fixed
    // amount per mode (== the reserved estimate), so settle() refunds 0; an
    // /image run is the exception and settles DOWN to the images it produced
    // (Phase 3). Either way it must be settle(),
    // NOT a direct findByIdAndUpdate on the primary tx: a multi-pool deduction
    // (e.g. 100 credits spanning subscription+general) creates sibling pending
    // txs sharing a groupId; marking only the primary leaves the siblings
    // 'pending' for the orphan-sweep to later REFUND — silently under-charging.
    // settle() claims the whole group and fires the low-balance check.
    // Did this run actually write the document? Server-observed from the SSE
    // stream — document_diff ONLY, never document_update or draft, which mean
    // the mutating tool ran and changed nothing (see makeUsageTap) — an articleGenerate
    // run that only talked (e.g. a question asked in execute mode before "write
    // it") settles down to inlineAction cost and never consumes a slot.
    const wroteDocument = usageTap.snapshot().docWrites > 0;

    if (creditTxId) {
      const reserved = req.creditContext?.estimatedCredits ?? 0;
      // W4-b (review V1, user-chosen policy): a reverted run that WROTE settles
      // to the small inlineAction price rather than a full refund. Full refund
      // was a money leak — a hostile client could keep the streamed article in
      // Mongo (which the FE owns via autosave) while paying nothing, unbounded.
      // Charging inlineAction removes the "free" incentive (bounded by the
      // credit pool) while keeping the honest revert cheap. A reverted run that
      // never wrote is a plain stop → also inlineAction (matches the no-write
      // articleGenerate branch). No article slot is consumed either way.
      // Phase 3 exempts image runs: see the branch below.
      let actual;
      if (billingAction === 'imageGenerate') {
        // Phase 3: priced on the images the engine actually produced, which is
        // the ONLY branch that can settle an image run — it must come before
        // the revert and no-write branches, not after.
        //
        // The reservation is the worst case (run base + the full allowance),
        // so charging `reserved` would bill four images to a run that made
        // one. Equally, a stop or a revert cannot fall through to the flat
        // inlineAction price: reverting restores the document but cannot
        // un-buy an image the provider already charged us for. Pricing off the
        // count settles both — it floors at the run base when no image was
        // made and rises only with real spend.
        const imagesMade = usageTap.snapshot().images || 0;
        actual = agentRunCredits('imageGenerate', {
          tier: req.creditContext?.tier, images: imagesMade,
        });
      } else if (revertFinal) {
        actual = resolveCredits('inlineAction', { tier: req.creditContext?.tier });
      } else {
        actual = (billingAction === 'articleGenerate' && !wroteDocument)
          ? resolveCredits('inlineAction', { tier: req.creditContext?.tier })
          : reserved;
      }
      creditService.settle(creditTxId, Math.min(actual, reserved)).catch((e) =>
        console.error('[credit] agent settle failed:', e.message)
      );
      creditTxId = null;
    }

    // Article count-gate: commit whenever the run ACTUALLY WROTE — including
    // abort-after-write (the article was delivered; see BLOCKER-2 above) —
    // EXCEPT an explicit stop-&-revert (W4-b): the run is billed as an
    // inlineAction, not an article delivery, so no slot is consumed.
    if (articleGate && wroteDocument && !revertFinal) {
      await commitArticleGeneration(content, articleGate);
    }
    if (revertFinal && wroteDocument) {
      // Names the class rather than asserting inlineAction: an /image revert is
      // billed base + images (Phase 3), so the old wording told operators a
      // price that was no longer charged.
      console.log(`[audit] stop-revert content=${content.contentNumber} session=${sessionId} billed=${billingAction}`);
    }
    // Conversations Phase 7 (decision §4 #6): MEASURE the post-stamp path, do
    // not reprice it.
    //
    // A plan-execute run that wrote anything stamps articleGeneratedPlanId and
    // burns that plan's single paid generation. Every run afterwards on the same
    // plan bills inlineAction (2) with no article slot — so a full rewrite costs
    // 2 credits, repeatably, for as long as the plan stands. That may be
    // intended generosity or a leak; nobody can tell today because it is
    // invisible. This line makes it greppable so the question can be answered
    // with data instead of argued from the billing code.
    //
    // Deliberately NOT a new branch in classifyAgentRun: that function is the
    // subtlest code in the billing path, and adding a rule before the behaviour
    // is measured is how a pricing bug gets shipped.
    if (billingAction === 'inlineAction' && content.mode === 'execute'
        && content.activePlanId && String(content.activePlanId) === String(content.articleGeneratedPlanId || '')) {
      console.log(`[audit] post-stamp cheap run content=${content.contentNumber} plan=${content.activePlanId} `
        + `wrote=${wroteDocument} turns=${usageTap.turnCount()} action=inlineAction`);
    }

    // W4-b: make the revert REAL server-side — restore the engine session's
    // pre-run document so engine + FE (snapshot restore) + Mongo (reconcile
    // save of the reverted blocks) all converge on the pre-run state. Best
    // effort: on failure the poison marker below still forces a re-push of
    // the FE's (reverted) content on the next run.
    if (revertFinal && wroteDocument && runEntry?.markdownBefore) {
      // Review V2: AWAIT the restore before recording the doc-write marker so
      // the ordering is deterministic — a late fire-and-forget push could
      // otherwise interleave with the next run's setup.
      try {
        await writingEngine.pushDocument(sessionId, runEntry.markdownBefore);
      } catch (e) {
        console.warn('[agent] revert doc restore failed (next setup re-pushes):', e.message);
      }
    }

    console.log(`[timing] ai.agent stream-total=${Date.now() - tReq}ms${revertFinal ? ' (stop-revert)' : ''}`);
    // W2-b: gate the next setup's document-push skip on whether THIS run
    // wrote to the engine-side document. A reverted run poisons the marker
    // so the next setup re-pushes regardless of the restore's hash.
    recordRunDocWrites(content._id.toString(), sessionId, revertFinal ? -1 : usageTap.snapshot().docWrites);
    // aborted reflects whether the RUN finished, not whether the CLIENT stayed:
    // a detached run that completed server-side is NOT aborted (the catch-up UI
    // reads this to show "finished while you were away" vs "was stopped").
    persistUsage(req, content, usageTap, 'agent', { sessionId, runId, aborted: !streamCompleted });
    // Threads Phase 1: record the assistant turn at the convergence point —
    // success, passive detach (drained server-side, so the tap has the full
    // text), explicit stop, stop-revert, and the TTL abort ALL pass through
    // here exactly once. Hard errors hit the outer catch → no append (D6).
    {
      const t = usageTap.snapshot();
      let finalText = usageTap.finalAssistantText();
      // Review BUG-2: a SUCCESSFUL run whose model narrated nothing (tools
      // only — sequential's normal shape) must still record an assistant row,
      // else the thread ends in a dangling user message and the Phase-2
      // replay shaper brands a successful run "interrupted".
      if (!finalText && streamCompleted && (t.docWrites > 0 || t.stopReason)) {
        // Fidelity review CAVEAT-1: reported-speech parentheticals, NOT
        // bracketed assistant-voice — seeded exemplars written as "[Run
        // completed…]" invite register imitation from exemplar-biased models.
        finalText = t.docWrites > 0
          ? `(run summary: ${t.docWrites} document edit${t.docWrites === 1 ? '' : 's'} were applied)`
          : '(run summary: the run completed with no document changes)';
      }
      // Review CAVEAT-5: partial text from a stopped/TTL-aborted/errored
      // stream must not read as a complete reply (revert has its own marker).
      if (finalText && !streamCompleted && !revertFinal) {
        finalText += '\n\n(response interrupted before completion)';
      }
      if (finalText) {
        const appended = await threadService.appendMessage(thread, {
          kind: 'assistant',
          text: revertFinal ? `${finalText}\n\n(this run was stopped and its changes were reverted)` : finalText,
          meta: {
            runId, sessionId, channel: 'agent',
            model: t.model, tokensIn: t.inputTokens, tokensOut: t.outputTokens,
            docWrites: revertFinal ? 0 : t.docWrites, stopReason: t.stopReason,
            turns: usageTap.turnCount(),
          },
        }, content); // re-resolve target if the thread was archived mid-run
        // Threads P2: this run's rows already live in the warm session's
        // NATIVE engine history — advance the seeded marker past them so the
        // next run doesn't re-seed over richer in-session context. The helper
        // enforces session + thread identity AND contiguity (review BUG-2):
        // any interleaved foreign row leaves the marker stale → re-seed.
        maybeBumpSeededMarker(content._id.toString(), sessionId, userAppended, appended);
      } else {
        // Phase 7: the run spent turns but persisted no reply (nothing narrated,
        // or a truncated run whose mid-work narration is suppressed, with the
        // run-summary fallback skipped because the stream was stopped rather
        // than completed). appendMessage charges the budget as a side effect of
        // writing the row, so without this those turns are free — and
        // run-then-stop-then-repeat is the loop the ceiling exists to bound.
        await threadService.recordTurns(thread, usageTap.turnCount());
      }
      if (usageTap.steeringWasApplied() && thread) {
        threadService.markSteersApplied(thread._id, tReq);
      }
      // P3: compaction trigger — detached (see the chat convergence note).
      void threadService.maybeCompactThread(content);
    }
    if (!clientDisconnected) res.end();
  } catch (err) {
    // W4-b/c: never leave a stale in-flight entry behind a thrown stream.
    if (runRegistryKey && activeAgentRuns.get(runRegistryKey) === myRunEntry) activeAgentRuns.delete(runRegistryKey);
    // Refund credits on error — EXCEPT what the run already spent on images.
    // A thrown stream is usually our fault and the user should not pay for it,
    // but images are bought from the provider per image and are not returned
    // when the run that ordered them dies. Refunding those in full made a
    // failing run cheaper than a working one; settling to the images made
    // charges for the spend and forgives the rest. Mirrors the abort path.
    if (creditTxId) {
      // usageTap is null when the throw beat the stream (bad content, engine
      // unreachable) — nothing was generated, so the full refund is right.
      const imagesMade = usageTap ? (usageTap.snapshot().images || 0) : 0;
      if (billingAction === 'imageGenerate' && imagesMade > 0) {
        const reserved = req.creditContext?.estimatedCredits ?? 0;
        const actual = agentRunCredits('imageGenerate', {
          tier: req.creditContext?.tier, images: imagesMade,
        });
        creditService.settle(creditTxId, Math.min(actual, reserved)).catch((e) =>
          console.error('[credit] agent error settle failed:', e.message)
        );
      } else {
        creditService.refund(creditTxId).catch((e) =>
          console.error('[credit] agent error refund failed:', e.message)
        );
      }
    }

    // AbortError from fetch when client disconnected — silent.
    if (err.name === 'AbortError') {
      console.log('[agent-sse] upstream fetch aborted');
      return;
    }
    console.error('AI agent error:', err);
    if (!res.headersSent) {
      // P2 (review CAVEAT-1): seed-409 → the engine-shaped SSE busy event the
      // FE already understands (see the chat handler note).
      if (err.status === 409) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'error', code: 'busy', error: err.message })}\n\n`);
        return res.end();
      }
      return res.status(500).json({ error: err.message || 'AI agent failed' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  } finally {
    if (threadLockKey) unlockThreadWrites(threadLockKey); // P4
    // Release the slot reserved before setupSession if this request exited
    // without ever reaching the normal delete — the credit 402 returns from
    // inside the try, which runs this finally but NOT the catch. Identity-checked
    // so a request that was refused (and nulled its key), or one whose entry has
    // already been superseded, can never free somebody else's run. On every
    // normal path the entry is gone by now and this is a no-op. Without it a
    // failed setup would pin the document for a full sweep interval — far worse
    // than the shadowing the reservation prevents.
    if (runRegistryKey && activeAgentRuns.get(runRegistryKey) === myRunEntry) {
      activeAgentRuns.delete(runRegistryKey);
    }
  }
};

/**
 * Extract edit pairs from two markdown versions by diffing lines.
 * Returns an array of { old_string, new_string } suitable for mapEditsToPatches.
 *
 * Simple line-level diff: finds changed lines between old and new markdown.
 */
function extractEditsFromMarkdownDiff(oldMd, newMd) {
  const oldLines = oldMd.split('\n');
  const newLines = newMd.split('\n');
  const edits = [];

  // Simple approach: find contiguous groups of changed lines
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference — collect the changed region
    const oldStart = i;
    const newStart = j;

    // Advance until we find a matching line again
    let found = false;
    for (let lookAhead = 1; lookAhead < 20; lookAhead++) {
      // Check if old[i+lookAhead] matches new[j] or new[j+lookAhead] matches old[i]
      if (i + lookAhead < oldLines.length && oldLines[i + lookAhead] === newLines[j]) {
        // Old had extra lines (deleted)
        const oldText = oldLines.slice(oldStart, i + lookAhead).join('\n').trim();
        if (oldText) {
          edits.push({ old_string: oldText, new_string: '' });
        }
        i = i + lookAhead;
        found = true;
        break;
      }
      if (j + lookAhead < newLines.length && newLines[j + lookAhead] === oldLines[i]) {
        // New has extra lines (inserted)
        const newText = newLines.slice(newStart, j + lookAhead).join('\n').trim();
        if (newText) {
          edits.push({ old_string: '', new_string: newText });
        }
        j = j + lookAhead;
        found = true;
        break;
      }
      if (i + lookAhead < oldLines.length && j + lookAhead < newLines.length &&
          oldLines[i + lookAhead] === newLines[j + lookAhead]) {
        // Both changed — replacement
        const oldText = oldLines.slice(oldStart, i + lookAhead).join('\n').trim();
        const newText = newLines.slice(newStart, j + lookAhead).join('\n').trim();
        if (oldText && newText && oldText !== newText) {
          edits.push({ old_string: oldText, new_string: newText });
        }
        i = i + lookAhead;
        j = j + lookAhead;
        found = true;
        break;
      }
    }

    if (!found) {
      // Single line replacement
      const oldText = (oldLines[i] || '').trim();
      const newText = (newLines[j] || '').trim();
      if (oldText && newText && oldText !== newText) {
        edits.push({ old_string: oldText, new_string: newText });
      }
      i++;
      j++;
    }
  }

  // Handle remaining old lines (deleted content at end)
  if (i < oldLines.length) {
    const remaining = oldLines.slice(i).join('\n').trim();
    if (remaining) {
      edits.push({ old_string: remaining, new_string: '' });
    }
  }

  // Handle remaining new lines (appended content at end)
  if (j < newLines.length) {
    const remaining = newLines.slice(j).join('\n').trim();
    if (remaining) {
      // Find the last non-empty line in old as an anchor
      let anchor = '';
      for (let k = oldLines.length - 1; k >= 0; k--) {
        if (oldLines[k].trim()) { anchor = oldLines[k].trim(); break; }
      }
      if (anchor) {
        // Append after the anchor line
        edits.push({ old_string: anchor, new_string: anchor + '\n\n' + remaining });
      } else {
        edits.push({ old_string: '', new_string: remaining });
      }
    }
  }

  return edits.filter((e) => e.old_string || e.new_string);
}

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/generate-image
// Direct image generation (SVG or PNG) — no chat loop
// ─────────────────────────────────────────────────────────────
const generateImage = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { description, format, style } = req.body;
    if (!description || typeof description !== 'string' || description.length < 5) {
      return res.status(400).json({ error: 'description is required (min 5 chars)' });
    }
    // 11b: cap the description (byte length, matching the engine's Go len())
    // before the engine round-trip. The engine now rejects >4096 bytes too;
    // reject here so an oversized prompt never reaches the LLM.
    if (Buffer.byteLength(description, 'utf8') > 4096) {
      return res.status(400).json({ error: 'description too long (max 4096 bytes)' });
    }
    // Cap style too (byte-parity with the engine). The SVG path feeds it into
    // the LLM prompt, so leaving it uncapped would be a bypass of the
    // description cap. May be undefined/non-string — guard before measuring.
    if (typeof style === 'string' && Buffer.byteLength(style, 'utf8') > 4096) {
      return res.status(400).json({ error: 'style too long (max 4096 bytes)' });
    }

    // R2b: image-only setup — the engine's /generate-image reads nothing from
    // the session except the image style, so the full 8-push setupSession was
    // pure overhead here.
    const { sessionId } = await setupSessionImage(content);

    const imageParams = {
      description,
      format: format || 'svg',
      // R2b: no 'flat' default — empty lets the engine resolve the workspace
      // image style for PNG (session > IMAGE_STYLE_PROMPT env); the engine
      // still defaults SVG to "flat" (SVG never uses the workspace style,
      // matching the chat-loop tool).
      style: style || '',
    };

    let result;
    try {
      result = await writingEngine.generateImage(sessionId, imageParams);
    } catch (err) {
      // Stale mapping: the engine was redeployed with a fresh DB while our
      // contentSessionMap still holds the old sessionId (its style push above
      // failed silently too). Drop the entry and retry ONCE with a fresh
      // session — without this, every retry re-pins the poisoned entry via
      // lastUsed and image generation 404s forever.
      if (err.status !== 404) throw err;
      console.warn(`[generate-image] engine session ${sessionId} gone (404) — recreating and retrying once`);
      contentSessionMap.delete(content._id.toString());
      const retry = await setupSessionImage(content);
      result = await writingEngine.generateImage(retry.sessionId, imageParams);
    }

    // Upload generated image to B2 if available
    if (imageStorage.isEnabled()) {
      const wsId = content.workspaceId.toString();
      const cn = content.contentNumber;
      try {
        if (result.dataUri && result.dataUri.startsWith('data:image/')) {
          result.dataUri = await imageStorage.uploadFromDataUri(result.dataUri, wsId, cn);
        } else if (imageStorage.looksLikeEngineImageUrl(result.dataUri)) {
          // Origin-checked like the save path. This URL comes from the engine's
          // own response rather than a request body, so it is a weaker position
          // to attack from — but the pre-filter should agree with the guard
          // that uploadFromUrl now enforces, or the only signal of a refused
          // origin is a generic upload failure.
          result.dataUri = await imageStorage.uploadFromUrl(result.dataUri, wsId, cn);
        }
        if (result.svg) {
          const svgDataUri = `data:image/svg+xml;base64,${Buffer.from(result.svg).toString('base64')}`;
          result.svgUrl = await imageStorage.uploadFromDataUri(svgDataUri, wsId, cn);
        }
      } catch (uploadErr) {
        console.error('B2 upload failed (non-fatal):', uploadErr.message);
      }
    }

    // AI cost ledger (Phase 1). PNG is billed flat per image. The engine now
    // reports the resolved image model (models.json role), so we price from that
    // instead of a hardcoded id that drifts when the model is reconfigured; the
    // literal stays as a fallback for older engine builds. SVG is an LLM text
    // call — the engine returns its usage + serving model in the response body,
    // so we record real tokens. Detached so it never delays the JSON response.
    void (async () => {
      try {
        const fmt = result.format || format || 'svg';
        const isPng = fmt === 'png';
        const orgId = req.creditContext?.orgId || null;
        let tier = '';
        if (orgId) tier = (await tierService.getOrgTierConfig(orgId))?.tier || '';
        costLedger.record({
          action: 'image',
          model: isPng
            ? (result.model || 'google/gemini-2.5-flash-image')
            : (result.model || 'google/gemini-2.5-flash'),
          images: isPng ? 1 : undefined,
          tokensIn: isPng ? 0 : (result.usage?.input_tokens || 0),
          tokensOut: isPng ? 0 : (result.usage?.output_tokens || 0),
          organizationId: orgId,
          workspaceId: content.workspaceId,
          userId: req.user?.userId || null,
          tier,
          metadata: { contentId: content._id?.toString(), format: fmt },
        });
      } catch (e) {
        console.warn('[costLedger] image skipped:', e.message);
      }
    })();

    // Phase 6: finalize the image charge (Free draws from the 200 sample pool).
    // preDeduct+settle so the orphan-sweep can't refund it. Best-effort — the
    // image already generated and is being returned. Stock-image search is a
    // separate zero-credit path; this endpoint is always the AI generator.
    //
    // Phase 3: imageGenerate became a PER-IMAGE price. This endpoint makes
    // exactly one image per call and passes no count, so the resolver's default
    // of one unit keeps it at the same flat charge it has always had — the run
    // base belongs to agent runs, which take turns and write the document.
    await creditService.deductForRequest(req, { metadata: { contentId: content._id?.toString() } });

    return res.json(result);
  } catch (err) {
    console.error('Image generation error:', err);
    // N2: consistent with clarifyAnswer/planConfirm — a hung engine (the 11d
    // createSession/pushImageStyle AbortSignals, or generateImage's own
    // timeout, fired) is a 504, not a 500.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Engine timed out generating the image' });
    }
    return res.status(500).json({ error: err.message || 'Image generation failed' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/inline-edit
// R15: fast Cmd+K-style edit for the editor's quick actions (Rewrite / Expand /
// Make Shorter / Improve Readability). ONE validation-model call — no agent
// loop, no ~8K-token chat overhead. On ANY engine failure this returns non-200
// so the client transparently falls back to the chat path. Feature/permission/
// credit gates match chat (rc('aiChat', …)); the charge is settled to the SAME
// aiChatMessage cost, so users pay the same as the prior chat-based path.
// ─────────────────────────────────────────────────────────────
const inlineEdit = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { selectedText, instruction, preview } = req.body || {};
    if (!selectedText || typeof selectedText !== 'string' || !selectedText.trim()) {
      return res.status(400).json({ error: 'selectedText is required' });
    }
    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: 'instruction is required' });
    }
    // R3: input caps. The engine's inline path has a 2000-token output budget;
    // a selection beyond ~6000 BYTES will truncate mid-sentence. Non-200 here
    // makes the editor fall back to the chat path, which has no such budget —
    // same UX, correct result. Byte length (not .length UTF-16 units) so this
    // cap matches the engine's Go len() exactly — CJK text would otherwise
    // pass here and waste the round-trip before the engine rejects it.
    if (Buffer.byteLength(selectedText, 'utf8') > 6000) {
      return res.status(422).json({ error: 'selection too large for inline edit' });
    }
    if (instruction.length > 2000) {
      return res.status(400).json({ error: 'instruction too long' });
    }

    // Lean setup: reuse the shared session (1h contentSessionMap) and push ONLY
    // the current document — the engine's InlineEdit needs nothing else (finding
    // #2). Repeat quick-actions reuse the session; the doc re-push keeps the
    // engine in sync so selectedText resolves verbatim.
    const { sessionId } = await setupSessionLite(content);

    let result;
    try {
      // W5-a: preview mode computes the replacement + diff without mutating the
      // engine document — the editor applies on accept.
      result = await writingEngine.inlineEdit(sessionId, { selectedText, instruction, preview: !!preview });
    } catch (err) {
      // Engine unreachable / timeout / 5xx → 502 so the client falls back to chat.
      console.error('[inline-edit] engine call failed:', err.message);
      return res.status(502).json({ error: 'inline edit failed' });
    }

    // Engine ran but produced no usable edit — e.g. selectedText not found in the
    // document (unsaved editor edits), or the model returned the text unchanged.
    // 422 → the client falls back to the chat path.
    // AI cost ledger (Phase 1) — real tokens from the engine's FastUsage.
    // Detached so it never delays the response; only recorded when the engine
    // reported a serving model (else the registry would price it at 0).
    const recordInlineEditCogs = (failed) => {
      if (!result.usage?.model) return;
      void (async () => {
        try {
          const orgId = req.creditContext?.orgId || null;
          let tier = '';
          if (orgId) tier = (await tierService.getOrgTierConfig(orgId))?.tier || '';
          costLedger.record({
            action: 'inlineEdit',
            model: result.usage.model,
            tokensIn: result.usage.input_tokens || 0,
            tokensOut: result.usage.output_tokens || 0,
            organizationId: orgId,
            workspaceId: content.workspaceId,
            userId: req.user?.userId || null,
            tier,
            metadata: { contentId: content._id?.toString(), ...(failed ? { failed: true } : {}) },
          });
        } catch (e) {
          console.warn('[costLedger] inline-edit skipped:', e.message);
        }
      })();
    };

    if (result.error || !result.editedText) {
      // R3: a failed call (truncation, sanitizer rejection) still burned real
      // tokens — record the COGS so the ledger isn't blind to this routine
      // path. The USER is not charged (charge-only-on-success unchanged).
      recordInlineEditCogs(true);
      return res.status(422).json({ error: result.error || 'no edit produced' });
    }

    // W2-b: the engine applied this edit to ITS document copy. If the editor
    // discards its local apply (stale-range guard), the FE markdown hash won't
    // change — poison the marker so the next setup re-pushes rather than
    // skipping while the engine copy is ahead. W5-a: in PREVIEW mode the engine
    // did NOT apply (doc unchanged), so no poison — an accepted edit changes the
    // FE hash and re-pushes naturally; a rejected one leaves nothing to sync.
    if (!preview) {
      recordRunDocWrites(content._id.toString(), sessionId, -1);
    }

    // Charge ONLY on success. preDeduct + settle run as ONE cycle here so no
    // pending tx is left for the orphan-sweep to later refund (which would
    // silently undercharge). Settled to the SAME aiChatMessage cost the prior
    // chat-based quick action paid: ≤8K tokens = 1, above = 2 (reserved 2, so a
    // small edit refunds 1) — users pay exactly what they did before R15.
    if (req.creditContext?.deductionEnabled) {
      try {
        const { transactionId } = await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId,
          req.creditContext.estimatedCredits,
          req.creditContext.featureKey,
          { contentId: content._id.toString(), feature: 'aiInlineEdit', workspaceId: req.creditContext.workspaceId },
        );
        const reserved = req.creditContext.estimatedCredits ?? 0;
        const tokens = (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
        const actual = resolveCredits('aiChatMessage', { tier: req.creditContext.tier, tokens });
        creditService.settle(transactionId, Math.min(actual, reserved)).catch((e) =>
          console.error('[credit] inline-edit settle failed:', e.message));
      } catch (creditErr) {
        // Balance vanished between the gate and the charge (rare). The edit
        // already ran engine-side; surface 402 so the client can react.
        return res.status(402).json({ error: creditErr.message, code: 'INSUFFICIENT_CREDITS' });
      }
    }

    recordInlineEditCogs(false);

    // W5-a: return originalText + diff so the editor can render the accept/reject
    // preview. Included only when the engine provides them — the real engine
    // populates both on the apply path too (so that response is {editedText,
    // originalText, diff}); a bare-editedText engine reply stays { editedText }.
    // Additive keys; no inline-edit consumer reads result.applied.
    const payload = { editedText: result.editedText };
    if (result.originalText != null) payload.originalText = result.originalText;
    if (result.diff != null) payload.diff = result.diff;
    return res.json(payload);
  } catch (err) {
    console.error('[inline-edit] handler error:', err);
    return res.status(500).json({ error: 'inline edit failed' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/autocomplete
// W5-b: ghost-text (Cursor-style Tab completion). The FLYWEIGHT AI endpoint —
// registered with the lightest auth chain (rwr only, NO feature/permission/
// credit gates), excluded from the global per-IP limiter, and metered by its
// OWN per-user bucket (see workspaceRoutes). It is FREE: no credit charge, only
// a fire-and-forget COGS ledger row for margin tracking. Every soft failure
// (engine down, timeout, refusal, empty) returns 200 {completion:''} so the
// editor simply shows no ghost text — autocomplete must NEVER surface an error.
// ─────────────────────────────────────────────────────────────
const AUTOCOMPLETE_TIMEOUT_MS = 5000;

const autocomplete = async (req, res) => {
  // resolveContent runs its OWN indexed Mongo read; on a transient DB error (or
  // a CastError) it REJECTS. This is the highest-QPS AI handler, so an unguarded
  // reject here would both violate the soft-fail contract AND (Express 4 doesn't
  // await handlers) surface as an unhandledRejection. Isolate it so any throw
  // degrades to "no suggestion".
  let content;
  try {
    content = await resolveContent(req, res);
  } catch (err) {
    console.warn('[autocomplete] content lookup failed:', err.message);
    if (res.headersSent) return;
    return res.json({ completion: '' });
  }
  if (!content) return; // 404 (not found) / 403 (locked) already sent

  const { textBefore, textAfter, maxTokens } = req.body || {};
  if (typeof textBefore !== 'string' || textBefore.trim() === '') {
    return res.status(400).json({ error: 'textBefore is required' });
  }
  // Bound the payload defensively (the engine trims to ~200 words anyway).
  const tb = textBefore.slice(-4000);
  const ta = typeof textAfter === 'string' && textAfter ? textAfter.slice(0, 2000) : undefined;
  let mt = Number(maxTokens);
  if (!Number.isFinite(mt) || mt <= 0) mt = 0; // 0 → engine default (100)
  else if (mt > 200) mt = 200;                 // ghost text is 1-2 sentences

  // Cancel the engine call if the client navigates away (stale keystroke) or we
  // exceed the latency budget — a ghost suggestion that arrives late is useless
  // and we shouldn't keep paying the model for it.
  const ac = new AbortController();
  let clientGone = false;
  const onClose = () => { clientGone = true; ac.abort(); };
  req.on('close', onClose);
  const timer = setTimeout(() => ac.abort(), AUTOCOMPLETE_TIMEOUT_MS);

  try {
    let sessionId = await setupSessionAutocomplete(content);
    let result;
    try {
      result = await writingEngine.complete(sessionId, { textBefore: tb, textAfter: ta, maxTokens: mt }, ac.signal);
    } catch (err) {
      // A reused session the engine no longer has (redeploy / eviction) 404s —
      // mirror setupSessionLite: drop the poisoned entry, mint a bare session,
      // retry ONCE. Any other error falls through to the soft-fail below.
      if (err.status === 404) {
        contentSessionMap.delete(content._id.toString());
        sessionId = await writingEngine.createSession(AbortSignal.timeout(10000));
        rememberSession(content._id.toString(), sessionId);
        result = await writingEngine.complete(sessionId, { textBefore: tb, textAfter: ta, maxTokens: mt }, ac.signal);
      } else {
        throw err;
      }
    }

    // FREE feature — no credit charge. Record COGS only (fire-and-forget) so the
    // margin dashboard sees autocomplete volume/cost. Mirrors inlineEdit's tap.
    if (result?.usage?.model) {
      costLedger.recordForWorkspace({
        action: 'autocomplete',
        model: result.usage.model,
        tokensIn: result.usage.input_tokens || 0,
        tokensOut: result.usage.output_tokens || 0,
        workspaceId: content.workspaceId,
        userId: req.user?.userId || null,
        metadata: { contentId: content._id?.toString() },
      });
    }

    // Soft-fail on any engine-reported error (refusal / empty) — no ghost text.
    return res.json({ completion: (result && !result.error && result.completion) || '' });
  } catch (err) {
    if (clientGone) return; // socket already gone — nothing to write
    // Timeout or engine failure: never error the editor, just suppress the ghost.
    if (!ac.signal.aborted) console.warn('[autocomplete] failed:', err.message);
    if (res.headersSent) return;
    return res.json({ completion: '' });
  } finally {
    clearTimeout(timer);
    req.off('close', onClose);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/rehost-image
// R18: rehost a user-picked image-search result onto our own B2/CDN instead of
// hotlinking the third-party server (matches the agent path). SSRF-hardened —
// the URL is hostile input. When B2 is off (dev) we return the original URL
// unchanged (rehosted:false) so behavior is identical to today. No credit gate
// (no LLM cost). On any failure the client keeps the original URL.
// ─────────────────────────────────────────────────────────────
const rehostImage = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    // B2 off (dev) — no server-side fetch happens, so no SSRF surface; hand the
    // original URL back unchanged (current hotlink behavior).
    if (!imageStorage.isEnabled()) {
      return res.json({ url, rehosted: false });
    }

    let rehostedUrl;
    try {
      rehostedUrl = await imageStorage.uploadFromExternalUrl(
        url, content.workspaceId.toString(), content.contentNumber,
      );
    } catch (err) {
      if (err instanceof imageStorage.UrlValidationError) {
        return res.status(400).json({ error: err.message, code: 'INVALID_IMAGE_URL' });
      }
      console.error('[rehost-image] fetch/upload failed:', err.message);
      return res.status(502).json({ error: 'rehost failed' });
    }

    return res.json({ url: rehostedUrl, rehosted: true });
  } catch (err) {
    console.error('[rehost-image] handler error:', err);
    return res.status(500).json({ error: 'rehost failed' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/upload-image
// Upload a base64 image to Backblaze B2
// ─────────────────────────────────────────────────────────────
const uploadImage = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { dataUri } = req.body;
    if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) {
      return res.status(400).json({ error: 'dataUri is required (must be a data:image/* URI)' });
    }

    if (!imageStorage.isEnabled()) {
      // B2 not configured — return the data URI as-is
      return res.json({ url: dataUri });
    }

    const url = await imageStorage.uploadFromDataUri(
      dataUri,
      content.workspaceId.toString(),
      content.contentNumber,
    );
    return res.json({ url });
  } catch (err) {
    console.error('Image upload error:', err);
    return res.status(500).json({ error: err.message || 'Image upload failed' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/clarify-answer
// Proxies the user's answer to the Writing Engine's clarify-answer endpoint.
// ─────────────────────────────────────────────────────────────
const clarifyAnswer = async (req, res) => {
  try {
    const { sessionId, answer } = req.body;
    if (!sessionId || !answer) {
      return res.status(400).json({ error: 'sessionId and answer are required' });
    }
    // Tenancy: the sessionId must be the one bound to THIS content's active
    // session (contentSessionMap), resolved from the authenticated URL — a
    // caller can't drive another content's resume loop with an arbitrary
    // sessionId. Fail-closed: a server restart clears the map and orphans the
    // in-memory engine session anyway, so 409 correctly tells the client to
    // restart the chat.
    const content = await resolveContent(req, res);
    if (!content) return;
    if (!sessionBoundToContent(content._id.toString(), sessionId)) {
      return res.status(409).json({ error: 'Session does not match this content (it may have expired — restart the chat)' });
    }
    // W2-b (review Gap A, defensive): answering resumes the paused agent loop.
    // Its writes stream back on the ORIGINAL run's SSE (whose completion
    // records the real docWrites), but poison here anyway so a contract drift
    // (or a resume whose stream dies unobserved) can never leave a stale 0.
    recordRunDocWrites(content._id.toString(), sessionId, -1);
    const result = await writingEngine.submitClarifyAnswer(sessionId, answer);
    // Threads Phase 1: the user's answer to the AI's question is conversation
    // content (engine-side it lands as a tool_result, which D3 never persists
    // — this append is the only durable record). After-success only.
    {
      const runId = activeAgentRuns.get(content._id.toString())?.runId || '';
      const thread = await threadService.getOrCreateActiveThread(content, req.user?.userId);
      await threadService.appendMessage(thread, {
        kind: 'user',
        text: String(answer),
        meta: { runId, sessionId, userId: req.user?.userId || null, channel: 'clarify' },
      });
    }
    return res.json(result);
  } catch (err) {
    console.error('Clarify answer error:', err);
    // Same infrastructure/bug split as scoreTerms: a stuck engine (the 30s
    // AbortSignal in submitClarifyAnswer fired) is a 504, not a 500.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Engine timed out submitting the answer' });
    }
    // Pass the engine's HTTP status through (e.g. 404 session gone, 409 wrong
    // state) instead of flattening to 500; non-HTTP failures (engine
    // unreachable) have no status and stay 500.
    return res.status(err.status || 500).json({ error: err.message || 'Failed to submit answer' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/steer
// W4-a: queue a mid-run steering message for the in-flight run.
// Side-channel — no credit gate (the tokens it adds are billed
// through the run's own usage tap). 409 when no run is active.
// ─────────────────────────────────────────────────────────────
const steer = async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }
    if (message.length > 4096) {
      return res.status(400).json({ error: 'steering message too long (max 4096 chars)' });
    }
    const content = await resolveContent(req, res);
    if (!content) return;
    // Tenancy: same rule as clarifyAnswer — the sessionId must be bound to
    // THIS content, so a caller can't steer another content's run.
    if (!sessionBoundToContent(content._id.toString(), sessionId)) {
      return res.status(409).json({ error: 'Session does not match this content (it may have expired — restart the chat)' });
    }
    const result = await writingEngine.steer(sessionId, message.trim());
    // Threads Phase 1: steers are user input — without this they vanish from
    // history and a replayed conversation shows the assistant reacting to
    // instructions that aren't there. Recorded only AFTER the engine accepted
    // the queue (a 409/429 bounce never reached the run). applied:false until
    // the run's tap sees steering_applied — an honest "queued but the run
    // ended first" stays false.
    {
      const runId = activeAgentRuns.get(content._id.toString())?.runId || '';
      const thread = await threadService.getOrCreateActiveThread(content, req.user?.userId);
      await threadService.appendMessage(thread, {
        kind: 'user',
        text: message.trim(),
        meta: { runId, sessionId, userId: req.user?.userId || null, channel: 'steer', applied: false },
      });
    }
    return res.json(result);
  } catch (err) {
    console.error('Steer error:', err);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Engine timed out queuing the message' });
    }
    // Pass engine statuses through: 409 = no active run (client should send
    // it as a normal message), 429 = queue full.
    return res.status(err.status || 500).json({ error: err.message || 'Failed to queue steering message' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/stop-revert
// W4-b: declare stop-&-revert intent for the in-flight agent run.
// The FE awaits this BEFORE aborting the stream; the agent handler
// then refunds, skips the article slot, and restores the engine's
// pre-run document. 409 when no matching run is in flight.
// ─────────────────────────────────────────────────────────────
const stopRevert = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const content = await resolveContent(req, res);
    if (!content) return;
    if (!sessionBoundToContent(content._id.toString(), sessionId)) {
      return res.status(409).json({ error: 'Session does not match this content' });
    }
    const entry = activeAgentRuns.get(content._id.toString());
    if (!entry || entry.sessionId !== sessionId) {
      return res.status(409).json({ error: 'No matching agent run is in flight — the run may have already finished. Use "Revert this run" instead.' });
    }
    entry.revertIntent = true;
    // W4-c-2: a socket close no longer aborts the engine (detached runs keep
    // going), so the stop MUST be driven here — halt the run out-of-band. The
    // handler then reads revertIntent, refunds/settles, and restores the doc.
    if (typeof entry.abort === 'function') entry.abort();
    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('Stop-revert error:', err);
    return res.status(500).json({ error: err.message || 'Failed to record revert intent' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/stop
// W4-c-2: explicit "Stop" (keep partial work). Halts the in-flight
// run out-of-band — a socket close alone now DETACHES rather than
// aborting, so an intentional stop must reach the server here. No
// revert, no refund beyond the existing docWrites anti-abuse guard
// (nothing written ⇒ refunded in the handler's abort branch).
// 409 when no matching run is in flight.
// ─────────────────────────────────────────────────────────────
const stopRun = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const content = await resolveContent(req, res);
    if (!content) return;
    if (!sessionBoundToContent(content._id.toString(), sessionId)) {
      return res.status(409).json({ error: 'Session does not match this content' });
    }
    const entry = activeAgentRuns.get(content._id.toString());
    if (!entry || entry.sessionId !== sessionId) {
      return res.status(409).json({ error: 'No matching agent run is in flight — the run may have already finished.' });
    }
    if (typeof entry.abort === 'function') entry.abort();
    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('Stop-run error:', err);
    return res.status(500).json({ error: err.message || 'Failed to stop the run' });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /:workspaceNumber/content/:contentNumber/ai/engine-content?sessionId=
// W4-c-2: read the engine session's current document markdown for the
// detached-run catch-up reconcile. Tenancy: the sessionId must be the
// one bound to THIS content. The FE re-applies the returned markdown
// through its normal apply path (never verbatim) so structured blocks
// survive the round-trip.
// ─────────────────────────────────────────────────────────────
const engineContent = async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    // P2 review (CAVEAT-5): extended-qs can deliver an OBJECT here
    // (?sessionId[$ne]=x) which would flow into the durable-tenancy Mongo
    // query as an operator. Not exploitable end-to-end, but fail it early.
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const content = await resolveContent(req, res);
    if (!content) return;
    // Threads P2 (review GAP-6): the in-memory binding dies with the process,
    // but engine sessions are now recoverable — a post-restart catch-up read
    // used to 409 here even though the session lives on in engine SQLite.
    // Fall back to the DURABLE record: accept a session the thread has seen
    // serve THIS content within 24h. Mid-run side-channels (steer/stop/…)
    // deliberately keep the map-only check — they're instance-affine anyway.
    if (!sessionBoundToContent(content._id.toString(), sessionId)
      && !(await threadService.sessionSeenForContent(content._id, sessionId))) {
      return res.status(409).json({ error: 'Session does not match this content' });
    }
    const doc = await writingEngine.getContent(sessionId);
    return res.json({ title: doc.title || '', content: doc.content || '', wordCount: doc.wordCount || 0 });
  } catch (err) {
    // 404 = the engine evicted the session (TTL) — the catch-up can't reconcile
    // from the engine; the FE falls back to its autosaved mirror. Pass it through.
    if (err.status) {
      return res.status(err.status).json({ error: err.message || 'Failed to read engine content' });
    }
    console.error('Engine-content error:', err);
    return res.status(500).json({ error: err.message || 'Failed to read engine content' });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /:workspaceNumber/content/:contentNumber/ai/run-status
// W4-c prerequisite: is a run in flight, and how did the last one
// end? Read by the future detached-run catch-up UI.
// ─────────────────────────────────────────────────────────────
const runStatus = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    const entry = activeAgentRuns.get(content._id.toString());
    const last = await AgentUsageLog.findOne({ contentId: content._id })
      .sort({ createdAt: -1 })
      .select('source sessionId runId stopReason docWrites images aborted completedAt createdAt')
      .lean();
    return res.json({
      // `entry.sessionId` is null between the slot reservation and setupSession
      // returning. Report that as "not active", exactly as this did when no
      // entry existed at all during that window — the catch-up UI keys off the
      // sessionId to reconcile engine content, and a null would send it looking
      // for a session that does not exist yet.
      active: entry && entry.sessionId ? { sessionId: entry.sessionId, startedAt: entry.startedAt } : null,
      last: last || null,
    });
  } catch (err) {
    console.error('Run-status error:', err);
    return res.status(500).json({ error: err.message || 'Failed to read run status' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/plan-confirm
// Proxies the user's plan confirmation to the Writing Engine.
// ─────────────────────────────────────────────────────────────
const planConfirm = async (req, res) => {
  try {
    const { sessionId, action, selectedSteps } = req.body;
    if (!sessionId || !action) {
      return res.status(400).json({ error: 'sessionId and action are required' });
    }
    // Tenancy: bind the sessionId to THIS content's active session (see
    // clarifyAnswer). Especially important here — plan-confirm resumes the
    // agent loop and spends credits.
    const content = await resolveContent(req, res);
    if (!content) return;
    if (!sessionBoundToContent(content._id.toString(), sessionId)) {
      return res.status(409).json({ error: 'Session does not match this content (it may have expired — restart the chat)' });
    }
    // W2-b (review Gap A, defensive): see clarifyAnswer — the resumed run's
    // writes are recorded by its own stream completion; the poison guards
    // against any unobserved-resume edge.
    recordRunDocWrites(content._id.toString(), sessionId, -1);
    const result = await writingEngine.submitPlanConfirm(sessionId, {
      action,
      selectedSteps: selectedSteps || [],
    });
    // Threads Phase 1: the plan decision is user input (engine-side it's an
    // injected pseudo-message that D3's capture never sees). After-success.
    {
      const steps = Array.isArray(selectedSteps) && selectedSteps.length
        ? ` — steps: ${selectedSteps.slice(0, 20).join(', ')}`
        : '';
      const runId = activeAgentRuns.get(content._id.toString())?.runId || '';
      const thread = await threadService.getOrCreateActiveThread(content, req.user?.userId);
      await threadService.appendMessage(thread, {
        kind: 'user',
        text: `[Plan decision] ${action}${steps}`,
        meta: { runId, sessionId, userId: req.user?.userId || null, channel: 'plan-confirm' },
      });
    }
    return res.json(result);
  } catch (err) {
    console.error('Plan confirm error:', err);
    // 12b: symmetric with clarifyAnswer — a stuck engine (the 30s AbortSignal
    // in submitPlanConfirm fired) is a 504, not a 500.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Engine timed out submitting the plan confirmation' });
    }
    // Pass the engine's HTTP status through instead of flattening to 500.
    return res.status(err.status || 500).json({ error: err.message || 'Failed to submit plan confirm' });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /:workspaceNumber/content/:contentNumber/ai/thread
// Threads Phase 1: the active thread's history for the chat bar's
// reload-survival view. Paginated newest-first (?page=0 is the most
// recent page), each page returned ascending ready to render.
// ─────────────────────────────────────────────────────────────
const getThread = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const history = await threadService.getThreadHistory(content._id, { page });
    return res.json(history);
  } catch (err) {
    console.error('[threads] getThread error:', err);
    return res.status(500).json({ error: 'Failed to load conversation history' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/threads
// Threads Phase 1 (pulled forward from Phase 4's UX wave): archive the
// active thread and start a fresh one. This makes the chat bar's existing
// "New chat" button REAL — pre-threads it only cleared component state, so
// the "cleared" conversation would resurrect from history on reload.
// (Until Phase 2 ships seeding, the warm ENGINE session may still remember
// the old conversation — pre-existing behavior, unchanged by this route.)
// ─────────────────────────────────────────────────────────────
const newThread = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    // Review BUG-2 (primary guard): archiving mid-run would file the in-flight
    // run's reply on the archived thread (its handler captured the thread doc
    // pre-run). The FE disables the button per-tab only — a second tab /
    // another user / a detached run still reaches here. Same 409 shape as
    // stop-revert. P4: ALSO consult threadWriteLocks — chat runs never
    // register in activeAgentRuns, and agent runs leave it before their
    // convergence append.
    if (activeAgentRuns.has(content._id.toString()) || threadWriteLocks.has(content._id.toString())) {
      return res.status(409).json({ error: 'An AI run is in progress on this document — stop it (or let it finish) before starting a new conversation.' });
    }
    const thread = await threadService.startNewThread(content, req.user?.userId);
    if (thread && thread.disabled) {
      // Flag off — report cleanly; the FE treats this as "local clear only",
      // which is exactly the pre-threads behavior.
      return res.status(409).json({ error: 'Conversation threads are not enabled' });
    }
    if (!thread) {
      return res.status(500).json({ error: 'Failed to start a new conversation' });
    }
    // Phase 4: the warm engine session still holds the ARCHIVED conversation,
    // and nothing would displace it — the fresh thread is empty, so `taskSeed`
    // skips its replacing seed. Without this the next freeform run answers from
    // the conversation the user just left. Long-standing hole; the route comment
    // above has admitted it since Phase 1.
    forgetSession(content._id.toString());
    return res.json({ threadId: thread._id, status: 'ok' });
  } catch (err) {
    console.error('[threads] newThread error:', err);
    return res.status(500).json({ error: 'Failed to start a new conversation' });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /:workspaceNumber/content/:contentNumber/ai/threads
// Threads Phase 4: the picker's list — active first, then archived.
// ─────────────────────────────────────────────────────────────
const listThreads = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    const threads = await threadService.listThreads(content._id, {
      limit: Math.max(1, parseInt(req.query.limit, 10) || 20),
    });
    return res.json({ threads });
  } catch (err) {
    console.error('[threads] listThreads error:', err);
    return res.status(500).json({ error: 'Failed to list conversations' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/threads/:threadId/activate
// Threads Phase 4: resume an archived conversation. Same in-flight-run
// guard as newThread — swapping the active thread mid-run would file the
// run's reply on an archived thread.
//
// Conversations Phase 4 CORRECTION: this used to say "no session surgery — the
// seeding invariant re-seeds the next run". That is true only when a seed
// actually runs, and taskSeed bails out silently in two cases (empty stamp, or
// a replay payload the shaper emptied). Both leave the warm session holding the
// previous conversation. It now evicts; see forgetSession.
// ─────────────────────────────────────────────────────────────
const activateThread = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    const { threadId } = req.params;
    if (!threadId || !/^[a-f0-9]{24}$/i.test(threadId)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }
    // P4 review BUG-2: threadWriteLocks covers chat runs (never in the
    // registry) and the agent tail window (registry deleted pre-append).
    if (activeAgentRuns.has(content._id.toString()) || threadWriteLocks.has(content._id.toString())) {
      return res.status(409).json({ error: 'An AI run is in progress on this document — stop it (or let it finish) before switching conversations.' });
    }
    const thread = await threadService.activateThread(content, threadId);
    if (thread && thread.disabled) {
      return res.status(409).json({ error: 'Conversation threads are not enabled' });
    }
    // P4 review BUG-3: a genuine miss is a 404; an internal/race failure is a
    // retryable 503 — never tell the user their conversation "doesn't exist"
    // because Mongo hiccuped (or the bounded activate retry lost).
    if (thread && thread.error) {
      return res.status(503).json({ error: 'Could not switch conversations right now — please try again.' });
    }
    if (!thread) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    // Phase 4: evict here too, despite the seeding invariant.
    //
    // The invariant re-seeds on a threadId mismatch, and a seed REPLACES engine
    // history — so in the common case switching does displace the old
    // conversation. But `taskSeed` has TWO silent bail-outs, and neither is
    // reachable from the marker check: it returns early when the stamp is null
    // (empty thread), and again when the replay shaper filters every message out
    // — which happens to a thread whose only row is an assistant message, the
    // exact shape the archived-thread re-resolve path produces. In either case
    // no seed runs and the warm session keeps the conversation the user just
    // switched AWAY from.
    //
    // Evicting makes the rule uniform — any conversation switch starts a fresh
    // engine session — and costs one setup on a deliberate, infrequent action.
    // Correctness here is worth more than a reused socket.
    forgetSession(content._id.toString());
    // Conversations Phase 9: report the DRAFT's mode alongside the conversation.
    //
    // Mode lives on the content, not the conversation (Content.mode is the
    // source of truth, and neither activate nor newThread touches it). So
    // switching to an old chat on a draft that is in plan mode silently
    // re-enters plan mode: the document tools are denied by the engine's mode
    // rules and the model can only research and propose. Nothing said so, and
    // the transcript the user just opened gives no hint.
    //
    // Reporting rather than RESETTING is deliberate. Forcing chat here would
    // abandon an in-progress plan the user may have spent a run building —
    // destructive, and surprising in the other direction. The conversation is
    // theirs to switch; the draft's mode is not something switching should
    // silently decide.
    return res.json({
      threadId: thread._id, title: thread.title || '',
      mode: content.mode || 'chat', status: 'ok',
    });
  } catch (err) {
    console.error('[threads] activateThread error:', err);
    return res.status(500).json({ error: 'Failed to switch conversations' });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /:workspaceNumber/content/:contentNumber/ai/threads/:threadId
// Conversations Phase 2: rename a conversation. Auto-titles are the first user
// message truncated, which is frequently wrong or ugly.
//
// Carries the SAME in-flight guard as newThread/activateThread even though a
// rename cannot corrupt a run: the four thread routes are one surface, and a
// route that silently behaves differently under load is how the next reader
// concludes the guard is optional.
// ─────────────────────────────────────────────────────────────
const renameThread = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    const { threadId } = req.params;
    if (!threadId || !/^[a-f0-9]{24}$/i.test(threadId)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }
    if (activeAgentRuns.has(content._id.toString()) || threadWriteLocks.has(content._id.toString())) {
      return res.status(409).json({ error: 'An AI run is in progress on this document — stop it (or let it finish) before renaming conversations.' });
    }
    const thread = await threadService.renameThread(content, threadId, req.body?.title);
    if (thread && thread.disabled) {
      return res.status(409).json({ error: 'Conversation threads are not enabled' });
    }
    // An empty/whitespace title is rejected rather than stored: a stored empty
    // title re-arms the auto-titler, so the next message would silently rename
    // the conversation again (see threadService.renameThread).
    if (thread && thread.invalid) {
      return res.status(400).json({ error: 'A conversation name cannot be empty' });
    }
    if (thread && thread.error) {
      return res.status(503).json({ error: 'Could not rename the conversation right now — please try again.' });
    }
    if (!thread) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    return res.json({ threadId: thread._id, title: thread.title || '', status: 'ok' });
  } catch (err) {
    console.error('[threads] renameThread error:', err);
    return res.status(500).json({ error: 'Failed to rename the conversation' });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /:workspaceNumber/content/:contentNumber/ai/threads/:threadId
// Conversations Phase 5: remove a conversation permanently.
//
// The in-flight guard is MANDATORY here, not a courtesy. Without it,
// appendMessage's archived-thread re-resolve files the running turn's assistant
// reply onto a freshly minted thread — whose leading assistant row
// shapeThreadForReplay then silently DROPS, so the reply exists in history but
// never in AI memory.
//
// The eviction is equally mandatory: deleting the active conversation leaves
// zero actives, the next run mints an EMPTY thread, and an empty thread makes
// taskSeed skip its replacing seed — so without forgetSession the warm engine
// session would keep answering from the conversation the user just deleted.
// Verified live: backend/scripts/forget-smoke.mjs fails at step 4 without it.
// ─────────────────────────────────────────────────────────────
const deleteThread = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;
    const { threadId } = req.params;
    if (!threadId || !/^[a-f0-9]{24}$/i.test(threadId)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }
    if (activeAgentRuns.has(content._id.toString()) || threadWriteLocks.has(content._id.toString())) {
      return res.status(409).json({ error: 'An AI run is in progress on this document — stop it (or let it finish) before deleting conversations.' });
    }
    const result = await threadService.deleteThread(content, threadId);
    if (result && result.disabled) {
      return res.status(409).json({ error: 'Conversation threads are not enabled' });
    }
    if (result && result.error) {
      return res.status(503).json({ error: 'Could not delete the conversation right now — please try again.' });
    }
    if (!result) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    // Phase 4. Unconditional: the deleted thread may have been the one the warm
    // session was seeded from even when it was not the ACTIVE one (the marker
    // records what was last replayed, not what is current).
    forgetSession(content._id.toString());
    // `wasActive` is load-bearing for the client, not diagnostics: if the user
    // deleted the conversation they were IN, its messages are still on their
    // screen and the header still names it. Only the server knows which one was
    // active, so it has to say.
    return res.json({
      threadId, deleted: result.threads, messages: result.messages,
      wasActive: !!result.wasActive, status: 'ok',
    });
  } catch (err) {
    console.error('[threads] deleteThread error:', err);
    return res.status(500).json({ error: 'Failed to delete the conversation' });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /skills — user-facing wrapper around the internal skills bridge.
// Auth is the workspaceRoutes global token check; we don't require a
// workspaceNumber because skills are global to the writing-engine.
// ─────────────────────────────────────────────────────────────
const listSkills = async (req, res) => {
  try {
    const skills = await writingEngine.listSkills();
    res.json({ skills: Array.isArray(skills) ? skills : [] });
  } catch (err) {
    console.error('[skills] proxy failed:', err.message);
    res.status(502).json({ error: 'writing-engine unreachable', detail: err.message });
  }
};

// ─── Cross-controller helper ───────────────────────────────────────
//
// Phase 2 / Task #100: when analysis re-runs mid-edit, the engine session
// keeps the stale brief in memory until the next setupSession() call (i.e.,
// until the next chat/agent invocation). For a writer mid-conversation,
// that means seeing the live SEO gauge with outdated targets.
//
// resyncBriefIfActive(contentId) re-pushes the brief + context files for
// the already-open session, so the gauge updates as soon as analysis
// finishes — no need to start a new chat to pick up the new data.
//
// Returns true when a push happened, false when no active session exists.
// Logs errors but never throws; analysisController treats this as best-effort.
async function resyncBriefIfActive(contentId) {
  if (!contentId) return false;
  const key = contentId.toString();
  const entry = contentSessionMap.get(key);
  if (!entry) return false;

  // Reload the content with the freshly-saved analysis fields.
  const content = await Content.findById(key).lean().catch(() => null);
  if (!content) return false;

  try {
    const brief = benchmarkToContentBrief(content);
    // Re-append the link inventory — pushBrief replaces the whole brief on
    // the engine, so omitting this here would strip availableLinks from the
    // live session after every analysis re-run.
    try {
      const workspaceId = content.workspaceId || content.workspace;
      brief.availableLinks = await buildAvailableLinks(
        workspaceId,
        brief.targetKeyword,
        brief.secondaryKeywords,
      );
      // R3: keep the allowlist in sync too — pushBrief replaces the whole brief.
      brief.allowlistUrls = await buildAllowlistUrls(workspaceId);
    } catch (err) {
      console.error('availableLinks rebuild failed (non-fatal):', err.message);
    }
    await writingEngine.pushBrief(entry.sessionId, brief);

    // Also refresh the context files (research-outline / seo-targets /
    // content-audit) so ReadFile tool calls in the next turn see the same
    // updates the gauge does.
    const contextFiles = {};
    if (content.recommendedOutline || content.competitorPages?.length || content.peopleAlsoAsk?.length) {
      contextFiles['research-outline.md'] = buildResearchOutlineMd(content);
    }
    if (brief && (brief.nlpTerms?.length || brief.secondaryKeywords?.length || brief.targetKeyword)) {
      contextFiles['seo-targets.md'] = buildSeoTargetsMd(brief);
    }
    const latestAudit = content.audits?.[content.audits.length - 1];
    if (latestAudit) {
      const auditMd = buildContentAuditMd(latestAudit);
      if (auditMd) contextFiles['content-audit.md'] = auditMd;
    }
    if (Object.keys(contextFiles).length > 0) {
      await writingEngine.pushContextFiles(entry.sessionId, contextFiles);
    }

    entry.lastUsed = Date.now();
    console.log(`[resync] pushed fresh brief + context to session ${entry.sessionId} for content ${key}`);
    return true;
  } catch (err) {
    console.error(`[resync] failed for content ${key}:`, err.message);
    return false;
  }
}

module.exports = { chat, agent, generateImage, inlineEdit, autocomplete, rehostImage, uploadImage, clarifyAnswer, planConfirm, steer, stopRevert, stopRun, engineContent, runStatus, getThread, newThread, listThreads, activateThread, renameThread, deleteThread, listSkills, resyncBriefIfActive,
  // Exported for test coverage (cost-ledger usage tap + Phase-4 preset resolver).
  // Not part of the runtime API surface.
  makeUsageTap, resolvePreset, clampAgentBudget,
  checkArticleAllowance, commitArticleGeneration,
  // Exported so tests can seed the content→session binding (resume tenancy)
  // and pin the W2-b doc-write marker's session guard.
  contentSessionMap, rememberSession, recordRunDocWrites,
  // Conversations Phase 4: exported so tests can pin "a destructive thread
  // action makes the engine forget" — the property Phase 5's delete rests on.
  forgetSession,
  // P2: exported for the seeding-marker contiguity tests (review BUG-2).
  maybeBumpSeededMarker,
  // P4: exported for the thread-write-lock guard tests (review BUG-2).
  lockThreadWrites, unlockThreadWrites,
  // Exported for the setupSession evicted-session (404) retry test.
  setupSession,
  // W4-b: exported for the stop-revert registry lifecycle test.
  activeAgentRuns };
