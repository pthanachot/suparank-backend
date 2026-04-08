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

const WRITING_ENGINE_URL = process.env.WRITING_ENGINE_URL || 'http://localhost:8080';

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
 * Send a chat message to the Writing Engine via REST.
 * Uses the synchronous POST /api/session/{id}/chat endpoint.
 * Returns the final response with text + document content.
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @returns {Promise<{text: string, documentContent: string}>}
 */
async function sendChatMessage(sessionId, prompt) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(300000), // 5 minute timeout
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine chat failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    text: data.text || '',
    documentContent: data.documentContent || '',
  };
}

/**
 * Start an agent run via SSE streaming.
 * Returns a readable stream of SSE events.
 *
 * @param {string} sessionId
 * @param {string} goal
 * @param {number} [targetScore=75]
 * @param {number} [maxIterations=5]
 * @returns {Promise<Response>} The raw fetch response (SSE stream)
 */
async function startAgent(sessionId, goal, targetScore = 75, maxIterations = 5) {
  const res = await fetch(`${WRITING_ENGINE_URL}/api/session/${sessionId}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, targetScore, maxIterations }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Writing Engine: agent start failed (${res.status}): ${body}`);
  }
  // Return raw response — caller reads the SSE stream
  return res;
}

module.exports = {
  createSession,
  pushDocument,
  pushBrief,
  sendChatMessage,
  startAgent,
  WRITING_ENGINE_URL,
};
