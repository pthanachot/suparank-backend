/**
 * Credit accounting rules — v4.1 (carried over from v3 per Phase 0, unchanged).
 *
 * Central, declarative home for the "how" of credit accounting. The "what each
 * action costs" lives in creditCosts.js; this file owns deduction order,
 * charge/refund policy, the zero-credit list, Free Option-B handling, and the
 * three markup classes. `resolveCredits(action, ctx)` is the ONE function
 * callers use to turn an action + context into a credit amount.
 */

const { CREDIT_COSTS } = require('./creditCosts');

// ─── Deduction & refund order ────────────────────────────────
// Mirrors creditService.preDeduct (spend) and settle/refund (reverse). Encoded
// here so tests can pin the invariant and it's documented in one place.
const DEDUCTION_ORDER = ['subscription', 'general', 'user_free']; // spend cheapest-to-expire first
const REFUND_ORDER = ['user_free', 'general', 'subscription'];     // reverse — return personal credits first

// ─── Charge / refund policy (estimate → settle → refund) ─────
// Pre-flight reserves an ESTIMATE; settle reconciles to the ACTUAL cost.
//  - actual < estimate → refund the overestimate to source pools.
//  - actual > estimate → charge is CAPPED at the estimate (never retro-charge).
const CHARGE_POLICY = Object.freeze({
  refundOverestimate: true,
  chargeCap: 'estimate', // the pre-flight estimate is the hard ceiling on spend
});

// ─── Zero-credit list (declarative, decision #3) ─────────────
// Actions/variants that NEVER deduct, even for paid tiers. A caller signals one
// of these via ctx.zeroCredit = true (or the dedicated variant key). The v4.1
// addition to the v3 list is stock-image search.
const ZERO_CREDIT_VARIANTS = Object.freeze([
  'stockImageSearch',        // Pexels / Openverse image search (vs AI imageGenerate = 10)
  'trackerScanInAllowance',  // scheduled tracker scans within the tier's included prompt allowance
  'viewResults',             // reading dashboards / results / history
]);

// ─── Free tier — Option B ────────────────────────────────────
// Free has TWO separate meters:
//  1. Fixed zero-credit bundles (count-gated by tier lifetime limits): article,
//     audit, keyword lookup, tracker check — deduct 0, never touch the ledger.
//  2. A one-time 200-credit sample pool (the user_free pool) that funds any
//     credit-metered à-la-carte action NOT in the fixed bundle. When exhausted,
//     those actions 402 → upgrade prompt. Nothing renews.
// The sample pool is SEEDED in Phase 7 (orgBootstrapService); this constant is
// the documented default only.
const FREE_SAMPLE_POOL_CREDITS = 200;

// ─── Three markup classes (top-up / pack pricing) ────────────
// Cost-basis classes carried over from v3. Each active action is tagged with one
// in creditCosts.js. These describe WHY an action's credit cost sits where it
// does; the authoritative pack $ / credit lives in creditPacks.js (Phase 7).
const MARKUP_CLASSES = Object.freeze({
  platform_ai: {
    label: 'Platform AI',
    basis: 'SupaRank-run model inference (article, chat, audit, image, voice…).',
    note: 'Full SaaS markup over wholesale token COGS — the platform-margin stream.',
  },
  licensed_data: {
    label: 'Licensed data',
    basis: 'Third-party licensed data resold per row (keyword lookups — DataForSEO/Serper).',
    note: 'Thin markup — closer to pass-through of the licensed-data unit cost.',
  },
  infra: {
    label: 'Infrastructure',
    basis: 'Scraping / fetch / crawl infra (import-from-URL via Scrappey; platform crawl).',
    note: 'Infra markup over per-request infra cost.',
  },
});

// ─── resolveCredits ──────────────────────────────────────────
/**
 * Resolve the credit cost of an action given runtime context. This is the ONLY
 * place Option B, variable costs, per-unit caps, and the zero-credit list are
 * applied — the gate and settle paths both call it so the estimate and the
 * actual always agree in shape.
 *
 * @param {string} action  key in creditCosts.CREDIT_COSTS
 * @param {object} [ctx]
 *   @param {string}  [ctx.tier]          org tier ('free' triggers Option B)
 *   @param {boolean} [ctx.zeroCredit]    caller-signalled zero-credit variant (stock image, in-allowance scan)
 *   @param {number}  [ctx.tokens]        for variable costs (aiChatMessage)
 *   @param {number}  [ctx.rows]          for perRow actions (keywordLookup)
 *   @param {number}  [ctx.activePrompts] for perActivePrompt actions (trackerRefreshAll)
 *   @param {number}  [ctx.count]         generic fallback unit count
 * @returns {number} credits to deduct (>= 0)
 */
function toFiniteUnits(n) {
  // Coerce a runtime count to a safe non-negative finite number. A non-numeric
  // or NaN count must NEVER propagate into a credit amount (a NaN estimate/settle
  // would corrupt the ledger), so floor anything non-finite to 0.
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

function resolveCredits(action, ctx = {}) {
  // Own-property lookup: `CREDIT_COSTS['constructor']` on an object literal
  // returns a truthy FUNCTION, so `!spec` passes and `spec.active` then throws
  // — and since the credit gate fails open on an estimator throw, that path
  // runs the action for free. No caller passes a caller-controlled action
  // today (classifyAgentRun is string-and-own-property-only), but this is the
  // primitive that made an earlier bug free rather than merely mispriced.
  const spec = Object.prototype.hasOwnProperty.call(CREDIT_COSTS, action)
    ? CREDIT_COSTS[action]
    : undefined;
  if (!spec) throw new Error(`Unknown credit action: ${action}`);

  // Safety guard: never bill an action that isn't wired end-to-end. Catches a
  // typo or a premature gate on a roadmap/NEW-BUILD action at call time. (The
  // gate fails open on a thrown estimator, so a mis-wire runs free — never
  // charges a wrong amount.)
  if (!spec.active) throw new Error(`Credit action not active (not billable): ${action}`);

  // Zero-credit variants never deduct (stock image search, in-allowance scan…).
  if (ctx.zeroCredit) return 0;

  // Option B: Free's fixed-bundle core-loop actions deduct 0 (count-gated by the
  // tier's lifetime limits instead — see tierEnforcement + configTiers Phase 5).
  if (ctx.tier === 'free' && spec.fixedBundleFree) return 0;

  // Variable cost function (e.g. AI chat: ≤8K tokens = 1, else 2).
  if (typeof spec.variable === 'function') {
    return toFiniteUnits(spec.variable(ctx));
  }

  // Per-unit variable costs with an optional cap on the billable unit count.
  let units = 1;
  if (spec.perRow) units = ctx.rows ?? ctx.count ?? 1;
  else if (spec.perActivePrompt) units = ctx.activePrompts ?? ctx.count ?? 1;
  units = toFiniteUnits(units); // coerce non-numeric / NaN / negative → safe
  if (spec.cap != null) units = Math.min(units, spec.cap);

  return spec.credits * units;
}

/** True if the action exists end-to-end and may be billed today. */
function isActive(action) {
  return CREDIT_COSTS[action]?.active === true;
}

module.exports = {
  DEDUCTION_ORDER,
  REFUND_ORDER,
  CHARGE_POLICY,
  ZERO_CREDIT_VARIANTS,
  FREE_SAMPLE_POOL_CREDITS,
  MARKUP_CLASSES,
  resolveCredits,
  isActive,
};
