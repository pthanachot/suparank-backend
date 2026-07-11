/**
 * modelPreset.js — maps an org tier to the model preset the Go services apply
 * per request (Phase 4, tier-aware presets).
 *
 * Free tier → "budget" (both engines drop to gemini-flash-lite everywhere) to
 * protect margin on the zero-credit Free bundles. Paid tiers → "" (base models:
 * the engine's Kimi/MiMo/Gemini pipeline, the writing-engine's configured set).
 *
 * Consumed by:
 *  - engine  /analyze + /recommend-outline  → JSON body `preset`
 *  - writing-engine  /api/session/*         → `X-Model-Preset` request header
 */
function tierToPreset(tier) {
  return tier === 'free' ? 'budget' : '';
}

module.exports = { tierToPreset };
