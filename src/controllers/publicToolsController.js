/**
 * Controllers for the free marketing tools (/api/public/tools/*).
 * Reached only through publicToolsGuard — input is pre-validated, cache was
 * missed, budget is available, and the caller's daily allowance is consumed.
 * Every provider call here logs spend to AiCostLedger via ctx.ledgerAction =
 * 'public_tool' (see aiTrackerScanEngine.recordTrackerCost) so the guard's
 * budget kill-switch sees it.
 */
const scanEngine = require('./../services/aiTrackerScanEngine');
const publicToolsService = require('../services/publicToolsService');
const { engineFetch } = require('../services/analysisEngine');
const costLedgerService = require('../services/costLedgerService');

const ENGINE_SEARCH = {
  chatgpt: scanEngine.searchChatGPT,
  gemini: scanEngine.searchGemini,
  perplexity: scanEngine.searchPerplexity,
  claude: scanEngine.searchClaude,
};

const CACHE_TTL_SECONDS = 24 * 3600;

const VISIBILITY_ENGINES = new Set(['chatgpt', 'gemini', 'perplexity', 'claude']);

/** Strict shape check — runs in the guard BEFORE anything is metered. */
function validateVisibilityCheck(req) {
  const b = req.body;
  if (!b || typeof b !== 'object') return 'missing body';
  if (typeof b.engine !== 'string' || !VISIBILITY_ENGINES.has(b.engine)) return 'invalid engine';
  if (typeof b.brand !== 'string' || b.brand.trim().length < 2 || b.brand.trim().length > 80) {
    return 'brand must be 2-80 characters';
  }
  if (b.domain != null && (typeof b.domain !== 'string' || b.domain.length > 120)) {
    return 'invalid domain';
  }
  if (!Array.isArray(b.prompts) || b.prompts.length < 1 || b.prompts.length > 3) {
    return 'prompts must be an array of 1-3 questions';
  }
  for (const p of b.prompts) {
    if (typeof p !== 'string' || p.trim().length < 8 || p.trim().length > 200) {
      return 'each prompt must be 8-200 characters';
    }
  }
  return null;
}

/** Normalized input — doubles as the cache key, so trims/casing collapse. */
function visibilityCacheInput(req) {
  const b = req.body;
  return {
    engine: b.engine,
    brand: b.brand.trim(),
    domain: b.domain ? String(b.domain).trim() : null,
    prompts: b.prompts.map((p) => p.trim()),
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First sentence-ish fragment containing the brand, trimmed for display.
 *  Engine answers embed inline markdown citations ("[domain](url)") per the
 *  scan prompts — strip them so the snippet reads as prose. */
function snippetAround(answer, brand) {
  const clean = answer.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const idx = clean.toLowerCase().indexOf(brand.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, clean.lastIndexOf('.', idx) + 1);
  const end = clean.indexOf('.', idx);
  const raw = clean.slice(start, end === -1 ? idx + 160 : end + 1).trim();
  return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
}

async function checkOnePrompt(engine, prompt, brand, domain, ctx) {
  const search = ENGINE_SEARCH[engine];
  const result = await search(prompt, ctx);
  const answer = result.answer || '';
  const citations = result.citations || [];

  const cleanedDomain = domain ? scanEngine.cleanDomain(domain) : null;
  const matchedCitations = cleanedDomain
    ? citations.filter((url) => scanEngine.urlMatchesDomain(url, cleanedDomain)).slice(0, 3)
    : [];
  const brandRe = new RegExp(`(^|\\W)${escapeRegex(brand)}(\\W|$)`, 'i');
  const mentioned = brandRe.test(answer);

  const status = matchedCitations.length > 0 ? 'cited' : mentioned ? 'mentioned' : 'absent';
  return {
    prompt,
    status,
    matchedCitations,
    totalCitations: citations.length,
    snippet: mentioned ? snippetAround(answer, brand) : null,
  };
}

/**
 * POST /api/public/tools/visibility-check
 * Body: { engine, brand, domain?, prompts: string[1..3], _hp }
 * One engine per check (the free run) — the 4-engine matrix is the product.
 */
async function visibilityCheck(req, res, next) {
  try {
    const { engine, brand, domain, prompts } = req.publicTool.input;
    const ctx = { ledgerAction: 'public_tool', trackerId: 'public-tool', tier: 'public' };

    const settled = await Promise.allSettled(
      prompts.map((p) => checkOnePrompt(engine, p, brand, domain, ctx))
    );
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        console.warn(`[public-tools] ${engine} prompt ${i} failed: ${s.reason?.message || s.reason}`);
      }
    });
    const results = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { prompt: prompts[i], status: 'error', matchedCitations: [], totalCitations: 0, snippet: null }
    );

    if (results.every((r) => r.status === 'error')) {
      // Our failure, not theirs — give the check back (best-effort).
      await publicToolsService.refundRateLimit(req.ip, req.publicTool.toolId).catch(() => {});
      return res.status(502).json({
        error: `${engine} did not answer — try again in a minute.`,
      });
    }

    const payload = {
      engine,
      brand,
      domain: domain || null,
      results,
      checkedAt: new Date().toISOString(),
    };
    // Cache only successful runs; a partial-error run shouldn't stick for 24h.
    if (!results.some((r) => r.status === 'error')) {
      await publicToolsService.setCached(req.publicTool.toolId, req.publicTool.input, payload, CACHE_TTL_SECONDS);
    }
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
}

