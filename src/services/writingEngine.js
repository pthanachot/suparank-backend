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
 * Send a chat message to the Writing Engine via WebSocket.
 * Returns the final response with text + document content.
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<{text: string, documentContent: string, edits: Array}>}
 */
async function sendChatMessage(sessionId, prompt, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch {
      reject(new Error('ws package not installed. Run: npm install ws'));
      return;
    }

    const wsUrl = WRITING_ENGINE_URL.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Writing Engine: chat timeout'));
    }, timeoutMs);

    let fullText = '';
    let documentContent = '';
    const edits = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'message',
        sessionId,
        content: prompt,
      }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'text_delta') {
          fullText += event.textDelta || '';
        }
        if (event.type === 'document_diff') {
          documentContent = event.documentContent || '';
          // Extract the edit from the diff if available
          if (event.documentDiff) {
            edits.push(event.documentDiff);
          }
        }
        if (event.type === 'document_update') {
          documentContent = event.documentContent || '';
        }
        if (event.type === 'tool_result' && !event.toolError) {
          // Track tool results for edit extraction
          if (event.toolName === 'EditTool' || event.toolName === 'WriteTool') {
            edits.push({ toolName: event.toolName, result: event.toolResult });
          }
        }
        if (event.type === 'complete') {
          clearTimeout(timeout);
          ws.close();
          resolve({
            text: event.fullText || fullText,
            documentContent,
            edits,
          });
        }
        if (event.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(event.error || 'Writing Engine error'));
        }
      } catch (e) {
        // Ignore parse errors for non-JSON messages
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Writing Engine WebSocket error: ${err.message}`));
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      // If we didn't resolve yet, resolve with what we have
      resolve({ text: fullText, documentContent, edits });
    });
  });
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
