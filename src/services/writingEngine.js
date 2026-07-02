/**
 * Writing Engine client — manages sessions and communication
 * with the AI Writing Engine (Go service).
 *
 * The Writing Engine is stateless per-conversation. Each AI interaction:
 * 1. Creates a session
 * 2. Pushes the document (markdown) and SEO brief
 * 3. Sends the user's prompt
 * 4. Receives edits or new document content
 * 5. Session is discarded
 */

const WRITING_ENGINE_URL = process.env.WRITING_ENGINE_URL || 'http://localhost:8090';

/**
 * Standard headers for engine calls. The engine authenticates callers with
 * a shared internal key (X-Internal-Key ← ENGINE_INTERNAL_KEY) and rejects
 * requests without it — see writing-engine internal auth middleware.
 */
function engineHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(process.env.ENGINE_INTERNAL_KEY && {
      'X-Internal-Key': process.env.ENGINE_INTERNAL_KEY,
    }),
    ...extra,
  };
}

/**
 * Create a new Writing Engine session.
 * @returns {Promise<string>} sessionId
 */
async function createSession(signal) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session`, {
    method: 'POST',
    headers: engineHeaders(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: create session failed (${res.status})`);
  }
  const data = await res.json();
  return data.sessionId;
}

/**
 * Push document content to a Writing Engine session.
 * @param {string} sessionId
 * @param {string} markdownContent
 */
async function pushDocument(sessionId, markdownContent, signal) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/document`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ content: markdownContent }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: push document failed (${res.status})`);
  }
}

/**
 * Push SEO brief to a Writing Engine session.
 * @param {string} sessionId
 * @param {Object} brief - ContentBrief object
 */
async function pushBrief(sessionId, brief) {
  if (!brief || !brief.targetKeyword) return;
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/brief`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify(brief),
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: push brief failed (${res.status})`);
  }
}

/**
 * Push brand voice markdown to a Writing Engine session.
 * @param {string} sessionId
 * @param {string} markdownContent - Combined brand voice + avatar markdown
 */
async function pushBrandVoice(sessionId, markdownContent) {
  if (!markdownContent) return;
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/brand-voice`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ content: markdownContent }),
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: push brand voice failed (${res.status})`);
  }
}

/**
 * Push the workspace's image style to a Writing Engine session.
 * The engine applies it to AI-generated images and AI-modified stock photos
 * so the site's visuals stay consistent.
 *
 * NOTE: no early-return on empty — an empty style is meaningful (it CLEARS
 * the style, important for reused sessions after the user removes a style).
 *
 * @param {string} sessionId
 * @param {string} style - preset name (e.g. "editorial") or custom prompt; '' clears
 */
async function pushImageStyle(sessionId, style) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/image-style`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ style: style || '' }),
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: push image style failed (${res.status})`);
  }
}

/**
 * Send a chat message to the Writing Engine via SSE streaming.
 * The engine's /chat endpoint streams every event (thinking_delta,
 * text_delta, tool_start, document_diff, complete, error) so the UI
 * can render the model's reasoning and draft text live.
 *
 * Returns the raw fetch Response — caller is responsible for reading
 * the SSE stream from response.body.
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @param {AbortSignal} [signal] - optional signal to abort the stream when the client disconnects
 * @returns {Promise<Response>} The raw fetch response (SSE stream)
 */
async function sendChatMessageStream(sessionId, prompt, signal) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/chat`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine chat failed (${res.status}): ${body}`);
  }
  return res;
}

/**
 * Start an agent run via SSE streaming.
 * Returns a readable stream of SSE events.
 *
 * @param {string} sessionId
 * @param {string} goal
 * @param {number} [targetScore=75]
 * @param {number} [maxIterations=5]
 * @param {AbortSignal} [signal] - optional signal to abort the stream when the client disconnects
 * @param {string[]} [allowedTools] - restrict agent to only these tools (e.g. ["EditTool"])
 * @returns {Promise<Response>} The raw fetch response (SSE stream)
 */
async function startAgent(sessionId, goal, targetScore = 75, maxIterations = 5, signal, allowedTools, mode) {
  const payload = { goal, targetScore, maxIterations };
  if (allowedTools?.length > 0) {
    payload.allowedTools = allowedTools;
  }
  if (mode) {
    payload.mode = mode;
  }
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/agent`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: agent start failed (${res.status}): ${body}`);
  }
  // Return raw response — caller reads the SSE stream
  return res;
}

