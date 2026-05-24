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
        model: 'gpt-5-search-api',
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

    if (!answer || answer.trim().length === 0) {
      throw new Error('ChatGPT returned empty response');
    }

    // ChatGPT doesn't expose internal search queries — ask it explicitly
    const fanoutQueries = await generateSubQueries(
      query,
      'https://api.openai.com/v1/chat/completions',
      apiKey,
      'gpt-4o-mini',
    );

    console.log(`[chatgpt] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries };
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

    let fanoutQueries = [];

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

      // Extract the actual search queries Gemini used (free, already in response)
      fanoutQueries = candidate.groundingMetadata?.webSearchQueries || [];
    }

    if (!answer || answer.trim().length === 0) {
      throw new Error('Gemini returned empty response');
    }

    console.log(`[gemini] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries };
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

    if (!answer || answer.trim().length === 0) {
      throw new Error('Perplexity returned empty response');
    }

    // Perplexity doesn't expose internal search queries — ask it explicitly
    const fanoutQueries = await generateSubQueries(
      query,
      'https://api.perplexity.ai/chat/completions',
      apiKey,
      'sonar',
    );

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
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
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
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        // Extract the actual search queries Claude sent to its web search tool
        if (block.type === 'server_tool_use' && block.name === 'web_search' && block.input?.query) {
          fanoutQueries.push(block.input.query);
        }
        if (block.type === 'text' && block.text) {
          answer += block.text;
          // Extract citation URLs from inline citations
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

    console.log(`[claude] query_len=${query.length} answer_len=${answer.length} citations=${citations.length} fanout=${fanoutQueries.length}`);
    return { answer, citations, fanoutQueries };
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
 * Analyze sentiment of brand mention in an AI response using gpt-4o-mini.
 * Returns { sentiment, sentimentScore } or null if analysis fails.
 */
async function analyzeSentiment(aiResponse, brandName) {
  if (!aiResponse || !brandName) return null;

  const prompt = `You analyze brand sentiment in AI responses. Respond ONLY with valid JSON: {"sentiment":"positive"|"neutral"|"negative","score":0-100} where 100=most positive. No other text.\n\nBrand: "${brandName}"\nAI Response (excerpt):\n${aiResponse.slice(0, 1000)}`;

  // Try Claude first (reliable), fall back to OpenAI
  const claudeResult = await _sentimentViaClaude(prompt);
  if (claudeResult) return claudeResult;

  const openaiResult = await _sentimentViaOpenAI(prompt);
  return openaiResult;
}

async function _sentimentViaOpenAI(prompt) {
  const apiKey = process.env.CHATGPT_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Respond ONLY with valid JSON. No other text.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 30,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[ai-tracker] OpenAI sentiment failed: ${res.status} ${res.statusText}`, body.slice(0, 200));
        return null;
      }
      const data = await res.json();
      return _parseSentimentResponse(data.choices?.[0]?.message?.content?.trim());
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn('[ai-tracker] OpenAI sentiment error:', err?.message || err);
    return null;
  }
}

async function _sentimentViaClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[ai-tracker] Claude sentiment skipped: no ANTHROPIC_API_KEY');
    return null;
  }

  try {
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
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 60,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[ai-tracker] Claude sentiment failed: ${res.status} ${res.statusText}`, body.slice(0, 200));
        return null;
      }
      const data = await res.json();
      const rawText = data.content?.[0]?.text?.trim();
      console.log('[ai-tracker] Claude sentiment raw response:', rawText);
      return _parseSentimentResponse(rawText);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn('[ai-tracker] Claude sentiment error:', err?.message || err);
    return null;
  }
}

function _parseSentimentResponse(content) {
  if (!content) return null;
  try {
    // Strip markdown code fences (e.g. ```json ... ```) that Claude may wrap around responses
    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const validSentiments = ['positive', 'neutral', 'negative'];
    if (!validSentiments.includes(parsed.sentiment)) return null;
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 50)));
    return { sentiment: parsed.sentiment, sentimentScore: score };
  } catch {
    return null;
  }
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
 * Works for any brand — no hardcoded alias table needed.
 */
