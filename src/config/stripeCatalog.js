/**
 * Stripe price catalog — the single source of truth for the platform's live
 * price set (Phase 13 cutover tooling).
 *
 * The amounts are DERIVED from the tier configs (configTiers.js) and the credit
 * packs (creditPacks.js) so they can never drift from what the app charges and
 * entitles. `scripts/createStripePrices.js` uses this to create the prices,
 * `scripts/verifyStripePrices.js` uses it to preflight them, and
 * `validateStripeConfig.js` uses it to fail-fast on a half-configured cutover.
 *
 * This file does NOT talk to Stripe — it is pure config so it can be unit-tested
 * without a key or network (see tests/stripeCatalog.test.js).
 *
 * The env var names here MUST match the ones stripePrices.js / creditPacks.js
 * read at runtime — this manifest is the checklist for those.
 */

const { TIERS } = require('../scripts/configTiers');
const { CREDIT_PACKS } = require('./creditPacks');

const CURRENCY = 'usd';

/**
 * Classify a Stripe secret key by MODE, robust to both secret keys (sk_live_/
 * sk_test_) AND restricted keys (rk_live_/rk_test_ — which Stripe recommends).
 * Detection keys off the `_live_` / `_test_` segment, not the `sk_` prefix, so a
 * live restricted key is correctly treated as live (the earlier `sk_`-only check
 * left rk_live_ deploys unvalidated). Key random suffixes are alphanumeric with
 * no underscores, so the segment match is unambiguous.
 *
 * @returns {'live'|'test'|'unknown'|'none'}
 */
function stripeKeyMode(key) {
  if (!key) return 'none';
  if (key.includes('_live_')) return 'live';
  if (key.includes('_test_')) return 'test';
  return 'unknown';
}

/**
 * The two *yearly* extra-seat price env vars the runtime also reads
 * (stripePrices.js:34,36) but which default to null / unwired — deliberately
 * NOT in the required manifest. Listed so live validation can still reject a
 * stale TEST price id accidentally set on them (closes the yearly-seat gap).
 */
const OPTIONAL_PRICE_ENV_VARS = [
  'STRIPE_PRO_EXTRA_SEAT_YEARLY_PRICE_ID',
  'STRIPE_AGENCY_EXTRA_SEAT_YEARLY_PRICE_ID',
];

// The 'professional' tier is sold to customers as "Pro"; its plan-id prefix is
// `pro-*` (matches stripePrices.js PRICE_TO_PLAN values and the frontend).
function tierCfg(key) {
  const t = TIERS.find((x) => x.tier === key);
  if (!t) throw new Error(`stripeCatalog: no tier config for '${key}'`);
  return t;
}

/**
 * The test-mode price ids currently hardcoded as fallbacks in stripePrices.js.
 * validateStripeConfig uses this to detect a live key still pointed at a test
 * price (the silent-drop failure mode called out in the Phase-13 recon). These
 * are frozen historical test ids — they never change.
 */
const TEST_MODE_FALLBACK_PRICE_IDS = new Set([
  // legacy archived (stripePrices.js L14-16)
  'price_1TCaUDPViW8Lznb8599QuBfr',
  'price_1TCaUDPViW8Lznb86MXvgr4Z',
  'price_1TXcfBPViW8Lznb8647tzgfh',
  // base-plan fallbacks (L18-23)
  'price_1TCaMYPViW8Lznb8OykrDOqY',
  'price_1TCaMYPViW8Lznb8SOYEOsk2',
  'price_1TqgFlPViW8Lznb83LUTC8zG',
  'price_1TqgGgPViW8Lznb8WHz3pPqE',
  'price_1TWnXePViW8Lznb8eesFJjnR',
  'price_1TqgGgPViW8Lznb8DwXr03Jq',
  // extra-seat fallbacks (L33, L35)
  'price_1TWnQNPViW8Lznb8af18ejPg',
  'price_1TWnYAPViW8Lznb8it4FshGA',
]);

