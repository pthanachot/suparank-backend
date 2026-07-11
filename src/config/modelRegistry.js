/**
 * Model Registry — the single source of truth for which models the app uses
 * and what they cost. Consumed by costLedgerService to price every LLM call
 * written to the AiCostLedger (Phase 1 of the v4.1 plan).
 *
 * Prices are USD per 1,000,000 tokens (input / output), sourced from public
 * provider/OpenRouter pricing as of 2026-01. THEY MUST BE VERIFIED AND KEPT
 * CURRENT — margin analysis (Phase 14) reads costs straight from this table.
 * When a provider changes a price, update it here and nowhere else.
 *
 * `flat` (USD per call) is used for image models that bill per image rather
 * than per token.
 *
 * Model ids are the exact strings passed to the provider. OpenRouter ids keep
 * their `provider/` prefix; direct-provider ids (used by the AI Tracker) are
 * the bare SKU. Both forms are registered explicitly so lookups are exact;
 * costFor() also falls back to prefix/suffix normalization for resilience.
 *
 * Cross-reference: AI-MODELS.md (full activity→model map),
 * writing-engine/models.json, engine/internal/pipeline/models.go.
 */

// in = input $/Mtok, out = output $/Mtok, flat = $/call (overrides token cost)
const MODELS = {
  // ─── OpenRouter — writing-engine (Go) ────────────────────────────────
  'google/gemini-2.5-flash':        { provider: 'openrouter', in: 0.30,  out: 2.50 },
  'google/gemini-2.5-flash-lite':   { provider: 'openrouter', in: 0.10,  out: 0.40 },
  'google/gemini-2.5-flash-image':  { provider: 'openrouter', in: 0.30,  out: 2.50, flat: 0.039 }, // Nano-Banana, ~$0.039/image
  'google/gemini-2.5-pro':          { provider: 'openrouter', in: 1.25,  out: 10.00 },
  'perplexity/sonar':               { provider: 'openrouter', in: 1.00,  out: 1.00 },
  'anthropic/claude-sonnet-4':          { provider: 'openrouter', in: 3.00,  out: 15.00 },
  'anthropic/claude-sonnet-4:thinking': { provider: 'openrouter', in: 3.00,  out: 15.00 },
  'anthropic/claude-opus-4':            { provider: 'openrouter', in: 15.00, out: 75.00 },
  'anthropic/claude-opus-4:thinking':   { provider: 'openrouter', in: 15.00, out: 75.00 },
  'anthropic/claude-haiku-4':           { provider: 'openrouter', in: 1.00,  out: 5.00 },
  'moonshotai/kimi-k2.6':           { provider: 'openrouter', in: 0.60,  out: 2.50 }, // VERIFY

  // ─── OpenRouter — engine (Go) pipeline ───────────────────────────────
  // Engine's own pricing table lives at engine/internal/openrouter/cost.go;
  // keep these aligned with it (its computed cost arrives as costUsdOverride,
  // so a drift here only affects registry-priced fallbacks, not totals).
  'xiaomi/mimo-v2-flash':           { provider: 'openrouter', in: 0.10,  out: 0.40 }, // deprecated on OpenRouter; kept for historical ledger rows
  'xiaomi/mimo-v2.5':               { provider: 'openrouter', in: 0.10,  out: 0.40 }, // successor to mimo-v2-flash; VERIFY exact pricing
  'google/gemini-3-flash-preview':  { provider: 'openrouter', in: 0.15,  out: 0.60 },
  'anthropic/claude-haiku-4-5':     { provider: 'openrouter', in: 0.80,  out: 4.00 },

  // ─── OpenRouter — audits + tracker analyzer + pipeline brains (Node/Go) ──
  // Kimi K2 (0905) — confirmed as our "K2.5". Powers content audits, the AI-tracker
  // analyzer (Phase 3), and engine steps 1b/6.
  'moonshotai/kimi-k2-0905':        { provider: 'openrouter', in: 0.60,  out: 2.50 },

  // ─── Direct provider APIs — AI Tracker (Node) ────────────────────────
  'gpt-4o-mini':                    { provider: 'openai',     in: 0.15,  out: 0.60 },
  'gpt-4o-mini-search-preview':     { provider: 'openai',     in: 0.15,  out: 0.60 }, // + per-search fee, not modeled
  'gemini-2.5-flash-lite':          { provider: 'google',     in: 0.10,  out: 0.40 },
  'sonar':                          { provider: 'perplexity', in: 1.00,  out: 1.00 }, // + request fee, not modeled
  'claude-haiku-4-5-20251001':      { provider: 'anthropic',  in: 1.00,  out: 5.00 },
};

/**
 * Normalize a model id to a registry key. Tries exact match, then strips a
 * `:thinking`-style suffix, then strips the `provider/` prefix. Returns the
 * matched key or null.
 */
function resolveKey(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  if (MODELS[modelId]) return modelId;

  const noSuffix = modelId.split(':')[0];
  if (MODELS[noSuffix]) return noSuffix;

  // strip provider prefix: 'google/gemini-2.5-flash' → 'gemini-2.5-flash'
  const bare = noSuffix.includes('/') ? noSuffix.slice(noSuffix.indexOf('/') + 1) : noSuffix;
  if (MODELS[bare]) return bare;

  // last resort: match any key whose bare suffix equals this bare id
  for (const key of Object.keys(MODELS)) {
    const keyBare = key.split(':')[0].includes('/')
      ? key.split(':')[0].slice(key.split(':')[0].indexOf('/') + 1)
      : key.split(':')[0];
    if (keyBare === bare) return key;
  }
  return null;
}

/**
 * Compute the USD cost of one LLM call.
 * @param {string} modelId
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @param {{ images?: number }} [opts] - for per-image (flat) models, number of images (default 1 if flat model)
 * @returns {{ costUsd: number, provider: string|null, resolved: string|null, known: boolean }}
 */
function costFor(modelId, tokensIn = 0, tokensOut = 0, opts = {}) {
  const key = resolveKey(modelId);
  if (!key) {
    return { costUsd: 0, provider: null, resolved: null, known: false };
  }
  const m = MODELS[key];
  let costUsd;
  if (m.flat != null && (opts.images != null || (!tokensIn && !tokensOut))) {
    // per-image billing (image models). Default to 1 image when unspecified.
    const images = opts.images != null ? opts.images : 1;
    costUsd = m.flat * images;
  } else {
    costUsd = (tokensIn / 1e6) * (m.in || 0) + (tokensOut / 1e6) * (m.out || 0);
  }
  return { costUsd, provider: m.provider, resolved: key, known: true };
}

module.exports = { MODELS, resolveKey, costFor };