function deduplicateBrands(brands) {
  const groups = []; // Array of { name, mentionCount }
  for (const brand of brands) {
    // Find an existing group this brand belongs to
    const match = groups.find((g) => isSameBrand(g.name, brand.name));
    if (match) {
      match.mentionCount += brand.mentionCount;
      // Prefer the longer (more specific) name as display name
      if (brand.name.length > match.name.length) {
        match.name = brand.name;
      }
    } else {
      groups.push({ ...brand });
    }
  }
  return groups;
}

/**
 * Extract brand/company names mentioned across all AI responses.
 * Uses Claude Haiku to identify brands, excluding the user's own brand
 * and already-tracked competitors.
 *
 * @param {Array<{platformId: string, answer: string}>} allAnswers
 * @param {string} ownBrand - The user's brand name (extracted from domain)
 * @returns {Promise<Array<{name: string, mentionCount: number}>>}
 */
async function extractBrandsFromResponses(allAnswers, ownBrand, domain) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[ai-tracker] brand extraction skipped: no ANTHROPIC_API_KEY');
    return [];
  }

  // Build a combined text from all answers (cap at ~8000 chars to stay within token limits)
  const combinedParts = [];
  let totalLen = 0;
  for (const { answer } of allAnswers) {
    if (!answer) continue;
    const chunk = answer.slice(0, 1500);
    if (totalLen + chunk.length > 8000) break;
    combinedParts.push(chunk);
    totalLen += chunk.length;
  }

  if (combinedParts.length === 0) return [];

  const userPrompt = `You are a brand-name extraction expert. The user's website is ${domain || ownBrand}. Extract all competitor brands mentioned in the following AI responses.

RULES:
1. Use the official, canonical PRODUCT name (e.g. "Ahrefs" not "ahrefs.com", "SEMrush" not "Semrush tool", "HubSpot" not "Hubspot").
2. CRITICAL — each company = ONE entry. Merge the parent company, its products, AND product versions into a single entry. Use the most recognizable product name. For example:
   - "OpenAI" + "ChatGPT" + "GPT-4" + "GPT-4o" → output only "ChatGPT"
   - "Google" + "Gemini" + "Gemini Pro" + "Gemini 1.5" → output only "Gemini"
   - "Anthropic" + "Claude" + "Claude 3.5" → output only "Claude"
   - "Microsoft" + "Copilot" + "Azure OpenAI" → output only "Copilot"
   - "Meta" + "Llama" + "Llama 3" → output only "Llama"
   This applies to ALL companies, not just these examples. Never list a parent company, its product, or version variants as separate entries.
3. Also merge spelling/casing variations into one entry (e.g. "ChatGPT" and "chat gpt" → "ChatGPT").
4. Only include real businesses, products, or services — not generic terms (e.g. skip "SEO", "machine learning", "content marketing").
5. Exclude the user's own brand: ${ownBrand} (and any product made by ${ownBrand}).
6. Count each distinct AI response that mentions the brand (not word occurrences within one response). If a company and its product both appear in one response, that still counts as 1.
7. Only include brands that are relevant competitors or alternatives in the same industry as ${domain || ownBrand}. Skip brands mentioned in passing that operate in a completely different field.

Return ONLY a JSON array of objects with "name" (string, canonical product name) and "count" (number of responses mentioning it). Example: [{"name":"Ahrefs","count":3},{"name":"Moz","count":1}]

If no brands are found, return an empty array: []

AI Responses:
${combinedParts.join('\n---\n')}`;

  try {
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
        const body = await res.text().catch(() => '');
        console.warn(`[ai-tracker] brand extraction failed: ${res.status} ${res.statusText}`, body.slice(0, 200));
        return [];
      }

      const data = await res.json();
      const rawText = data.content?.[0]?.text?.trim();
      console.log('[ai-tracker] brand extraction raw:', rawText?.slice(0, 200));

      if (!rawText) return [];

      // Parse — strip code fences if present
      const cleaned = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) return [];

      // Deduplicate and filter out excluded names
      const brandMap = new Map();
      for (const item of parsed) {
        if (!item.name || typeof item.name !== 'string') continue;
        const name = item.name.trim();
        if (!name || name.length > 100) continue;
        if (isSameBrand(name, ownBrand)) continue;
        const count = Math.max(1, Math.round(Number(item.count) || 1));
        const existing = brandMap.get(name.toLowerCase());
        if (existing) {
          existing.mentionCount += count;
        } else {
          brandMap.set(name.toLowerCase(), { name, mentionCount: count });
        }
      }

      // Deduplicate aliases (e.g. "GPT" + "ChatGPT" → "ChatGPT"), then sort and cap
      const deduplicated = deduplicateBrands(Array.from(brandMap.values()));
      // Re-check after dedup: merged brands may now match ownBrand (e.g. "Google Gemini" + "Google" → "Google Gemini")
      const brands = deduplicated
        .filter((b) => !isSameBrand(b.name, ownBrand))
        .sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, 20);

      console.log(`[ai-tracker] brand extraction found ${brands.length} brands (after dedup)`);
      return brands;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn('[ai-tracker] brand extraction error:', err?.message || err);
    return [];
  }
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

  // Check if brand or domain mentioned in answer text (word boundary to avoid false positives)
  const brandRegex = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const domainRegex = new RegExp(`\\b${domainClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const mentioned = brandRegex.test(answer) || domainRegex.test(answer);

  // Determine tier based on position in answer
  let tier = 'not_mentioned';
  if (mentioned) {
    const brandMatch = answer.search(brandRegex);
    const domainMatch = answer.search(domainRegex);
    const positions = [brandMatch, domainMatch].filter((i) => i >= 0);
    const earliest = Math.min(...positions);
    // "top" if mentioned in the first 20% of the answer
    tier = earliest < answer.length * 0.2 ? 'top' : 'mentioned';
  }

  // Check if domain appears in any citation URL
  let cited = false;
  let citedFrom = null;
  for (const url of citations) {
    if (typeof url === 'string' && url.length <= 2048 && url.toLowerCase().includes(domainClean)) {
      cited = true;
      citedFrom = url;
      break;
    }
  }

  // Normalized position: 0 = mentioned at very start, 1 = at the end, null = not mentioned
  const normalizedPosition = mentioned && answer.length > 0
    ? (() => {
        const brandMatch = answer.search(brandRegex);
        const domainMatch = answer.search(domainRegex);
        const positions = [brandMatch, domainMatch].filter((i) => i >= 0);
        return Math.min(...positions) / answer.length;
      })()
    : null;

  return { mentioned, tier, cited, citedFrom, normalizedPosition };
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
  // S75: Use word-boundary regex (consistent with detectBrand)
  const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentioned = new RegExp(`\\b${escaped}\\b`, 'i').test(answerLower);
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
 * Ask a platform to generate search sub-queries for a given prompt.
 * Used for ChatGPT and Perplexity which don't expose their internal queries.
 * Returns [] on any error — never throws.
 *
 * @param {string} query - The main prompt
 * @param {string} endpoint - API endpoint URL
 * @param {string} apiKey - API key
 * @param {string} model - Model ID to use
 * @returns {Promise<string[]>}
 */
async function generateSubQueries(query, endpoint, apiKey, model) {
  if (!apiKey) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `For this question: "${query}"\n\nList up to 5 specific search queries you would use internally to research this comprehensively.\n\nRespond ONLY with a valid JSON array of strings. No extra text. Example: ["query one","query two","query three"]`,
        }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content || '').trim();
    // Extract JSON array even if model adds surrounding text
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q) => typeof q === 'string' && q.trim()).slice(0, 5);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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

  // Collect all answers for competitor detection later
  // Key: `${platformId}:${promptId}` → { answer, citations }
  const allAnswers = [];
  let totalAnswerWords = 0;

  // Process each available platform sequentially
  for (let pi = 0; pi < availablePlatforms.length; pi++) {
    const platform = availablePlatforms[pi];

    // Build platform statuses for progress reporting (only selected platforms)
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

      let answer = '';
      let citations = [];
      let fanoutQueries = [];
      let mentioned = false;
      let tier = 'not_mentioned';
      let cited = false;
      let citedFrom = null;
      let normalizedPosition = null;
      let error = false;

      try {
        const result = await withRetry(() => searchPlatform(platform.id, prompt.prompt));
        answer = result.answer;
        citations = result.citations;
        fanoutQueries = result.fanoutQueries || [];

        // Detect brand in this response
        const detection = detectBrand(answer, citations, tracker.domain);
        mentioned = detection.mentioned;
        tier = detection.tier;
        cited = detection.cited;
        citedFrom = detection.citedFrom;
        normalizedPosition = detection.normalizedPosition;

        // Count words from full answer (before truncation)
        if (answer) {
          totalAnswerWords += answer.trim().split(/\s+/).filter(Boolean).length;
        }

        // Save for competitor analysis
        allAnswers.push({ platformId: platform.id, answer, citations });
      } catch (err) {
        // Log and continue — don't fail the whole scan
        console.error(`[ai-tracker] ${platform.id} failed for "${prompt.prompt.slice(0, 40)}": ${err.message}`);
        error = true;
      }

      // Sentiment analysis — only for mentioned, non-errored results with an answer
      let sentiment = null;
      let sentimentScore = null;
      if (mentioned && !error && answer) {
        const brandName = extractBrand(tracker.domain);
        console.log(`[ai-tracker] sentiment: calling for brand="${brandName}", platform=${platform.id}, answerLen=${answer.length}`);
        const sentimentResult = await analyzeSentiment(answer, brandName);
        console.log(`[ai-tracker] sentiment result:`, sentimentResult);
        if (sentimentResult) {
          sentiment = sentimentResult.sentiment;
          sentimentScore = sentimentResult.sentimentScore;
        }
      }

      // Add platform result to this prompt's results
      const promptResult = promptResultMap.get(prompt._id.toString());
      promptResult.platforms.push({
        platformId: platform.id,
        mentioned,
        tier,
        cited,
        citedFrom,
        normalizedPosition,
        fanoutQueries,
        aiResponse: answer.slice(0, 2000),
        sentiment,
        sentimentScore,
        error,
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

  // Own brand: aggregate from scan results (already computed via detectBrand)
  let ownMentions = 0;
  let ownCitations = 0;
  for (const r of results) {
    for (const p of r.platforms) {
      if (p.mentioned) ownMentions++;
      if (p.cited) ownCitations++;
    }
  }
  const ownTotalPossible = results.length * availablePlatforms.length;
  const ownBrand = extractBrand(tracker.domain);

  const ownBrandResult = {
    competitorId: null,
    name: ownBrand,
    isOwn: true,
    mentions: ownMentions,
    citations: ownCitations,
    visibility: ownTotalPossible > 0 ? Math.round((ownMentions / ownTotalPossible) * 100) : 0,
  };

  // Auto-detect competitor brands mentioned in AI responses
  const detectedBrands = await extractBrandsFromResponses(allAnswers, ownBrand, tracker.domain);

  // For each detected brand, compute full visibility/mentions/citations stats
  // Defense-in-depth: filter out any brand that matches ownBrand (e.g. "Google Search" when monitoring google.com)
  const filteredBrands = detectedBrands.filter((brand) => !isSameBrand(brand.name, ownBrand));
  const detectedCompetitorResults = filteredBrands.map((brand) => {
    let mentions = 0;
    let citationCount = 0;
    for (const { answer, citations } of allAnswers) {
      const detection = detectCompetitorInAnswer(answer, citations, brand.name);
      if (detection.mentioned) mentions++;
      if (detection.cited) citationCount++;
    }
    const totalPossible = allAnswers.length;
    return {
      competitorId: null,
      name: brand.name,
      isOwn: false,
      mentions,
      citations: citationCount,
      visibility: totalPossible > 0 ? Math.round((mentions / totalPossible) * 100) : 0,
    };
  });

  // Combine own brand + auto-detected competitors
  const competitorResults = [ownBrandResult, ...detectedCompetitorResults];

  return { results, competitorResults, detectedBrands, totalAnswerWords };
}

module.exports = { runScan, PLATFORMS, normalizeBrandKey, isSameBrand };