/**
 * Generate an image directly (no chat loop).
 * Uses the Writing Engine's /generate-image endpoint.
 *
 * @param {string} sessionId
 * @param {{ description: string, format: 'svg' | 'png', style?: string }} params
 * @returns {Promise<{ format: string, url?: string, svg?: string }>}
 */
async function generateImage(sessionId, { description, format, style }) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/generate-image`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ description, format, style }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: image generation failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ─── M5: plan-mode push methods ─────────────────────────────────────────
//
// Express orchestrates plan-mode state by pushing the current view onto
// the Go session at the start of each chat request. Three independent
// pushes (mode/plan/cfs) avoid an "everything-or-nothing" call so a
// future evolution can update one without re-sending the others.
//
// All three are best-effort — if Go is unreachable we log and let the
// chat proceed (Go falls back to chat-mode defaults). The push payloads
// are tolerant: pushing the same state twice is a no-op.

/**
 * Push the session mode (chat | plan | execute) and an optional explicit
 * allowedTools list. When allowedTools is omitted, Go derives the set
 * from its FilterByMode mapping.
 */
async function pushMode(sessionId, mode, allowedTools) {
  const body = { mode };
  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    body.allowedTools = allowedTools;
  }
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/mode`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Writing Engine: push mode failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Push the current Plan onto the session. Pass `null` (or omit) to
 * clear the session's plan snapshot — used after /plan/reject so a
 * subsequent /plan/enter doesn't start from a stale archived plan.
 *
 * The plan should already be in the Go-side wire shape (use
 * planSerializer.toGoPlan to convert from a Mongoose doc).
 */
async function pushPlan(sessionId, plan) {
  const payload = plan == null ? 'null' : JSON.stringify(plan);
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/plan`, {
    method: 'POST',
    headers: engineHeaders(),
    body: payload,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Writing Engine: push plan failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Push CFS connection info — baseUrl + internal API key + workspace/
 * content scoping. Go's tool layer (ListContext/ReadContext/...) uses
 * these to call back into Express's /api/internal/cfs/* routes.
 */
async function pushCFSConfig(sessionId, { baseUrl, apiKey, workspaceNumber, contentNumber }) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/cfs`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ baseUrl, apiKey, workspaceNumber, contentNumber }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Writing Engine: push cfs failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Call Go's fast-plan generator to produce a draft plan from the
 * brief + outline + index summary. Returns the generated skeleton —
 * caller is responsible for persisting it as a Plan in Mongo.
 */
async function generateFastPlan(sessionId, { brief, outline, indexSummary }) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/fast-plan`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ brief, outline, indexSummary }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Writing Engine: fast-plan failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Fetch the list of available skills from the writing-engine. Used by
 * Express's GET /api/internal/skills bridge.
 */
async function listSkills() {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/skills`, {
    method: 'GET',
    headers: engineHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Writing Engine: list skills failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Submit the user's clarify answer to the Writing Engine.
 * Called when the user responds to an AskUserTool popup.
 *
 * @param {string} sessionId - Go engine session ID
 * @param {string} answer - User's chosen answer
 * @returns {Promise<{status: string}>}
 */
async function submitClarifyAnswer(sessionId, answer) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/clarify-answer`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: clarify answer failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * Push context files (.md virtual files) to a Writing Engine session.
 * The AI reads these on demand via ReadFile tool.
 *
 * @param {string} sessionId
 * @param {Object<string, string>} files - Map of filename → markdown content
 */
async function pushContextFiles(sessionId, files) {
  if (!files || Object.keys(files).length === 0) return;
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/context-files`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: push context files failed (${res.status})`);
  }
}

/**
 * Submit the user's plan confirmation response.
 *
 * @param {string} sessionId - Go engine session ID
 * @param {Object} response - { action: "confirm"|"retry"|"reject", selectedSteps: string[], mode: "auto"|"step-by-step" }
 */
async function submitPlanConfirm(sessionId, response) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/plan-confirm`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: plan confirm failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * Submit the user's tool confirm response (step-by-step mode).
 *
 * @param {string} sessionId - Go engine session ID
 * @param {string} action - "apply", "skip", or "retry"
 */
async function submitToolConfirm(sessionId, action) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/tool-confirm`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: tool confirm failed (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = {
  createSession,
  pushDocument,
  pushBrief,
  pushBrandVoice,
  pushImageStyle,
  pushMode,
  pushPlan,
  pushCFSConfig,
  generateFastPlan,
  listSkills,
  sendChatMessageStream,
  startAgent,
  generateImage,
  submitClarifyAnswer,
  pushContextFiles,
  submitPlanConfirm,
  submitToolConfirm,
  WRITING_ENGINE_URL,
  engineHeaders,
};
