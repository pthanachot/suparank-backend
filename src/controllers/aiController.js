const Content = require('../models/Content');
const BrandVoice = require('../models/BrandVoice');
const Avatar = require('../models/Avatar');
const CreditTransaction = require('../models/CreditTransaction');
const Plan = require('../models/Plan');
const AgentUsageLog = require('../models/AgentUsageLog');
const { blocksToMarkdown, stripHtml } = require('../services/blocksToMarkdown');
const { markdownToBlocks } = require('../services/markdownToBlocks');
const { benchmarkToContentBrief } = require('../services/benchmarkToContentBrief');
const { buildResearchOutlineMd, buildSeoTargetsMd, buildContentAuditMd } = require('../services/contextFileGenerators');
const { mapEditsToPatches } = require('../services/mapEditsToPatches');
const writingEngine = require('../services/writingEngine');
const { toGoPlan } = require('../services/planSerializer');
const imageStorage = require('../services/imageStorage');
const creditService = require('../services/creditService');

// ─── Session reuse map ───────────────────────────────────────
// Maps contentId → { sessionId, lastUsed } for conversation memory.
// When reuseSession is true, we reuse the engine session so the AI
// keeps its conversation history (like Claude Code).
const contentSessionMap = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

// Clean up stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of contentSessionMap) {
    if (now - entry.lastUsed > SESSION_TTL_MS) {
      contentSessionMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

/**
 * Build a lightweight tap that scans SSE bytes for `usage` events and
 * accumulates input/output token counts across the stream. Go emits one
 * usage event per agent turn with per-turn counts (see query.go:497-503),
 * so we sum them. The tap is *read-only* — the raw bytes still go to
 * `res.write` unchanged; we just observe them in flight.
 */
function makeUsageTap() {
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
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
          if (ev && ev.type === 'usage' && ev.usage) {
            inputTokens += Number(ev.usage.inputTokens) || 0;
            outputTokens += Number(ev.usage.outputTokens) || 0;
          }
        } catch { /* malformed event — skip */ }
      }
    },
    snapshot() {
      return { inputTokens, outputTokens };
    },
  };
}

/**
 * Persist the accumulated usage at stream end. Best-effort: a failed write
 * must NOT block the response that already went to the user.
 */