/* ── Content Brief Generator ─────────────────────────────────────────────── */

const BRIEF_CACHE_TTL_SECONDS = 7 * 24 * 3600; // briefs are highly cacheable
// Flat COGS estimate per brief run (Serper query + budget-preset outline LLM).
// Recorded via costUsdOverride so the tools' budget kill-switch sees it.
const BRIEF_COST_ESTIMATE_USD = 0.02;

/** Strict shape check — runs in the guard BEFORE anything is metered. */
function validateContentBrief(req) {
  const b = req.body;
  if (!b || typeof b !== 'object') return 'missing body';
  const kw = typeof b.keyword === 'string' ? b.keyword.trim() : '';
  if (kw.length < 3 || kw.length > 100) return 'keyword must be 3-100 characters';
  if (/[\n\r]/.test(kw) || /https?:\/\//i.test(kw)) return 'keyword must be a plain search phrase';
  return null;
}

function contentBriefCacheInput(req) {
  return { keyword: req.body.keyword.trim().toLowerCase() };
}

/** Normalize the engine's raw PAA/related-search passthrough for display. */
function normalizeQuestions(paa) {
  if (!Array.isArray(paa)) return [];
  return paa
    .map((q) => (typeof q === 'string' ? q : q?.question || q?.query || ''))
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeRelated(related) {
  if (!Array.isArray(related)) return [];
  return related
    .map((r) => ({
      query: typeof r === 'string' ? r : r?.query || '',
      volume: r?.search_volume ?? r?.volume ?? null,
      difficulty: r?.difficulty ?? null,
    }))
    .filter((r) => r.query)
    .slice(0, 10);
}

/**
 * POST /api/public/tools/content-brief
 * Body: { keyword, _hp }
 * Light pipeline: live SERP discover → LLM outline from the top-10 titles,
 * People-Also-Ask, and related searches. (The full crawled brief — NLP terms,
 * heading structures, word-count bands — is the product.)
 */
async function contentBrief(req, res, next) {
  try {
    const { keyword } = req.publicTool.input;

    // 1. Live SERP discover (candidates + PAA + related searches).
    const discoverRes = await engineFetch('/api/discover', {
      body: { keywords: [keyword] },
      timeoutMs: 90000,
    });
    if (!discoverRes.ok) {
      const detail = await discoverRes.text().catch(() => '');
      console.warn(`[public-tools] content-brief discover failed: ${discoverRes.status} ${detail.slice(0, 200)}`);
      await publicToolsService.refundRateLimit(req.ip, req.publicTool.toolId).catch(() => {});
      return res.status(502).json({ error: 'SERP research is unavailable right now — try again in a minute.' });
    }
    const discover = await discoverRes.json();
    const candidates = Array.isArray(discover.candidates) ? discover.candidates : [];

    // 2. Outline from the top 10 (titles only — no crawl in the free tool).
    const competitorPages = candidates.slice(0, 10).map((c, i) => ({
      url: c.url || '',
      title: c.title || '',
      position: c.position || i + 1,
      h1s: [],
      h2s: [],
      h3s: [],
    }));
    const outlineRes = await engineFetch('/api/recommend-outline', {
      preset: 'budget',
      body: {
        keyword,
        competitor_pages: competitorPages,
        people_also_ask: discover.people_also_ask || [],
        related_searches: discover.related_searches || [],
        structure: [],
        terms: [],
        ai_conversations: [],
      },
      timeoutMs: 60000,
    });
    if (!outlineRes.ok) {
      const detail = await outlineRes.text().catch(() => '');
      console.warn(`[public-tools] content-brief outline failed: ${outlineRes.status} ${detail.slice(0, 200)}`);
      // The discover leg (Serper) already cost money — record it so the daily
      // budget still sees failed runs, even though the visitor is refunded.
      costLedgerService
        .record({
          action: publicToolsService.LEDGER_ACTION,
          model: 'brief-lite-pipeline',
          costUsdOverride: 0.005,
          metadata: { tool: 'content-brief', keyword, failed: 'outline' },
        })
        .catch(() => {});
      await publicToolsService.refundRateLimit(req.ip, req.publicTool.toolId).catch(() => {});
      return res.status(502).json({ error: 'Outline generation is unavailable right now — try again in a minute.' });
    }
    const outline = await outlineRes.json();

    // 3. Record estimated COGS so the daily budget cap sees brief runs.
    costLedgerService
      .record({
        action: publicToolsService.LEDGER_ACTION,
        model: 'brief-lite-pipeline',
        costUsdOverride: BRIEF_COST_ESTIMATE_USD,
        metadata: { tool: 'content-brief', keyword },
      })
      .catch(() => {});

    const payload = {
      keyword,
      outline: {
        h1: outline.h1 || '',
        sections: Array.isArray(outline.sections) ? outline.sections : [],
      },
      questions: normalizeQuestions(discover.people_also_ask),
      relatedSearches: normalizeRelated(discover.related_searches),
      topPages: candidates.slice(0, 10).map((c, i) => ({
        position: c.position || i + 1,
        title: c.title || '',
        url: c.url || '',
      })),
      checkedAt: new Date().toISOString(),
    };
    await publicToolsService.setCached(req.publicTool.toolId, req.publicTool.input, payload, BRIEF_CACHE_TTL_SECONDS);
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
}

/* ── AI Share of Voice Calculator ────────────────────────────────────────── */

const SOV_CACHE_TTL_SECONDS = 24 * 3600;
const SOV_ENGINES = ['chatgpt', 'gemini', 'perplexity', 'claude'];

/** Strict shape check — runs in the guard BEFORE anything is metered. */
function validateShareOfVoice(req) {
  const b = req.body;
  if (!b || typeof b !== 'object') return 'missing body';
  if (typeof b.brand !== 'string' || b.brand.trim().length < 2 || b.brand.trim().length > 80) {
    return 'brand must be 2-80 characters';
  }
  if (b.domain != null && (typeof b.domain !== 'string' || b.domain.length > 120)) {
    return 'invalid domain';
  }
  if (!Array.isArray(b.competitors) || b.competitors.length < 1 || b.competitors.length > 3) {
    return 'competitors must be an array of 1-3 brand names';
  }
  for (const c of b.competitors) {
    if (typeof c !== 'string' || c.trim().length < 2 || c.trim().length > 80) {
      return 'each competitor must be 2-80 characters';
    }
  }
  if (typeof b.prompt !== 'string' || b.prompt.trim().length < 8 || b.prompt.trim().length > 200) {
    return 'prompt must be 8-200 characters';
  }
  // Duplicate brands double-count mentions and silently distort every share.
  const names = [b.brand, ...b.competitors].map((n) => n.trim().toLowerCase());
  if (new Set(names).size !== names.length) {
    return 'brands must be distinct';
  }
  return null;
}

function shareOfVoiceCacheInput(req) {
  const b = req.body;
  return {
    brand: b.brand.trim(),
    domain: b.domain ? String(b.domain).trim() : null,
    competitors: b.competitors.map((c) => c.trim()),
    prompt: b.prompt.trim(),
  };
}

/**
 * Share-of-voice math over the per-engine mention matrix.
 * matrix: [{ engine, ok, brands: [{ brand, mentioned, cited }] }]
 * SoV% = a brand's mentions across responsive engines / all tracked brands'
 * mentions. Engines that errored are excluded from the denominator entirely.
 */
function computeSov(matrix) {
  const okEngines = matrix.filter((m) => m.ok);
  const brandNames = matrix[0] ? matrix[0].brands.map((b) => b.brand) : [];
  const perBrand = brandNames.map((name) => {
    let mentions = 0;
    let citations = 0;
    const perEngine = {};
    for (const m of okEngines) {
      const cell = m.brands.find((b) => b.brand === name);
      const mentioned = !!(cell && cell.mentioned);
      if (mentioned) mentions += 1;
      if (cell && cell.cited) citations += 1;
      perEngine[m.engine] = { mentioned, cited: !!(cell && cell.cited) };
    }
    return { brand: name, mentions, citations, perEngine };
  });
  const totalMentions = perBrand.reduce((s, b) => s + b.mentions, 0);
  for (const b of perBrand) {
    b.sovPct = totalMentions > 0 ? Math.round((b.mentions / totalMentions) * 100) : 0;
  }
  return { perBrand, enginesUsed: okEngines.map((m) => m.engine) };
}

/**
 * POST /api/public/tools/share-of-voice
 * Body: { brand, domain?, competitors: string[1..3], prompt, _hp }
 * One prompt across all four engines; every brand is detected in the SAME
 * answers, so competitors cost nothing extra. Partial results are returned
 * when some engines are down; total failure refunds the check.
 */
async function shareOfVoice(req, res, next) {
  try {
    const { brand, domain, competitors, prompt } = req.publicTool.input;
    const brands = [brand, ...competitors];
    const ctx = { ledgerAction: 'public_tool', trackerId: 'public-tool', tier: 'public' };

    const settled = await Promise.allSettled(
      SOV_ENGINES.map((engine) => ENGINE_SEARCH[engine](prompt, ctx))
    );
    const matrix = settled.map((s, i) => {
      const engine = SOV_ENGINES[i];
      if (s.status === 'rejected') {
        console.warn(`[public-tools] share-of-voice ${engine} failed: ${s.reason?.message || s.reason}`);
        return { engine, ok: false, brands: brands.map((b) => ({ brand: b, mentioned: false, cited: false })) };
      }
      const answer = s.value.answer || '';
      const citations = s.value.citations || [];
      const cleanedDomain = domain ? scanEngine.cleanDomain(domain) : null;
      return {
        engine,
        ok: true,
        brands: brands.map((b, bi) => ({
          brand: b,
          mentioned: new RegExp(`(^|\\W)${escapeRegex(b)}(\\W|$)`, 'i').test(answer),
          // Citation matching only for the user's own brand (bi === 0) — we
          // don't have competitors' domains.
          cited: bi === 0 && !!cleanedDomain && citations.some((url) => scanEngine.urlMatchesDomain(url, cleanedDomain)),
        })),
      };
    });

    if (matrix.every((m) => !m.ok)) {
      await publicToolsService.refundRateLimit(req.ip, req.publicTool.toolId).catch(() => {});
      return res.status(502).json({ error: 'No AI engine answered — try again in a minute.' });
    }

    const sov = computeSov(matrix);
    const payload = {
      brand,
      competitors,
      prompt,
      ...sov,
      enginesUnavailable: matrix.filter((m) => !m.ok).map((m) => m.engine),
      checkedAt: new Date().toISOString(),
    };
    // Cache only full-coverage runs — a partial (engine-down) result
    // shouldn't represent this prompt for 24h.
    if (payload.enginesUnavailable.length === 0) {
      await publicToolsService.setCached(req.publicTool.toolId, req.publicTool.input, payload, SOV_CACHE_TTL_SECONDS);
    }
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  visibilityCheck,
  validateVisibilityCheck,
  visibilityCacheInput,
  contentBrief,
  validateContentBrief,
  contentBriefCacheInput,
  shareOfVoice,
  validateShareOfVoice,
  shareOfVoiceCacheInput,
  // exported for tests
  _snippetAround: snippetAround,
  _normalizeQuestions: normalizeQuestions,
  _normalizeRelated: normalizeRelated,
  _computeSov: computeSov,
};
