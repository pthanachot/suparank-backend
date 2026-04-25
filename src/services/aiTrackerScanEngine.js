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
  const apiKey = process.env.CHATGPT_SEARCH_KEY;
  if (!apiKey) throw new Error('CHATGPT_SEARCH_KEY not configured');

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
        messages: [{ role: 'user', content: query }],
        web_search_options: {},
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';
    const citations = [];
    const seen = new Set();

    if (data.choices && data.choices.length > 0) {
      const choice = data.choices[0];
      answer = choice.message?.content || '';

      // Extract citations from structured annotations
      const annotations = choice.message?.annotations || [];
      for (const ann of annotations) {
        if (ann.type === 'url_citation' && ann.url_citation?.url && !seen.has(ann.url_citation.url)) {
          seen.add(ann.url_citation.url);
          citations.push(ann.url_citation.url);
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

    console.log(`[chatgpt] query="${query.slice(0, 50)}" answer_len=${answer.length} citations=${citations.length}`);
    return { answer, citations };
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
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
    }

    console.log(`[gemini] query="${query.slice(0, 50)}" answer_len=${answer.length} citations=${citations.length}`);
    return { answer, citations };
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
    const res = await fetch('https://api.perplexity.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
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

    console.log(`[perplexity] query="${query.slice(0, 50)}" answer_len=${answer.length} citations=${citations.length}`);
    return { answer, citations };
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
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20241022',
        max_tokens: 2048,
        messages: [{ role: 'user', content: query }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Claude returned status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    let answer = '';

    // Claude response: content is an array of content blocks
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          answer += block.text;
        }
      }
    }

    console.log(`[claude] query="${query.slice(0, 50)}" answer_len=${answer.length} citations=0 (no web search)`);
    // Claude has no web search — always returns empty citations
    return { answer, citations: [] };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve a Google redirect URL by following the HEAD request.
 * Ported from engine/internal/aisearch/gemini.go:15-31
 */
async function resolveRedirectURL(redirectURL) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(redirectURL, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      });
      return res.headers.get('location') || '';
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
// BRAND & COMPETITOR DETECTION
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
 * Detect if the user's brand/domain appears in an AI response.
 *
 * @param {string} answer - AI response text
 * @param {string[]} citations - URLs cited by the AI
 * @param {string} domain - User's domain (e.g., "suparank.com")
 * @returns {{ mentioned: boolean, tier: string, cited: boolean, citedFrom: string|null }}
 */
function detectBrand(answer, citations, domain) {
  const brand = extractBrand(domain);
  const domainClean = cleanDomain(domain);
  const answerLower = answer.toLowerCase();

  // Check if brand or domain mentioned in answer text
  const mentioned = answerLower.includes(brand) || answerLower.includes(domainClean);

  // Determine tier based on position in answer
  let tier = 'not_mentioned';
  if (mentioned) {
    const positions = [
      answerLower.indexOf(brand),
      answerLower.indexOf(domainClean),
    ].filter((i) => i >= 0);
    const earliest = Math.min(...positions);
    // "top" if mentioned in the first 20% of the answer
    tier = earliest < answer.length * 0.2 ? 'top' : 'mentioned';
  }

  // Check if domain appears in any citation URL
  let cited = false;
  let citedFrom = null;
  for (const url of citations) {
    if (url.toLowerCase().includes(domainClean)) {
      cited = true;
      citedFrom = url;
      break;
    }
  }

  return { mentioned, tier, cited, citedFrom };
}

/**
 * Detect if a competitor is mentioned in an AI response.
 *
 * @param {string} answer - AI response text
 * @param {string[]} citations - URLs cited by the AI
 * @param {string} competitorName - e.g., "Surfer SEO"
 * @returns {{ mentioned: boolean, cited: boolean }}
 */
