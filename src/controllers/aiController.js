const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const { blocksToMarkdown, stripHtml } = require('../services/blocksToMarkdown');
const { markdownToBlocks } = require('../services/markdownToBlocks');
const { benchmarkToContentBrief } = require('../services/benchmarkToContentBrief');
const { mapEditsToPatches } = require('../services/mapEditsToPatches');
const writingEngine = require('../services/writingEngine');

/**
 * Shared helper: resolve workspace + content from route params.
 * Same pattern as analysisController.
 */
async function resolveContent(req, res) {
  const { workspaceNumber, contentNumber } = req.params;
  const workspace = await Workspace.findOne({
    workspaceNumber: Number(workspaceNumber),
    userId: req.user.userId,
  });
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  const content = await Content.findByNumber(workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  return content;
}

/**
 * Set up a Writing Engine session with document + brief.
 * Returns { sessionId, markdown } or throws.
 */
async function setupSession(content) {
  // 1. Create session
  const sessionId = await writingEngine.createSession();

  // 2. Convert blocks → markdown and push document
  const markdown = blocksToMarkdown(content.blocks || []);
  if (markdown) {
    await writingEngine.pushDocument(sessionId, markdown);
  }

  // 3. Convert benchmark → brief and push
  const brief = benchmarkToContentBrief(content);
  await writingEngine.pushBrief(sessionId, brief);

  return { sessionId, markdown };
}

// ─────────────────────────────────────────────────────────────
// POST /:workspaceNumber/content/:contentNumber/ai/chat
// SSE streaming chat — streams thinking_delta, text_delta, tool events,
// and final draft/patch events so the UI can show live progress.
// ─────────────────────────────────────────────────────────────
const chat = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // Set up Writing Engine session
    const { sessionId } = await setupSession(content);

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

    // Track document state for patch generation — same pattern as agent.
    let currentBlocks = JSON.parse(JSON.stringify(content.blocks || []));
    let lastMarkdown = blocksToMarkdown(currentBlocks);

    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;

    const processEvents = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            console.log(`[chat-sse] stream complete after ${eventCount} events`);
            res.write('data: [DONE]\n\n');
            return;
          }

          try {
            const event = JSON.parse(data);
            eventCount++;

            // Reuse the same transform as the agent path so the frontend
            // sees identical event shapes (draft / patch / text_delta / etc.).
            const transformed = transformAgentEvent(event, currentBlocks, lastMarkdown);

            if (transformed) {
              if (transformed._newBlocks) {
                currentBlocks = transformed._newBlocks;
                lastMarkdown = blocksToMarkdown(currentBlocks);
                delete transformed._newBlocks;
              }
              if (transformed._newMarkdown) {
                lastMarkdown = transformed._newMarkdown;
                delete transformed._newMarkdown;
              }
              res.write(`data: ${JSON.stringify(transformed)}\n\n`);
            }
          } catch (transformErr) {
            console.error('[chat-sse] transform error:', transformErr.message);
            res.write(`data: ${data}\n\n`);
          }
        }
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
      } else {
        throw streamErr;
      }
    }
    if (!clientDisconnected) res.end();
  } catch (err) {
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
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { goal, targetScore, maxIterations } = req.body;
    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ error: 'goal is required' });
    }

    // Set up Writing Engine session
    const { sessionId } = await setupSession(content);

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
    const agentRes = await writingEngine.startAgent(
      sessionId, goal, targetScore || 75, maxIterations || 5, abortCtrl.signal
    );

    // Set up SSE headers for the client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track document state for patch generation
    let currentBlocks = JSON.parse(JSON.stringify(content.blocks || []));
    let lastMarkdown = blocksToMarkdown(currentBlocks);

    // Read the SSE stream from Writing Engine and transform events
    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;

    const processEvents = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            console.log(`[agent-sse] stream complete after ${eventCount} events`);
            res.write('data: [DONE]\n\n');
            return;
          }

          try {
            const event = JSON.parse(data);
            eventCount++;
            console.log(`[agent-sse] #${eventCount} type=${event.type}${event.toolName ? ' tool=' + event.toolName : ''}${event.toolError ? ' ERROR' : ''}${event.documentContent ? ' docLen=' + event.documentContent.length : ''}`);

            const transformed = transformAgentEvent(event, currentBlocks, lastMarkdown);

            if (transformed) {
              // Update tracking state if document changed
              if (transformed._newBlocks) {
                console.log(`[agent-sse] → ${transformed.type} with ${transformed._newBlocks.length} blocks`);
                currentBlocks = transformed._newBlocks;
                lastMarkdown = blocksToMarkdown(currentBlocks);
                delete transformed._newBlocks;
              }
              if (transformed._newMarkdown) {
                lastMarkdown = transformed._newMarkdown;
                delete transformed._newMarkdown;
              }

              res.write(`data: ${JSON.stringify(transformed)}\n\n`);
            }
          } catch (transformErr) {
            console.error(`[agent-sse] transform error:`, transformErr.message);
            // Forward unparseable events as-is
            res.write(`data: ${data}\n\n`);
          }
        }
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
      } else {
        throw streamErr;
      }
    }
    if (!clientDisconnected) res.end();
  } catch (err) {
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
        // Apply patches to currentBlocks for tracking
        const updatedBlocks = [...currentBlocks];
        for (const p of patches) {
          const idx = updatedBlocks.findIndex((b) => b.id === p.blockId);
          if (idx !== -1) updatedBlocks[idx] = { ...updatedBlocks[idx], text: p.text };
        }
        return {
          type: 'patch',
          patches,
          _newBlocks: updatedBlocks,
          _newMarkdown: newMarkdown,
        };
      }

      // Fallback: full block replacement if structure changed (new sections added/removed)
      return {
        type: 'draft',
        blocks: newBlocks,
        _newBlocks: newBlocks,
        _newMarkdown: newMarkdown,
      };
    }

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
  // Build signatures: type + first 100 chars of plain text
  const oldSigs = oldBlocks.map((b) => b.type + ':' + stripHtml(b.text || '').slice(0, 100).trim());
  const newSigs = newBlocks.map((b) => b.type + ':' + stripHtml(b.text || '').slice(0, 100).trim());

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
      const oldPlain = stripHtml(oldBlocks[i].text || '').trim();
      const newPlain = stripHtml(newBlocks[i].text || '').trim();

      if (oldPlain === newPlain) {
        matched++;
      } else {
        patches.push({
          op: 'replace',
          blockId: oldBlocks[i].id,
          text: newBlocks[i].text,
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
  // Find blocks in old that have exact matches in new (by type + text)
  const newPlains = newBlocks.map((b) => b.type + ':' + stripHtml(b.text || '').trim());
  for (let i = 0; i < oldBlocks.length; i++) {
    const sig = oldBlocks[i].type + ':' + stripHtml(oldBlocks[i].text || '').trim();
    if (newPlains.includes(sig)) {
      matched++;
    }
  }

  // If most old blocks survived, we can produce targeted patches for the ones that changed
  if (matched >= oldBlocks.length * 0.7) {
    // Match each old block to the closest new block with same type
    for (let i = 0; i < oldBlocks.length; i++) {
      const oldPlain = stripHtml(oldBlocks[i].text || '').trim();
      const oldType = oldBlocks[i].type;

      // Find the new block with same type and closest text
      let bestMatch = -1;
      for (let j = 0; j < newBlocks.length; j++) {
        if (newBlocks[j].type === oldType) {
          const newPlain = stripHtml(newBlocks[j].text || '').trim();
          if (newPlain === oldPlain) {
            bestMatch = j;
            break;
          }
        }
      }

      if (bestMatch === -1) {
        // Old block was modified — find the closest new block by type at similar position
        for (let j = Math.max(0, i - 2); j < Math.min(newBlocks.length, i + 3); j++) {
          if (newBlocks[j].type === oldType) {
            const newPlain = stripHtml(newBlocks[j].text || '').trim();
            if (newPlain !== oldPlain) {
              patches.push({
                op: 'replace',
                blockId: oldBlocks[i].id,
                text: newBlocks[j].text,
              });
              break;
            }
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

    return res.json(result);
  } catch (err) {
    console.error('Image generation error:', err);
    return res.status(500).json({ error: err.message || 'Image generation failed' });
  }
};

module.exports = { chat, agent, generateImage };
