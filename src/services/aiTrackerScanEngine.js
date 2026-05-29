/**
 * AI Tracker Scan Engine — Real Implementation
 *
 * Queries ChatGPT and Gemini with tracked prompts, then analyzes responses
 * for brand mentions and citations. Ported from Go engine patterns at
 * engine/internal/aisearch/chatgpt.go and gemini.go.
 */

const PLATFORMS = [
  { id: 'chatgpt', name: 'ChatGPT' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'claude', name: 'Claude' },
  { id: 'perplexity', name: 'Perplexity' },
];

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - async function to retry
 * @param {number} maxRetries - max retry attempts (default 2, so 3 total tries)
 */
async function withRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
      console.log(`[ai-tracker] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API CLIENTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Query ChatGPT with gpt-4o-search-preview (web search enabled).
 * Ported from engine/internal/aisearch/chatgpt.go:41-106
 *
 * @param {string} query - The prompt to search
 * @returns {Promise<{ answer: string, citations: string[] }>}
 */
async function searchChatGPT(query) {
  const apiKey = process.env.CHATGPT_API_KEY;
  if (!apiKey) throw new Error('CHATGPT_API_KEY not configured');

  const systemPrompt = 'You MUST search the web for current information before answering. For EVERY claim or fact, cite the source immediately after it using markdown link format: [domain.com](full_url). Example: "Google holds 90% market share [mangools.com](https://mangools.com/blog/search-engines/)." NEVER list sources at the end. NEVER use numbered references like [1] or [2]. Always inline the citation right after the statement it supports. Answer directly and comprehensively. NEVER ask clarifying questions, follow-up questions, or ask what the user means. If the query is ambiguous, interpret it broadly and answer all reasonable interpretations. Do not answer from memory alone.';

  // Try Responses API first (returns real fanout queries), fall back to Chat Completions
  try {
    const result = await _searchChatGPTResponses(query, apiKey, systemPrompt);
    return result;
  } catch (responsesErr) {
    console.warn(`[chatgpt] Responses API failed, falling back to Chat Completions: ${responsesErr.message}`);
    return _searchChatGPTCompletions(query, apiKey, systemPrompt);
  }
}

/** ChatGPT via Responses API — returns real web_search_call fanout queries */
async function _searchChatGPTResponses(query, apiKey, systemPrompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        instructions: systemPrompt,
        input: query,
        tools: [
          {
            type: 'web_search',
            search_context_size: 'medium',
          },
        ],
        store: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI Responses API returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';
    const citations = [];
    const seen = new Set();
    let annotations = [];
    const fanoutQueries = [];

    // Parse output items from Responses API
    for (const item of (data.output || [])) {
      // Extract real search queries from web_search_call items
      if (item.type === 'web_search_call' && item.action?.type === 'search') {
        if (Array.isArray(item.action.queries)) {
          for (const q of item.action.queries) {
            if (q && !fanoutQueries.includes(q)) fanoutQueries.push(q);
          }
        } else if (item.action.query) {
          if (!fanoutQueries.includes(item.action.query)) fanoutQueries.push(item.action.query);
        }
      }

      // Extract answer text and citation annotations from message items
      if (item.type === 'message' && item.role === 'assistant') {
        for (const block of (item.content || [])) {
          if (block.type === 'output_text') {
            answer += block.text || '';
            annotations = block.annotations || [];
            for (const ann of annotations) {
              if (ann.type === 'url_citation' && ann.url && !seen.has(ann.url)) {
                seen.add(ann.url);
                citations.push(ann.url);
              }
            }
          }
        }
      }
    }

    // Fallback: parse markdown links if no structured annotations
    if (citations.length === 0 && answer) {
      const fallback = extractCitationsFromText(answer);
      for (const url of fallback) {
        if (!seen.has(url)) {
          seen.add(url);
          citations.push(url);
        }
      }
    }

    if (!answer || answer.trim().length === 0) {
      throw new Error('ChatGPT Responses API returned empty response');
    }

    console.log(`[chatgpt-responses] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries, annotations };
  } finally {
    clearTimeout(timeout);
  }
}