function detectCompetitorInAnswer(answer, citations, competitorName) {
  const nameLower = competitorName.toLowerCase();
  const answerLower = answer.toLowerCase();
  const mentioned = answerLower.includes(nameLower);
  // Check citations: strip spaces from name for domain-style matching
  const nameSlug = nameLower.replace(/\s+/g, '');
  const cited = citations.some((url) => url.toLowerCase().includes(nameSlug));
  return { mentioned, cited };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCAN FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine which platforms are available based on env vars.
 */
function getAvailablePlatforms() {
  const platformKeyMap = {
    chatgpt: 'CHATGPT_SEARCH_KEY',
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
  const availablePlatforms = getAvailablePlatforms();
  const totalSteps = availablePlatforms.length * prompts.length;
  let completedSteps = 0;

  // Guard: nothing to scan
  if (prompts.length === 0 || availablePlatforms.length === 0) {
    const competitorResults = competitors.map((comp) => ({
      competitorId: comp._id,
      name: comp.name,
      mentions: 0,
      citations: 0,
      visibility: 0,
    }));
    await onProgress(100, PLATFORMS.map((p) => ({ platformId: p.id, status: 'completed' })));
    return { results: [], competitorResults };
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

  // Collect all answers for competitor detection later
  // Key: `${platformId}:${promptId}` → { answer, citations }
  const allAnswers = [];

  // Process each available platform sequentially
  for (let pi = 0; pi < availablePlatforms.length; pi++) {
    const platform = availablePlatforms[pi];

    // Build platform statuses for progress reporting
    const platformStatuses = PLATFORMS.map((p) => {
      const availIdx = availablePlatforms.findIndex((ap) => ap.id === p.id);
      if (availIdx === -1) return { platformId: p.id, status: 'completed' }; // not available, show as done
      if (availIdx < pi) return { platformId: p.id, status: 'completed' };
      if (availIdx === pi) return { platformId: p.id, status: 'scanning' };
      return { platformId: p.id, status: 'queued' };
    });

    // Process each prompt for this platform
    for (const prompt of prompts) {
      let answer = '';
      let citations = [];
      let mentioned = false;
      let tier = 'not_mentioned';
      let cited = false;
      let citedFrom = null;

      try {
        const result = await searchPlatform(platform.id, prompt.prompt);
        answer = result.answer;
        citations = result.citations;

        // Detect brand in this response
        const detection = detectBrand(answer, citations, tracker.domain);
        mentioned = detection.mentioned;
        tier = detection.tier;
        cited = detection.cited;
        citedFrom = detection.citedFrom;

        // Save for competitor analysis
        allAnswers.push({ platformId: platform.id, answer, citations });
      } catch (err) {
        // Log and continue — don't fail the whole scan
        console.error(`[ai-tracker] ${platform.id} failed for "${prompt.prompt.slice(0, 40)}": ${err.message}`);
      }

      // Add platform result to this prompt's results
      const promptResult = promptResultMap.get(prompt._id.toString());
      promptResult.platforms.push({
        platformId: platform.id,
        mentioned,
        tier,
        cited,
        citedFrom,
        aiResponse: answer.slice(0, 500),
      });

      completedSteps++;
      const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 100;
      await onProgress(progress, platformStatuses);
    }
  }

  // Collect all prompt results
  const results = [];
  for (const result of promptResultMap.values()) {
    results.push(result);
  }

  // Generate competitor results from real answer data
  const competitorResults = competitors.map((comp) => {
    if (comp.isOwn) {
      // Own brand: aggregate from scan results (already computed via detectBrand)
      let totalMentions = 0;
      let totalCitations = 0;
      for (const r of results) {
        for (const p of r.platforms) {
          if (p.mentioned) totalMentions++;
          if (p.cited) totalCitations++;
        }
      }
      const totalPossible = results.length * availablePlatforms.length;
      return {
        competitorId: comp._id,
        name: comp.name,
        mentions: totalMentions,
        citations: totalCitations,
        visibility: totalPossible > 0 ? Math.round((totalMentions / totalPossible) * 100) : 0,
      };
    }

    // Other competitors: scan all collected AI answers for their name
    let mentions = 0;
    let citationCount = 0;
    for (const { answer, citations } of allAnswers) {
      const detection = detectCompetitorInAnswer(answer, citations, comp.name);
      if (detection.mentioned) mentions++;
      if (detection.cited) citationCount++;
    }
    const totalPossible = allAnswers.length;
    return {
      competitorId: comp._id,
      name: comp.name,
      mentions,
      citations: citationCount,
      visibility: totalPossible > 0 ? Math.round((mentions / totalPossible) * 100) : 0,
    };
  });

  return { results, competitorResults };
}

module.exports = { runScan, PLATFORMS };