/**
 * Build the full price manifest. Pure — reads only the tier/pack configs.
 *
 * Each entry:
 *   key         internal plan/price id (matches stripePrices.js values / pack ids)
 *   envVar      the env var that must hold this price's Stripe id at runtime
 *   product     { key, name } logical product grouping (for create script)
 *   unitAmount  integer cents (from the tier/pack config)
 *   currency    'usd'
 *   interval    'month' | 'year' | null (null = one-time payment)
 *   lookupKey   Stripe price lookup_key — used for idempotent create + verify
 *   nickname    human label set on the Stripe price
 *   packCredits (packs only) credits granted, echoed to price metadata
 *
 * Scope: the 11 prices that are actually WIRED and sold — base plans
 * (standard/pro/agency × monthly/yearly), the two monthly extra-seat add-ons
 * (pro/agency), and the three credit packs. The two *yearly* extra-seat env
 * vars are intentionally omitted: configTiers defines a single flat
 * extraSeatPrice and stripePrices.js leaves the yearly-seat ids null/unwired
 * (see the runbook's "known gaps").
 */
function buildPriceManifest() {
  const std = tierCfg('standard');
  const pro = tierCfg('professional');
  const agy = tierCfg('agency');

  const sub = (planKey, cfg, interval, envVar) => {
    const suffix = interval === 'year' ? 'yearly' : 'monthly';
    const amountUsd = interval === 'year' ? cfg.yearlyPrice : cfg.monthlyPrice;
    return {
      key: `${planKey}-${suffix}`,
      envVar,
      product: { key: planKey, name: `SupaRank ${cfg.displayName}` },
      unitAmount: Math.round(amountUsd * 100),
      currency: CURRENCY,
      interval,
      lookupKey: `suparank_${planKey}_${suffix}`,
      nickname: `${cfg.displayName} (${suffix})`,
    };
  };

  const seat = (planKey, cfg, envVar) => ({
    key: `${planKey}-extra-seat-monthly`,
    envVar,
    product: { key: 'extra-seat', name: 'SupaRank Extra Editor Seat' },
    unitAmount: Math.round((cfg.extraSeatPrice || 0) * 100),
    currency: CURRENCY,
    interval: 'month',
    lookupKey: `suparank_${planKey}_extra_seat_monthly`,
    nickname: `Extra Editor Seat — ${cfg.displayName} (monthly)`,
  });

  const pack = (id, envVar) => {
    const p = CREDIT_PACKS.find((x) => x.id === id);
    if (!p) throw new Error(`stripeCatalog: no credit pack '${id}'`);
    return {
      key: p.id,
      envVar,
      product: { key: 'credit-pack', name: 'SupaRank Credit Pack' },
      unitAmount: Math.round(p.priceUsd * 100),
      currency: CURRENCY,
      interval: null, // one-time
      lookupKey: `suparank_${p.id.replace(/-/g, '_')}`,
      nickname: `${p.label} top-up`,
      packCredits: p.credits,
    };
  };

  return [
    sub('standard', std, 'month', 'STRIPE_STANDARD_MONTHLY_PRICE_ID'),
    sub('standard', std, 'year', 'STRIPE_STANDARD_YEARLY_PRICE_ID'),
    sub('pro', pro, 'month', 'STRIPE_PRO_MONTHLY_PRICE_ID'),
    sub('pro', pro, 'year', 'STRIPE_PRO_YEARLY_PRICE_ID'),
    sub('agency', agy, 'month', 'STRIPE_AGENCY_MONTHLY_PRICE_ID'),
    sub('agency', agy, 'year', 'STRIPE_AGENCY_YEARLY_PRICE_ID'),
    seat('pro', pro, 'STRIPE_PRO_EXTRA_SEAT_MONTHLY_PRICE_ID'),
    seat('agency', agy, 'STRIPE_AGENCY_EXTRA_SEAT_MONTHLY_PRICE_ID'),
    pack('credits-5k', 'STRIPE_CREDIT_PACK_SMALL_PRICE_ID'),
    pack('credits-15k', 'STRIPE_CREDIT_PACK_MEDIUM_PRICE_ID'),
    pack('credits-50k', 'STRIPE_CREDIT_PACK_LARGE_PRICE_ID'),
  ];
}

module.exports = {
  buildPriceManifest,
  TEST_MODE_FALLBACK_PRICE_IDS,
  OPTIONAL_PRICE_ENV_VARS,
  stripeKeyMode,
  CURRENCY,
};
