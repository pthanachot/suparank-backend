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
 * Create a new Writing Engine session.
 * @returns {Promise<string>} sessionId
 */
async function createSession() {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
async function pushDocument(sessionId, markdownContent) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: markdownContent }),
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brief),
  });
  if (!res.ok) {
    throw new Error(`Writing Engine: push brief failed (${res.status})`);
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
    headers: { 'Content-Type': 'application/json' },
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
 * @returns {Promise<Response>} The raw fetch response (SSE stream)
 */
async function startAgent(sessionId, goal, targetScore = 75, maxIterations = 5, signal) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, targetScore, maxIterations }),
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, format, style }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: image generation failed (${res.status}): ${body}`);
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: clarify answer failed (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = {
  createSession,
  pushDocument,
  pushBrief,
  sendChatMessageStream,
  startAgent,
  generateImage,
  submitClarifyAnswer,
  WRITING_ENGINE_URL,
};