/** ChatGPT via Chat Completions API — fallback when Responses API fails (no fanout queries) */
async function _searchChatGPTCompletions(query, apiKey, systemPrompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-search-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        web_search_options: { search_context_size: 'medium' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI Chat Completions returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';
    const citations = [];
    const seen = new Set();
    let annotations = [];

    if (data.choices && data.choices.length > 0) {
      const choice = data.choices[0];
      answer = choice.message?.content || '';
      annotations = choice.message?.annotations || [];
      for (const ann of annotations) {
        if (ann.type === 'url_citation' && ann.url_citation?.url && !seen.has(ann.url_citation.url)) {
          seen.add(ann.url_citation.url);
          citations.push(ann.url_citation.url);
        }
      }
    }

    if (citations.length === 0 && answer) {
      const fallback = extractCitationsFromText(answer);
      for (const url of fallback) {
        if (!seen.has(url)) {
          seen.add(url);
          citations.push(url);
        }
      }
    }

    if (!answer || answer.trim().length === 0) {
      throw new Error('ChatGPT Chat Completions returned empty response');
    }

    console.log(`[chatgpt-completions-fallback] query_len=${query.length} answer_len=${answer.length} citations=${citations.length}`);
    return { answer, citations, fanoutQueries: [], annotations };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query Gemini with google_search grounding.
 * Ported from engine/internal/aisearch/gemini.go:59-133
 *
 * @param {string} query - The prompt to search
 * @returns {Promise<{ answer: string, citations: string[] }>}
 */
async function searchGemini(query) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'You MUST search the web thoroughly for current information before answering. Search for MULTIPLE aspects of the question — specific brands, products, comparisons, rankings, and recent developments separately. For EVERY claim or fact, cite the source immediately after it using markdown link format: [domain.com](full_url). Example: "Google holds 90% market share [mangools.com](https://mangools.com/blog/search-engines/)." NEVER list sources at the end. NEVER use numbered references like [1] or [2]. Always inline the citation right after the statement it supports. Answer directly and comprehensively. NEVER ask clarifying questions, follow-up questions, or ask what the user means. If the query is ambiguous, interpret it broadly and answer all reasonable interpretations. Do not answer from memory alone — always search first.\n\n' + query }] }],
        tools: [{ google_search: {} }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';
    const citations = [];
    const seen = new Set();

    let fanoutQueries = [];
    let groundingChunks = [];
    let groundingSupports = [];

    if (data.candidates && data.candidates.length > 0) {
      const candidate = data.candidates[0];

      // Concatenate all text parts
      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) answer += part.text;
        }
      }

      // Extract citations from grounding metadata
      const chunks = candidate.groundingMetadata?.groundingChunks || [];
      groundingChunks = chunks;
      for (const chunk of chunks) {
        let uri = chunk.web?.uri || '';
        if (!uri) continue;

        // Resolve Google redirect URLs
        if (uri.includes('vertexaisearch.cloud.google.com/grounding-api-redirect')) {
          const resolved = await resolveRedirectURL(uri);
          if (resolved) uri = resolved;
        }

        if (!seen.has(uri)) {
          seen.add(uri);
          citations.push(uri);
        }
      }

      // Extract the actual search queries Gemini used (free, already in response)
      fanoutQueries = candidate.groundingMetadata?.webSearchQueries || [];

      // Extract grounding supports for inline citation positioning
      groundingSupports = candidate.groundingMetadata?.groundingSupports || [];
    }

    if (!answer || answer.trim().length === 0) {
      throw new Error('Gemini returned empty response');
    }

    console.log(`[gemini] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries, groundingSupports, groundingChunks };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query Perplexity with sonar model (built-in web search + citations).
 * OpenAI-compatible API with additional `citations` array in response.
 *
 * @param {string} query - The prompt to search
 * @returns {Promise<{ answer: string, citations: string[] }>}
 */
async function searchPerplexity(query) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You MUST search the web for current information before answering. For EVERY claim or fact, cite the source immediately after it using markdown link format: [domain.com](full_url). Example: "Google holds 90% market share [mangools.com](https://mangools.com/blog/search-engines/)." NEVER list sources at the end. NEVER use numbered references like [1] or [2]. Always inline the citation right after the statement it supports. Answer directly and comprehensively. NEVER ask clarifying questions, follow-up questions, or ask what the user means. If the query is ambiguous, interpret it broadly and answer all reasonable interpretations. Do not answer from memory alone.' },
          { role: 'user', content: query },
        ],
        return_related_questions: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Perplexity returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';
    const citations = [];
    const seen = new Set();

    if (data.choices && data.choices.length > 0) {
      answer = data.choices[0].message?.content || '';
    }

    // Perplexity returns citations as a top-level array of URL strings
    if (Array.isArray(data.citations)) {
      for (const url of data.citations) {
        if (url && !seen.has(url)) {
          seen.add(url);
          citations.push(url);
        }
      }
    }

    if (!answer || answer.trim().length === 0) {
      throw new Error('Perplexity returned empty response');
    }

    // Use related_questions as fanout queries — real queries generated by Perplexity
    const fanoutQueries = Array.isArray(data.related_questions) ? data.related_questions.filter(q => typeof q === 'string' && q.trim()) : [];

    console.log(`[perplexity] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query Claude via Anthropic Messages API (plain completion, no web search).
 * Claude cannot search the web — brand detection is text-only, no citations.
 *
 * @param {string} query - The prompt to search
 * @returns {Promise<{ answer: string, citations: string[] }>}
 */
async function searchClaude(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: 'You MUST search the web thoroughly for current information before answering. Perform MULTIPLE web searches covering different aspects of the question — search for specific brands, products, comparisons, rankings, and recent news separately. For EVERY claim or fact, cite the source immediately after it using markdown link format: [domain.com](full_url). Example: "Google holds 90% market share [mangools.com](https://mangools.com/blog/search-engines/)." NEVER list sources at the end. NEVER use numbered references like [1] or [2]. Always inline the citation right after the statement it supports. Answer directly and comprehensively. NEVER ask clarifying questions, follow-up questions, or ask what the user means. If the query is ambiguous, interpret it broadly and answer all reasonable interpretations. Do not answer from memory alone — always search first.',
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Claude returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';
    const citations = [];
    const seen = new Set();

    // Claude web search response: content blocks include text (with citations),
    // server_tool_use (web search calls), and web_search_tool_result
    const fanoutQueries = [];
    const textBlocks = []; // Keep full blocks for citation position embedding
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        // Extract the actual search queries Claude sent to its web search tool
        if (block.type === 'server_tool_use' && block.name === 'web_search' && block.input?.query) {
          fanoutQueries.push(block.input.query);
        }
        // Extract source URLs from web_search_tool_result blocks (fallback citation source)
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const sr of block.content) {
            if (sr.type === 'web_search_result' && sr.url && !seen.has(sr.url)) {
              seen.add(sr.url);
              citations.push(sr.url);
            }
          }
        }
        if (block.type === 'text' && block.text) {
          textBlocks.push(block); // Keep full block including citations array
          answer += block.text;
          // Extract citation URLs from text block citations (web_search_result_location)
          if (Array.isArray(block.citations)) {
            for (const cite of block.citations) {
              if (cite.url && !seen.has(cite.url)) {
                seen.add(cite.url);
                citations.push(cite.url);
              }
            }
          }
        }
      }
    }

    // Fallback: parse markdown links if no structured citations
    if (citations.length === 0 && answer) {
      const fallback = extractCitationsFromText(answer);
      for (const url of fallback) {
        if (!seen.has(url)) {
          seen.add(url);
          citations.push(url);
        }
      }
    }

    if (!answer || answer.trim().length === 0) {
      throw new Error('Claude returned empty response');
    }

    const blockCiteCount = textBlocks.reduce((n, b) => n + (Array.isArray(b.citations) ? b.citations.length : 0), 0);
    console.log(`[claude] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} blockCitations=${blockCiteCount} blocks=${textBlocks.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries, blocks: textBlocks };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a URL is safe to fetch (SSRF prevention).
 * Only allows https:// and blocks private/internal networks.
 */
function isSafeURL(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]'
        || host.startsWith('127.') || host.startsWith('10.')
        || host.startsWith('192.168.') || host.startsWith('169.254.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || host.endsWith('.internal') || host.endsWith('.local')) return false;
    return true;
  } catch { return false; }
}

/**
 * Resolve a Google redirect URL by following the HEAD request.
 * Ported from engine/internal/aisearch/gemini.go:15-31
 */
async function resolveRedirectURL(redirectURL) {
  if (!isSafeURL(redirectURL)) return '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(redirectURL, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = res.headers.get('location') || '';
      if (location && !isSafeURL(location)) return '';
      return location;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return '';
  }
}

/**
 * Fallback citation parser: extract markdown links [text](url) from text.
 * Ported from engine/internal/aisearch/chatgpt.go:193-214
 */
function extractCitationsFromText(text) {
  const urls = [];
  const seen = new Set();
  let remaining = text;
  while (true) {
    const idx = remaining.indexOf('](http');
    if (idx === -1) break;
    const start = idx + 2;
    const end = remaining.indexOf(')', start);
    if (end === -1) break;
    const url = remaining.slice(start, end);
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    remaining = remaining.slice(end + 1);
  }
  return urls;
}

// ═══════════════════════════════════════════════════════════════════════════
// CITATION EMBEDDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract a display-friendly domain from a URL.
 * e.g., "https://www.example.com/page" → "example.com"
 */
function extractDomainFromURL(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    const match = url.match(/https?:\/\/(?:www\.)?([^/]+)/);
    return match ? match[1] : url.slice(0, 30);
  }
}

/**
 * Claude web search: citations are { type: "web_search_result_location", url, title, cited_text, encrypted_index }.
 * There are NO char position indices (end_char_index/start_char_index), and cited_text is from the
 * SOURCE page (not Claude's response), so we append citation links after each text block.
 */
function embedClaudeCitations(answer, citations, blocks) {
  if (!blocks || blocks.length === 0) {
    // No blocks available — append citation URLs at the end if we have them
    if (citations && citations.length > 0) {
      const seen = new Set();
      const links = [];
      for (const url of citations) {
        if (seen.has(url)) continue;
        seen.add(url);
        links.push(`[${extractDomainFromURL(url)}](${url})`);
      }
      if (links.length > 0) {
        return answer.trimEnd() + '\n\nSources: ' + links.join(' ');
      }
    }
    return answer;
  }

  let result = '';
  let anyInserted = false;

  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue;

    let blockText = block.text;
    if (Array.isArray(block.citations) && block.citations.length > 0) {
      // Deduplicate and append citation links after this text block
      const seen = new Set();
      const links = [];
      for (const cite of block.citations) {
        const url = cite.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        links.push(`[${extractDomainFromURL(url)}](${url})`);
      }
      if (links.length > 0) {
        blockText = blockText.trimEnd() + ' ' + links.join(' ');
        anyInserted = true;
      }
    }
    result += blockText;
  }

  // Fallback: if no block-level citations were inserted, append all citation URLs
  if (!anyInserted && citations && citations.length > 0) {
    const seen = new Set();
    const links = [];
    for (const url of citations) {
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(`[${extractDomainFromURL(url)}](${url})`);
    }
    if (links.length > 0) {
      result = (result || answer).trimEnd() + '\n\nSources: ' + links.join(' ');
    }
  }

  console.log(`[claude-citations] blocks=${blocks.length} anyInserted=${anyInserted} citationUrls=${citations?.length || 0}`);
  return result || answer;
}

/**
 * Gemini: use groundingSupports for inline citation positioning.
 * Each support has segment.endIndex and groundingChunkIndices pointing to URLs.
 */
function embedGeminiCitations(answer, citations, groundingSupports, groundingChunks) {
  if (!groundingSupports || groundingSupports.length === 0) return answer;

  // Build chunk index → resolved URL mapping
  const chunkUrls = {};
  if (Array.isArray(groundingChunks)) {
    for (let i = 0; i < groundingChunks.length; i++) {
      const uri = groundingChunks[i].web?.uri;
      if (uri) {
        // Find the resolved URL in citations (redirect URLs were already resolved)
        chunkUrls[i] = citations[i] || uri;
      }
    }
  }

  // Collect insertion points from grounding supports
  const insertions = []; // { pos, links }
  const inserted = new Set();
  for (const support of groundingSupports) {
    const seg = support.segment;
    if (!seg || typeof seg.endIndex !== 'number') continue;
    const indices = support.groundingChunkIndices || [];
    if (indices.length === 0) continue;

    // Collect unique URLs for this support segment
    const links = [];
    for (const idx of indices) {
      const url = chunkUrls[idx];
      if (!url) continue;
      const key = `${url}:${seg.endIndex}`;
      if (inserted.has(key)) continue;
      inserted.add(key);
      const domain = extractDomainFromURL(url);
      links.push(`[${domain}](${url})`);
    }
    if (links.length > 0) {
      insertions.push({ pos: seg.endIndex, link: ' ' + links.join(' ') });
    }
  }

  if (insertions.length === 0) return answer;

  // Sort by position descending and insert
  let result = answer;
  insertions.sort((a, b) => b.pos - a.pos);
  for (const ins of insertions) {
    result = result.slice(0, ins.pos) + ins.link + result.slice(ins.pos);
  }
  return result;
}

/**
 * Embed structured citation metadata inline for platforms that return
 * citations separately from text (Gemini and Claude only).
 */
function embedCitationsInAnswer(answer, citations, platformId, extra = {}) {
  if (!answer || !citations || citations.length === 0) return answer;

  if (platformId === 'claude') {
    return embedClaudeCitations(answer, citations, extra.blocks || []);
  }
  if (platformId === 'gemini') {
    return embedGeminiCitations(answer, citations, extra.groundingSupports || [], extra.groundingChunks || []);
  }
  return answer;
}

/**
 * Truncate text without cutting markdown links in half.
 */
function safeSlice(text, maxLen) {
  if (text.length <= maxLen) return text;
  let sliced = text.slice(0, maxLen);
  const lastOpen = sliced.lastIndexOf('[');
  if (lastOpen > 0) {
    const afterBracket = sliced.slice(lastOpen);
    if (!/\[[^\]]*\]\([^)]*\)/.test(afterBracket)) {
      sliced = sliced.slice(0, lastOpen);
    }
  }
  return sliced;
}

// ═══════════════════════════════════════════════════════════════════════════
// BRAND & ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract brand name from domain.
 * e.g., "suparank.com" → "suparank", "https://www.test.co.uk" → "test"
 */
function extractBrand(domain) {
  return domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('.')[0].toLowerCase();
}

/**
 * Clean domain to bare form for matching.
 * e.g., "https://www.suparank.com" → "suparank.com"
 */
function cleanDomain(domain) {
  return domain.replace(/^(https?:\/\/)?(www\.)?/, '').toLowerCase().replace(/\/$/, '');
}

/**
 * Unified response analysis — single Claude Haiku call that extracts:
 *   - Ordered brand list (with duplicates for mention counting)
 *   - Citation URLs from the text
 *   - Sentiment toward target brand
 *
 * Replaces: detectBrand(), extractBrandRanking(), analyzeSentiment()
 *
 * @param {string} aiResponse - The AI response text (with inline citations)
 * @param {string} query - The original prompt query
 * @param {string} targetBrand - The user's brand name (e.g. "suparank")
 * @param {string} domain - The user's domain (e.g. "suparank.com")
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeResponse(aiResponse, query, targetBrand, domain) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !aiResponse) {
    return _fallbackAnalysis(aiResponse, targetBrand, domain);
  }

  const domainClean = cleanDomain(domain);

  const userPrompt = `Analyze this AI response about "${query}".
Target brand: "${targetBrand}" (domain: ${domain})

AI Response:
"""
${aiResponse.slice(0, 4000)}
"""

Return a JSON object with:
1. "brands": An ordered array of brand/company/product names mentioned in the response, ranked by prominence (most prominent first). Include ONLY brands relevant to the topic. If a brand is mentioned multiple times in different contexts, include it multiple times. Use canonical product names (e.g. "Ahrefs" not "ahrefs.com"). Merge parent company + product into one entry (e.g. "Google" + "Gemini" → "Gemini"). Include the target brand "${targetBrand}" if mentioned.
2. "citationUrls": An array of ALL URLs found in the text (from markdown links like [text](url) or bare URLs). Include each URL every time it appears.
3. "sentiment": If the target brand "${targetBrand}" is mentioned, return {"label":"positive"|"neutral"|"negative","score":0-100} where 100=most positive. If not mentioned, return null.

Return ONLY valid JSON, no other text. Example:
{"brands":["BrandA","BrandB","BrandA"],"citationUrls":["https://example.com"],"sentiment":{"label":"positive","score":85}}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[ai-tracker] analyzeResponse failed: ${res.status}`);
      return _fallbackAnalysis(aiResponse, targetBrand, domain);
    }

    const data = await res.json();
    const rawText = data.content?.[0]?.text?.trim();
    if (!rawText) return _fallbackAnalysis(aiResponse, targetBrand, domain);

    // Parse — strip markdown code fences if present
    let cleaned;
    const fenceMatch = rawText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    } else {
      cleaned = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```[\s\S]*/i, '').trim();
    }
    const parsed = JSON.parse(cleaned);

    // Process brands
    const rawBrands = Array.isArray(parsed.brands) ? parsed.brands.filter(b => typeof b === 'string' && b.trim()) : [];

    // Build deduplicated brand ranking with mention counts (order of first occurrence)
    const brandRanking = [];
    for (const name of rawBrands) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const existing = brandRanking.find(b => isSameBrand(b.brandName, trimmed));
      if (existing) {
        existing.mentionCount++;
        // Prefer longer (more specific) name
        if (trimmed.length > existing.brandName.length) existing.brandName = trimmed;
      } else {
        brandRanking.push({
          brandName: trimmed,
          isTargetBrand: isSameBrand(trimmed, targetBrand) || trimmed.toLowerCase().includes(domainClean),
          mentionCount: 1,
        });
      }
    }

    // Determine if target brand mentioned
    const targetEntry = brandRanking.find(b => b.isTargetBrand);
    const mentioned = !!targetEntry;

    // Compute position (1-10 scale)
    let position = null;
    if (mentioned) {
      const rank = brandRanking.indexOf(targetEntry) + 1; // 1-indexed
      const total = brandRanking.length;
      position = total <= 1 ? 1 : Math.round(1 + (rank - 1) / (total - 1) * 9);
    }

    // Process citation URLs
    const rawCitationUrls = Array.isArray(parsed.citationUrls) ? parsed.citationUrls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
    const seenUrls = new Set();
    const citedUrls = [];
    for (const url of rawCitationUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        citedUrls.push(url);
      }
    }
    const citationCount = citedUrls.length;
    const cited = citedUrls.some(url => url.toLowerCase().includes(domainClean));

    // Process sentiment
    let sentiment = null;
    let sentimentScore = null;
    if (parsed.sentiment && typeof parsed.sentiment === 'object') {
      const validSentiments = ['positive', 'neutral', 'negative'];
      if (validSentiments.includes(parsed.sentiment.label)) {
        sentiment = parsed.sentiment.label;
        sentimentScore = Math.max(0, Math.min(100, Math.round(Number(parsed.sentiment.score) || 50)));
      }
    }

    console.log(`[ai-tracker] analyzeResponse: brands=${brandRanking.length} position=${position} cited=${cited} citations=${citationCount} sentiment=${sentiment}`);

    return { mentioned, position, cited, citedUrls, citationCount, brandRanking, sentiment, sentimentScore };
  } catch (err) {
    console.warn('[ai-tracker] analyzeResponse error:', err?.message || err);
    return _fallbackAnalysis(aiResponse, targetBrand, domain);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback analysis when Claude Haiku is unavailable — uses regex detection.
 */
function _fallbackAnalysis(aiResponse, targetBrand, domain) {
  if (!aiResponse) {
    return { mentioned: false, position: null, cited: false, citedUrls: [], citationCount: 0, brandRanking: [], sentiment: null, sentimentScore: null };
  }

  const domainClean = cleanDomain(domain);
  const brandRegex = new RegExp(`\\b${targetBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const domainRegex = new RegExp(`\\b${domainClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const mentioned = brandRegex.test(aiResponse) || domainRegex.test(aiResponse);

  // Extract URLs from markdown links
  const citedUrls = [];
  const seenUrls = new Set();
  const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = urlRegex.exec(aiResponse)) !== null) {
    if (!seenUrls.has(match[2])) {
      seenUrls.add(match[2]);
      citedUrls.push(match[2]);
    }
  }

  const cited = citedUrls.some(url => url.toLowerCase().includes(domainClean));

  return {
    mentioned,
    position: mentioned ? 5 : null, // default mid-range
    cited,
    citedUrls,
    citationCount: citedUrls.length,
    brandRanking: mentioned ? [{ brandName: targetBrand, isTargetBrand: true, mentionCount: 1 }] : [],
    sentiment: null,
    sentimentScore: null,
  };
}

/**
 * Normalize a brand name to a canonical key for deduplication/matching.
 * No hardcoded brand lists — works for any brand using generic rules:
 *  - Lowercase, trim whitespace
 *  - Strip domain suffixes (.com, .ai, .io, etc.)
 *  - Strip leading "the "
 *  - Collapse spaces and hyphens
 */
function normalizeBrandKey(name) {
  let key = name.toLowerCase().trim();
  // Strip domain suffixes
  key = key.replace(/\.(com|ai|io|org|net|co|app|dev|tools?)$/i, '').trim();
  // Strip leading "the "
  key = key.replace(/^the\s+/i, '').trim();
  // Collapse hyphens and extra spaces to single space
  key = key.replace(/[-\s]+/g, ' ').trim();
  return key;
}

/**
 * Check if two brand names likely refer to the same entity.
 * Uses word-level matching (not substring) to avoid false positives
 * like "Uber" matching "Kubernetes".
 *
 * Matches when:
 *  - Normalized keys are identical ("semrush" = "semrush")
 *  - No-space forms match ("hub spot" = "hubspot")
 *  - One name's words are a subset of the other's words
 *    ("Gemini" ⊂ "Google Gemini", "Claude" ⊂ "Anthropic Claude")
 */
function isSameBrand(nameA, nameB) {
  const a = normalizeBrandKey(nameA);
  const b = normalizeBrandKey(nameB);
  if (a === b) return true;
  // Strip spaces and compare (e.g. "hub spot" vs "hubspot", "sem rush" vs "semrush")
  const aNoSpace = a.replace(/\s/g, '');
  const bNoSpace = b.replace(/\s/g, '');
  if (aNoSpace === bNoSpace) return true;
  // Word-level containment: all words of the shorter name must appear
  // as whole words in the longer name. Prevents "uber" matching "kubernetes".
  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  const [shorter, longer] = aWords.length <= bWords.length ? [aWords, bWords] : [bWords, aWords];
  if (shorter.length >= 1 && shorter.every((w) => longer.includes(w))) return true;
  return false;
}

/**
 * Merge brands that refer to the same entity.
 * Keeps the longest name as the canonical display name (more specific).
 */
function deduplicateBrands(brands) {
  const groups = [];
  for (const brand of brands) {
    const match = groups.find((g) => isSameBrand(g.name, brand.name));
    if (match) {
      match.mentionCount += brand.mentionCount;
      if (brand.name.length > match.name.length) {
        match.name = brand.name;
      }
    } else {
      groups.push({ ...brand });
    }
  }
  return groups;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCAN FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine which platforms are available based on env vars.
 */
function getAvailablePlatforms() {
  const platformKeyMap = {
    chatgpt: 'CHATGPT_API_KEY',
    gemini: 'GEMINI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };
  const available = PLATFORMS.filter((p) => process.env[platformKeyMap[p.id]]);
  if (available.length === 0) {
    console.warn('[ai-tracker] No AI API keys configured. Scan will produce empty results.');
  }
  return available;
}

/**
 * Call the appropriate platform's search function.
 */
async function searchPlatform(platformId, query) {
  if (platformId === 'chatgpt') return searchChatGPT(query);
  if (platformId === 'gemini') return searchGemini(query);
  if (platformId === 'claude') return searchClaude(query);
  if (platformId === 'perplexity') return searchPerplexity(query);
  throw new Error(`Unknown platform: ${platformId}`);
}

/**
 * Run a scan across all available platforms and prompts.
 * Same signature as the mock — controller doesn't change.
 *
 * @param {Object} tracker - AiTracker document (needs .domain)
 * @param {Array} prompts - Array of AiTrackerPrompt documents (needs ._id, .prompt)
 * @param {Array} competitors - Array of AiTrackerCompetitor documents (needs ._id, .name, .isOwn)
 * @param {Function} onProgress - async callback(progressPercent, platformStatuses)
 * @returns {Promise<{ results: Array, competitorResults: Array }>}
 */
async function runScan(tracker, prompts, competitors, onProgress) {
  let availablePlatforms = getAvailablePlatforms();

  // Filter to only the platforms configured on this tracker (defaultModels)
  // If defaultModels is empty (e.g. cleared after downgrade), skip scan entirely
  if (!tracker.defaultModels || tracker.defaultModels.length === 0) {
    await onProgress(100, []);
    return { results: [], competitorResults: [], detectedBrands: [], totalAnswerWords: 0 };
  }
  availablePlatforms = availablePlatforms.filter((p) => tracker.defaultModels.includes(p.id));

  const totalSteps = availablePlatforms.length * prompts.length;
  let completedSteps = 0;

  // Guard: nothing to scan
  if (prompts.length === 0 || availablePlatforms.length === 0) {
    await onProgress(100, availablePlatforms.map((p) => ({ platformId: p.id, status: 'completed' })));
    return { results: [], competitorResults: [], detectedBrands: [], totalAnswerWords: 0 };
  }

  // Initialize per-prompt result buckets
  const promptResultMap = new Map();
  for (const p of prompts) {
    promptResultMap.set(p._id.toString(), {
      promptId: p._id,
      prompt: p.prompt,
      platforms: [],
    });
  }

  const brandName = extractBrand(tracker.domain);
  let totalAnswerWords = 0;

  // Process each available platform sequentially
  for (let pi = 0; pi < availablePlatforms.length; pi++) {
    const platform = availablePlatforms[pi];

    // Build platform statuses for progress reporting
    const platformStatuses = availablePlatforms.map((p, idx) => {
      if (idx < pi) return { platformId: p.id, status: 'completed' };
      if (idx === pi) return { platformId: p.id, status: 'scanning' };
      return { platformId: p.id, status: 'queued' };
    });

    // Process each prompt for this platform
    for (const prompt of prompts) {
      // Skip if this prompt has per-prompt model selection and current platform isn't included
      if (prompt.models && prompt.models.length > 0 && !prompt.models.includes(platform.id)) {
        completedSteps++;
        const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 100;
        await onProgress(progress, platformStatuses);
        continue;
      }

      let platformResult = {
        platformId: platform.id,
        mentioned: false,
        position: null,
        cited: false,
        citationCount: 0,
        citedUrls: [],
        brandRanking: [],
        fanoutQueries: [],
        aiResponse: '',
        sentiment: null,
        sentimentScore: null,
        error: false,
      };

      try {
        // Step 1: Search platform
        const result = await withRetry(() => searchPlatform(platform.id, prompt.prompt));
        let answer = result.answer;
        const fanoutQueries = result.fanoutQueries || [];

        // Step 2: Embed structured citations for Gemini/Claude
        if (platform.id === 'gemini' || platform.id === 'claude') {
          answer = embedCitationsInAnswer(answer, result.citations, platform.id, {
            blocks: result.blocks || [],
            groundingSupports: result.groundingSupports || [],
            groundingChunks: result.groundingChunks || [],
          });
        }

        // Count words from platform search response
        if (answer) {
          totalAnswerWords += answer.trim().split(/\s+/).filter(Boolean).length;
        }

        // Step 3: Unified analysis — single Claude Haiku call
        const analysis = await analyzeResponse(answer, prompt.prompt, brandName, tracker.domain);

        // Count words from extractor response (AI API call #3)
        const extractorWords = [
          ...(analysis.brandRanking || []).map(b => b.brandName),
          ...(analysis.citedUrls || []),
          analysis.sentiment || '',
        ].join(' ').split(/\s+/).filter(Boolean).length;
        totalAnswerWords += Math.max(extractorWords, 10); // minimum 10 words per extraction call

        platformResult = {
          platformId: platform.id,
          mentioned: analysis.mentioned,
          position: analysis.position,
          cited: analysis.cited,
          citationCount: analysis.citationCount,
          citedUrls: analysis.citedUrls,
          brandRanking: analysis.brandRanking,
          fanoutQueries,
          aiResponse: answer,
          sentiment: analysis.sentiment,
          sentimentScore: analysis.sentimentScore,
          error: false,
        };
      } catch (err) {
        console.error(`[ai-tracker] ${platform.id} failed for "${prompt.prompt.slice(0, 40)}": ${err.message}`);
        platformResult.error = true;
      }

      // Add platform result to this prompt's results
      const promptBucket = promptResultMap.get(prompt._id.toString());
      promptBucket.platforms.push(platformResult);

      completedSteps++;
      const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 100;
      await onProgress(progress, platformStatuses);
    }
  }

  // Collect all prompt results
  const results = Array.from(promptResultMap.values());

  // ── Post-scan: Aggregate competitors from per-prompt brand rankings ──

  const ownBrand = brandName;
  let ownMentions = 0;
  let ownCitations = 0;
  const competitorMap = new Map(); // normalized key → { name, mentions, citations, appearances }

  for (const r of results) {
    for (const p of r.platforms) {
      if (p.error) continue;
      if (p.mentioned) ownMentions++;
      if (p.cited) ownCitations++;

      // Aggregate competitor brands from this result's brandRanking
      for (const brand of p.brandRanking) {
        if (brand.isTargetBrand) continue;
        if (isSameBrand(brand.brandName, ownBrand)) continue;

        const key = normalizeBrandKey(brand.brandName);
        const existing = competitorMap.get(key);
        if (existing) {
          existing.mentions += brand.mentionCount;
          existing.appearances++;
          // Prefer longer name
          if (brand.brandName.length > existing.name.length) {
            existing.name = brand.brandName;
          }
        } else {
          competitorMap.set(key, {
            name: brand.brandName,
            mentions: brand.mentionCount,
            appearances: 1,
            citations: 0,
          });
        }
      }

      // Check if any competitor's slug appears in citation URLs
      for (const [key, comp] of competitorMap) {
        const slug = comp.name.toLowerCase().replace(/\s+/g, '');
        if (p.citedUrls.some(url => url.toLowerCase().includes(slug))) {
          comp.citations++;
        }
      }
    }
  }

  // Deduplicate competitors using isSameBrand
  const rawCompetitors = Array.from(competitorMap.values());
  const dedupedCompetitors = deduplicateBrands(rawCompetitors.map(c => ({ name: c.name, mentionCount: c.mentions })));

  // Build competitor results
  const totalResults = results.reduce((sum, r) => sum + r.platforms.filter(p => !p.error).length, 0);
  const ownBrandResult = {
    competitorId: null,
    name: ownBrand,
    isOwn: true,
    mentions: ownMentions,
    citations: ownCitations,
    visibility: totalResults > 0 ? Math.round((ownMentions / totalResults) * 100) : 0,
  };

  const detectedCompetitorResults = dedupedCompetitors
    .filter(b => !isSameBrand(b.name, ownBrand))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, 20)
    .map(brand => {
      // Re-lookup from competitorMap for citations count
      const comp = rawCompetitors.find(c => isSameBrand(c.name, brand.name));
      return {
        competitorId: null,
        name: brand.name,
        isOwn: false,
        mentions: brand.mentionCount,
        citations: comp?.citations || 0,
        visibility: totalResults > 0 ? Math.round(((comp?.appearances || 0) / totalResults) * 100) : 0,
      };
    });

  const competitorResults = [ownBrandResult, ...detectedCompetitorResults];
  const detectedBrands = dedupedCompetitors
    .filter(b => !isSameBrand(b.name, ownBrand))
    .map(b => ({ name: b.name, mentionCount: b.mentionCount }));

  return { results, competitorResults, detectedBrands, totalAnswerWords };
}

module.exports = { runScan, PLATFORMS, normalizeBrandKey, isSameBrand };