function persistUsage(content, tap, source) {
  const totals = tap.snapshot();
  if (totals.inputTokens === 0 && totals.outputTokens === 0) return;
  AgentUsageLog.create({
    workspaceId: content.workspaceId,
    contentId: content._id,
    contentType: content.contentType || '',
    mode: content.mode || 'chat',
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    source,
  }).catch((err) => {
    // Never throw past the SSE response — observability hygiene only.
    console.warn('[usage-tap] persist failed', err.message);
  });
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
  const content = await Content.findByNumber(req.workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
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
async function setupSession(content, { avatarId, reuseSession } = {}) {
  const contentId = content._id.toString();
  let sessionId;

  // Reuse existing session if available (conversation memory)
  if (reuseSession) {
    const existing = contentSessionMap.get(contentId);
    if (existing) {
      existing.lastUsed = Date.now();
      sessionId = existing.sessionId;
    }
  }

  // Create new session if needed
  if (!sessionId) {
    sessionId = await writingEngine.createSession();
    contentSessionMap.set(contentId, { sessionId, lastUsed: Date.now() });
  }

  // 2. Convert blocks → markdown and push document
  const markdown = blocksToMarkdown(content.blocks || []);
  if (markdown) {
    await writingEngine.pushDocument(sessionId, markdown);
  }

  // 3. Convert benchmark → brief and push
  const brief = benchmarkToContentBrief(content);

  // 3b. If the wizard picked another draft as a writing-style reference,
  // append its markdown to authorContext with a strict "STYLE ONLY" header.
  // The Go engine already feeds authorContext into the system prompt, so
  // this needs zero engine changes. Reference is scoped to the same
  // workspace (lookup via findByNumber + content.workspaceId).
  if (content.styleReferenceContentNumber) {
    const ref = await Content.findByNumber(
      content.workspaceId,
      content.styleReferenceContentNumber,
    );
    if (ref && Array.isArray(ref.blocks) && ref.blocks.length > 0) {
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

  await writingEngine.pushBrief(sessionId, brief);

  // 4. Generate and push context files for ReadFile tool (non-fatal)
  try {
    const contextFiles = {};

    // research-outline.md — from benchmark + competitor data
    if (content.recommendedOutline || content.competitorPages?.length || content.peopleAlsoAsk?.length) {
      contextFiles['research-outline.md'] = buildResearchOutlineMd(content);
    }

    // seo-targets.md — from SEO brief
    if (brief && (brief.nlpTerms?.length || brief.secondaryKeywords?.length || brief.targetKeyword)) {
      contextFiles['seo-targets.md'] = buildSeoTargetsMd(brief);
    }

    // content-audit.md — from latest audit results (if available)
    const latestAudit = content.audits?.[content.audits.length - 1];
    if (latestAudit) {
      const auditMd = buildContentAuditMd(latestAudit);
      if (auditMd) contextFiles['content-audit.md'] = auditMd;
    }

    if (Object.keys(contextFiles).length > 0) {
      await writingEngine.pushContextFiles(sessionId, contextFiles);
    }
  } catch (err) {
    console.error('Context files push failed (non-fatal):', err.message);
  }

  // 5. Push brand voice + selected avatar to the engine (non-fatal)
  try {
    const workspaceId = content.workspaceId || content.workspace;
    const brandVoice = await BrandVoice.findOne({ workspace: workspaceId, active: true }).lean();
    let combinedMarkdown = '';

    if (brandVoice && brandVoice.content) {
      combinedMarkdown += brandVoice.content;
    }

    if (avatarId) {
      const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspaceId, active: true }).lean();
      if (avatar && avatar.content) {
        combinedMarkdown += (combinedMarkdown ? '\n\n---\n\n' : '') + avatar.content;
      }
    }

    if (combinedMarkdown.trim()) {
      await writingEngine.pushBrandVoice(sessionId, combinedMarkdown);
    }
  } catch (err) {
    console.error('Brand voice push failed (non-fatal):', err.message);
  }

  // ── M5: plan-mode orchestration ──────────────────────────────────────
  // Push the session's mode + current plan + CFS connection info BEFORE
  // returning. Order matters: mode is pushed first so the strategy
  // router knows which strategy to instantiate; plan and CFS come after.
  // Failures here are logged but don't block chat — Go falls back to
  // chat-mode defaults on missing pushes.
  await pushPlanModeContext(sessionId, content);

  return { sessionId, markdown };
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
async function pushPlanModeContext(sessionId, content) {
  // Bug #H fix: aggregate failures into one structured log line at the
  // end so a misconfigured session is visible in a single grep, not
  // spread across three separate errors. Includes sessionId + content
  // identifiers so the line is correlatable in multi-tenant logs.
  const failures = [];

  const mode = content.mode || 'chat';
  const allowed = MODE_ALLOWED_TOOLS[mode] || [];
  try {
    await writingEngine.pushMode(sessionId, mode, allowed);
  } catch (err) {
    failures.push({ step: 'pushMode', error: err.message });
  }

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

  try {
    await writingEngine.pushPlan(sessionId, plan ? toGoPlan(plan) : null);
  } catch (err) {
    failures.push({ step: 'pushPlan', error: err.message });
  }

  // CFS config — required for Go's context tools. Without it, Go's
  // CFS client constructor returns nil and the tools error out. Fail
  // loud rather than letting that surface mid-loop.
  const apiKey = process.env.INTERNAL_API_KEY;
  const expressBaseUrl = process.env.EXPRESS_INTERNAL_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    'http://localhost:4001';
  if (!apiKey) {
    failures.push({ step: 'cfsConfig', error: 'INTERNAL_API_KEY not set — context tools will be unavailable' });
  } else {
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
      await writingEngine.pushCFSConfig(sessionId, {
        baseUrl: expressBaseUrl,
        apiKey,
        workspaceNumber,
        contentNumber: content.contentNumber || 0,
      });
    } catch (err) {
      failures.push({ step: 'pushCFSConfig', error: err.message });
    }
  }

  if (failures.length > 0) {
    console.warn('[setupSession] plan-mode push had failures', {
      sessionId,
      contentId: content._id,
      contentNumber: content.contentNumber,
      mode,
      failures,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/chat
// SSE streaming chat — streams thinking_delta, text_delta, tool events,
// and final draft/patch events so the UI can show live progress.
// ─────────────────────────────────────────────────────────────
const chat = async (req, res) => {
  let creditTxId = null;
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { prompt, avatarId } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // Set up Writing Engine session
    const { sessionId } = await setupSession(content, { avatarId });

    // Pre-deduct credits before starting the stream
    if (req.creditContext?.deductionEnabled) {
      try {
        const result = await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId,
          req.creditContext.estimatedCredits,
          req.creditContext.featureKey,
          { contentId: content._id.toString(), feature: 'aiChat' }
        );
        creditTxId = result.transactionId;
      } catch (creditErr) {
        return res.status(402).json({
          error: creditErr.message,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

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

    // Start streaming request to the engine
    const chatRes = await writingEngine.sendChatMessageStream(sessionId, prompt, abortCtrl.signal);

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

    const processEvents = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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

    // Stream completed — mark credits as settled
    if (creditTxId) {
      CreditTransaction.findByIdAndUpdate(creditTxId, { status: 'settled' }).catch(() => {});
    }

    persistUsage(content, usageTap, 'chat');
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
      return res.status(500).json({ error: err.message || 'AI chat failed' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/agent
// SSE streaming — agent writes/edits, streams progress
// ─────────────────────────────────────────────────────────────
const agent = async (req, res) => {
  let creditTxId = null;
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { goal, targetScore, maxIterations, allowedTools, avatarId, mode, executionMode } = req.body;
    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ error: 'goal is required' });
    }

    // Set up Writing Engine session (reuse for conversation memory in freeform mode)
    const isFreeform = !mode || mode === 'freeform';
    const { sessionId } = await setupSession(content, { avatarId, reuseSession: isFreeform });

    // Push execution mode to engine if specified
    if (executionMode) {
      try {
        await writingEngine.setExecutionMode(sessionId, executionMode);
      } catch (err) {
        console.error('Set execution mode failed (non-fatal):', err.message);
      }
    }

    // Pre-deduct credits before starting the stream
    if (req.creditContext?.deductionEnabled) {
      try {
        const result = await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId,
          req.creditContext.estimatedCredits,
          req.creditContext.featureKey,
          { contentId: content._id.toString(), feature: 'aiAgent' }
        );
        creditTxId = result.transactionId;
      } catch (creditErr) {
        return res.status(402).json({
          error: creditErr.message,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    // AbortController tied to the client request so that if the browser
    // disconnects (user pressed Stop / Esc), we abort the fetch to the Go
    // engine — which in turn cancels the handler's r.Context(), stopping
    // the agent mid-turn.
    const abortCtrl = new AbortController();
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
      abortCtrl.abort();
    });

    // Start agent — returns a raw SSE response from the Writing Engine
    // mode: "freeform" (default, Claude Code-style) or "sequential" (legacy phases)
    const agentRes = await writingEngine.startAgent(
      sessionId, goal, targetScore || 75, maxIterations || 5, abortCtrl.signal, allowedTools, mode || 'freeform'
    );

    // Set up SSE headers for the client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Emit session_init event so frontend knows the sessionId for mid-run actions
    res.write(`data: ${JSON.stringify({ type: 'session_init', sessionId })}\n\n`);

    // Raw byte pipe — forward Go engine SSE stream directly to the client.
    // All event transformation (document_diff → patch/draft) is now handled
    // client-side in EditorChatBar.tsx. This eliminates per-event JSON
    // parse/serialize overhead for text_delta and thinking_delta events.
    const reader = agentRes.body.getReader();
    const usageTap = makeUsageTap();

    const processEvents = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
        console.log('[agent-sse] stream aborted by client disconnect');
        // Refund credits on client abort
        if (creditTxId) {
          creditService.refund(creditTxId).catch((e) =>
            console.error('[credit] agent abort refund failed:', e.message)
          );
          creditTxId = null;
        }
      } else {
        throw streamErr;
      }
    }

    // Stream completed — mark credits as settled
    if (creditTxId) {
      CreditTransaction.findByIdAndUpdate(creditTxId, { status: 'settled' }).catch(() => {});
    }

    persistUsage(content, usageTap, 'agent');
    if (!clientDisconnected) res.end();
  } catch (err) {
    // Refund credits on error
    if (creditTxId) {
      creditService.refund(creditTxId).catch((e) =>
        console.error('[credit] agent error refund failed:', e.message)
      );
    }

    // AbortError from fetch when client disconnected — silent.
    if (err.name === 'AbortError') {
      console.log('[agent-sse] upstream fetch aborted');
      return;
    }
    console.error('AI agent error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'AI agent failed' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
};

/**
 * Carry forward UI-only metadata from old blocks to matching new blocks.
 * Preserves image width/align and re-inserts editor-only blocks (toc, cta)
 * that the LLM cannot produce.
 */
function mergeUiMetadata(oldBlocks, newBlocks) {
  const result = [...newBlocks];

  // 1. Carry forward image width/align from old blocks to matching new blocks
  for (const newB of result) {
    if (newB.type === 'img' && newB.src) {
      const oldB = oldBlocks.find(
        (ob) => ob.type === 'img' && ob.src === newB.src,
      );
      if (oldB) {
        if (oldB.width) newB.width = oldB.width;
        if (oldB.align) newB.align = oldB.align;
      }
    }
  }

  // 2. Re-insert toc blocks (editor-only, LLM never produces them)
  const tocBlocks = oldBlocks.filter((b) => b.type === 'toc');
  if (tocBlocks.length > 0 && !result.some((b) => b.type === 'toc')) {
    const h1Idx = result.findIndex((b) => b.type === 'h1');
    const insertIdx = h1Idx >= 0 ? h1Idx + 1 : 0;
    for (const toc of tocBlocks) {
      result.splice(insertIdx, 0, { ...toc });
    }
  }

  // 3. Re-insert cta blocks at their original relative position (end of doc)
  const ctaBlocks = oldBlocks.filter((b) => b.type === 'cta');
  if (ctaBlocks.length > 0 && !result.some((b) => b.type === 'cta')) {
    for (const cta of ctaBlocks) {
      result.push({ ...cta });
    }
  }

  return result;
}

/**
 * Transform a Writing Engine agent event into a frontend-friendly format.
 * Converts document_diff events into block patches.
 */
function transformAgentEvent(event, currentBlocks, lastMarkdown) {
  switch (event.type) {
    case 'document_diff':
    case 'document_update': {
      if (!event.documentContent) return event;

      const newMarkdown = event.documentContent;
      const hadContent = currentBlocks.length > 0 &&
        currentBlocks.some((b) => b.text && b.text.trim().length > 0);

      if (!hadContent) {
        // Initial draft — send full blocks
        const newBlocks = markdownToBlocks(newMarkdown);
        return {
          type: 'draft',
          blocks: newBlocks,
          _newBlocks: newBlocks,
          _newMarkdown: newMarkdown,
        };
      }

      // Edits — diff old blocks vs new blocks to produce patches
      const newBlocks = markdownToBlocks(newMarkdown);
      const patches = diffBlocksToPatches(currentBlocks, newBlocks);

      if (patches.length > 0) {
        // Apply patches to currentBlocks for tracking. Images carry src/alt
        // on the patch instead of text, so merge those through when present.
        const updatedBlocks = [...currentBlocks];
        for (const p of patches) {
          const idx = updatedBlocks.findIndex((b) => b.id === p.blockId);
          if (idx !== -1) {
            const merged = { ...updatedBlocks[idx], text: p.text };
            if (p.src !== undefined) merged.src = p.src;
            if (p.alt !== undefined) merged.alt = p.alt;
            updatedBlocks[idx] = merged;
          }
        }
        return {
          type: 'patch',
          patches,
          _newBlocks: updatedBlocks,
          _newMarkdown: newMarkdown,
        };
      }

      // Fallback: full block replacement if structure changed (new sections added/removed)
      // Carry forward UI-only metadata (width, align, toc, cta) from old blocks
      const merged = mergeUiMetadata(currentBlocks, newBlocks);
      return {
        type: 'draft',
        blocks: merged,
        _newBlocks: merged,
        _newMarkdown: newMarkdown,
      };
    }

    case 'clarify_request':
    case 'agent_progress':
    case 'text_delta':
    case 'thinking_delta':
    case 'usage':
    case 'complete':
    case 'error':
    case 'recovery':
      return event;

    default:
      return event;
  }
}

/**
 * Diff old blocks against new blocks to produce patches.
 * Uses content-based matching (not position) to handle insertions/deletions.
 *
 * Algorithm:
 * 1. Build a signature for each block: type + plain text
 * 2. Find LCS (Longest Common Subsequence) of old and new signatures
 * 3. Blocks in LCS are "unchanged" — preserve their IDs
 * 4. Blocks not in LCS on old side: deleted
 * 5. Blocks not in LCS on new side: inserted (no patch — triggers fallback)
 * 6. Matched blocks with different text: produce "replace" patches
 *
 * Returns patches only when all changes are in-place edits (no structural changes).
 * Returns empty array for insertions/deletions → caller falls back to full draft.
 *
 * @param {Array} oldBlocks - Original blocks from MongoDB
 * @param {Array} newBlocks - Blocks converted from Writing Engine's markdown
 * @returns {Array<{op: string, blockId: string, text: string}>}
 */
function diffBlocksToPatches(oldBlocks, newBlocks) {
  // Signature helper: for text blocks use stripped text; for img blocks use
  // src+alt because .text is always empty on images. Without this, an image
  // swap (![alt](oldUrl) → ![alt](newUrl)) would be silently "matched" and
  // never emitted as a patch, so the UI would keep showing the old picture.
  const sigOf = (b) => {
    if (b.type === 'img') {
      return 'img:' + (b.src || '') + '|' + (b.alt || '');
    }
    return b.type + ':' + stripHtml(b.text || '').trim();
  };

  // Build signatures
  const oldSigs = oldBlocks.map(sigOf);
  const newSigs = newBlocks.map(sigOf);

  // If lengths differ significantly, it's a structural change → fallback to draft
  if (Math.abs(oldBlocks.length - newBlocks.length) > 2) {
    return [];
  }

  // Try simple position-based matching for blocks that share the same type
  // This works for in-place edits (most common case from EditTool)
  const patches = [];
  let matched = 0;

  if (oldBlocks.length === newBlocks.length) {
    // Same structure — compare position by position
    for (let i = 0; i < oldBlocks.length; i++) {
      const oldB = oldBlocks[i];
      const newB = newBlocks[i];

      if (sigOf(oldB) === sigOf(newB)) {
        matched++;
      } else if (oldB.type === 'img' && newB.type === 'img') {
        // Image swap — carry src/alt on the patch so the frontend can apply it.
        patches.push({
          op: 'replace',
          blockId: oldB.id,
          text: newB.text || '',
          src: newB.src || '',
          alt: newB.alt || '',
        });
      } else {
        patches.push({
          op: 'replace',
          blockId: oldB.id,
          text: newB.text,
        });
      }
    }
    // Only return patches if most blocks matched (>50%) — otherwise it's a rewrite
    if (matched >= oldBlocks.length * 0.5) {
      return patches;
    }
    return []; // too many changes — fallback to draft
  }

  // Different lengths → structural change (insertions or deletions)
  // Find blocks in old that have exact matches in new (by signature)
  for (let i = 0; i < oldBlocks.length; i++) {
    if (newSigs.includes(oldSigs[i])) {
      matched++;
    }
  }

  // If most old blocks survived, we can produce targeted patches for the ones that changed
  if (matched >= oldBlocks.length * 0.7) {
    // Match each old block to the closest new block with same type
    for (let i = 0; i < oldBlocks.length; i++) {
      const oldB = oldBlocks[i];
      const oldType = oldB.type;

      // Find the new block with same type and identical signature
      let bestMatch = -1;
      for (let j = 0; j < newBlocks.length; j++) {
        if (newBlocks[j].type === oldType && sigOf(newBlocks[j]) === sigOf(oldB)) {
          bestMatch = j;
          break;
        }
      }

      if (bestMatch === -1) {
        // Old block was modified — find the closest new block by type at similar position
        for (let j = Math.max(0, i - 2); j < Math.min(newBlocks.length, i + 3); j++) {
          if (newBlocks[j].type === oldType && sigOf(newBlocks[j]) !== sigOf(oldB)) {
            const newB = newBlocks[j];
            if (oldType === 'img') {
              patches.push({
                op: 'replace',
                blockId: oldB.id,
                text: newB.text || '',
                src: newB.src || '',
                alt: newB.alt || '',
              });
            } else {
              patches.push({
                op: 'replace',
                blockId: oldB.id,
                text: newB.text,
              });
            }
            break;
          }
        }
      }
    }
    return patches;
  }

  // Too much structural change — fallback to draft
  return [];
}

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

    const { sessionId } = await setupSession(content);

    const result = await writingEngine.generateImage(sessionId, {
      description,
      format: format || 'svg',
      style: style || 'flat',
    });

    // Upload generated image to B2 if available
    if (imageStorage.isEnabled()) {
      const wsId = content.workspaceId.toString();
      const cn = content.contentNumber;
      try {
        if (result.dataUri && result.dataUri.startsWith('data:image/')) {
          result.dataUri = await imageStorage.uploadFromDataUri(result.dataUri, wsId, cn);
        } else if (result.dataUri && result.dataUri.includes('/api/images/img_')) {
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

    return res.json(result);
  } catch (err) {
    console.error('Image generation error:', err);
    return res.status(500).json({ error: err.message || 'Image generation failed' });
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
    const result = await writingEngine.submitClarifyAnswer(sessionId, answer);
    return res.json(result);
  } catch (err) {
    console.error('Clarify answer error:', err);
    return res.status(500).json({ error: err.message || 'Failed to submit answer' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/plan-confirm
// Proxies the user's plan confirmation to the Writing Engine.
// ─────────────────────────────────────────────────────────────
const planConfirm = async (req, res) => {
  try {
    const { sessionId, action, selectedSteps, mode } = req.body;
    if (!sessionId || !action) {
      return res.status(400).json({ error: 'sessionId and action are required' });
    }
    const result = await writingEngine.submitPlanConfirm(sessionId, {
      action,
      selectedSteps: selectedSteps || [],
      mode: mode || 'auto',
    });
    return res.json(result);
  } catch (err) {
    console.error('Plan confirm error:', err);
    return res.status(500).json({ error: err.message || 'Failed to submit plan confirm' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/tool-confirm
// Proxies the user's tool confirm response (step-by-step mode).
// ─────────────────────────────────────────────────────────────
const toolConfirm = async (req, res) => {
  try {
    const { sessionId, action } = req.body;
    if (!sessionId || !action) {
      return res.status(400).json({ error: 'sessionId and action are required' });
    }
    const result = await writingEngine.submitToolConfirm(sessionId, action);
    return res.json(result);
  } catch (err) {
    console.error('Tool confirm error:', err);
    return res.status(500).json({ error: err.message || 'Failed to submit tool confirm' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/execution-mode
// Sets the execution mode (auto / step-by-step) on a running session.
// Called when user toggles the mode mid-run.
// ─────────────────────────────────────────────────────────────
const setExecutionMode = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { mode } = req.body;
    if (!mode || !['auto', 'step-by-step'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "auto" or "step-by-step"' });
    }

    // Find active session for this content
    const contentId = content._id.toString();
    const existing = contentSessionMap.get(contentId);
    if (!existing) {
      return res.status(404).json({ error: 'No active session for this content' });
    }

    const result = await writingEngine.setExecutionMode(existing.sessionId, mode);
    return res.json(result);
  } catch (err) {
    console.error('Set execution mode error:', err);
    return res.status(500).json({ error: err.message || 'Failed to set execution mode' });
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

module.exports = { chat, agent, generateImage, uploadImage, clarifyAnswer, planConfirm, toolConfirm, setExecutionMode, listSkills, resyncBriefIfActive };
