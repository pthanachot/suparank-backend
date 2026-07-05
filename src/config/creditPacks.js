/**
 * Wholesale credit top-up packs.
 *
 * One-time purchases (Stripe `mode: 'payment'`) that add non-expiring
 * GENERAL credits to an organization. This is the platform's SaaS-margin
 * revenue stream — packs are priced above wholesale AI cost.
 *
 * Mirrors the env-driven price-id pattern in stripePrices.js. Each pack's
 * `stripePriceId` comes from a Stripe one-time Price. Until the env var is
 * wired up the id is `null`, which lets the feature dark-ship: the catalog
 * is visible but checkout returns 503 (see billingController.createCreditPackCheckout).
 *
 * Env vars (Stripe one-time Price IDs):
 *   STRIPE_CREDIT_PACK_SMALL_PRICE_ID    → credits-5k
 *   STRIPE_CREDIT_PACK_MEDIUM_PRICE_ID   → credits-15k
 *   STRIPE_CREDIT_PACK_LARGE_PRICE_ID    → credits-50k
 */

// ─── Pack catalog ───────────────────────────────────────────────

const CREDIT_PACKS = [
  {
    id: 'credits-5k',
    label: '5,000 credits',
    credits: 5000,
    stripePriceId: process.env.STRIPE_CREDIT_PACK_SMALL_PRICE_ID || null,
    priceUsd: 25, // display only — the real charge is the Stripe Price
  },
  {
    id: 'credits-15k',
    label: '15,000 credits',
    credits: 15000,
    stripePriceId: process.env.STRIPE_CREDIT_PACK_MEDIUM_PRICE_ID || null,
    priceUsd: 60,
  },
  {
    id: 'credits-50k',
    label: '50,000 credits',
    credits: 50000,
    stripePriceId: process.env.STRIPE_CREDIT_PACK_LARGE_PRICE_ID || null,
    priceUsd: 180,
  },
];

function getPackById(id) {
  return CREDIT_PACKS.find((p) => p.id === id) || null;
}

// Set of all configured credit-pack price IDs for quick webhook lookups.
// Excludes packs with no Stripe price wired up yet (null filtered out).
const CREDIT_PACK_PRICE_SET = new Set(
  CREDIT_PACKS.map((p) => p.stripePriceId).filter(Boolean)
);

module.exports = {
  CREDIT_PACKS,
  getPackById,
  CREDIT_PACK_PRICE_SET,
};
