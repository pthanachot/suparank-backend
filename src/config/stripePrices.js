/**
 * Shared Stripe price configuration.
 *
 * Used by billingController and webhookController to map Stripe price IDs
 * to internal plan IDs and extra seat add-ons.
 */

// ─── Plan prices ────────────────────────────────────────────────

const PRICE_TO_PLAN = {
  [process.env.STRIPE_STANDARD_MONTHLY_PRICE_ID || 'price_1TCaMYPViW8Lznb8OykrDOqY']: 'standard-monthly',
  [process.env.STRIPE_STANDARD_YEARLY_PRICE_ID || 'price_1TCaMYPViW8Lznb8SOYEOsk2']: 'standard-yearly',
  [process.env.STRIPE_PRO_MONTHLY_PRICE_ID || 'price_1TCaUDPViW8Lznb8599QuBfr']: 'pro-monthly',
  [process.env.STRIPE_PRO_YEARLY_PRICE_ID || 'price_1TCaUDPViW8Lznb86MXvgr4Z']: 'pro-yearly',
  [process.env.STRIPE_AGENCY_MONTHLY_PRICE_ID || 'price_1TWnXePViW8Lznb8eesFJjnR']: 'agency-monthly',
  [process.env.STRIPE_AGENCY_YEARLY_PRICE_ID || 'price_1TXcfBPViW8Lznb8647tzgfh']: 'agency-yearly',
};

function getPlanFromPriceId(priceId) {
  return PRICE_TO_PLAN[priceId] || null;
}

// ─── Extra seat prices ──────────────────────────────────────────

const EXTRA_SEAT_PRICES = {
  'pro-monthly':    process.env.STRIPE_PRO_EXTRA_SEAT_MONTHLY_PRICE_ID || 'price_1TWnQNPViW8Lznb8af18ejPg',
  'pro-yearly':     process.env.STRIPE_PRO_EXTRA_SEAT_YEARLY_PRICE_ID || null,
  'agency-monthly': process.env.STRIPE_AGENCY_EXTRA_SEAT_MONTHLY_PRICE_ID || 'price_1TWnYAPViW8Lznb8it4FshGA',
  'agency-yearly':  process.env.STRIPE_AGENCY_EXTRA_SEAT_YEARLY_PRICE_ID || null,
};

// Set of all extra seat price IDs for quick webhook lookups
const EXTRA_SEAT_PRICE_SET = new Set(
  Object.values(EXTRA_SEAT_PRICES).filter(Boolean)
);

module.exports = {
  PRICE_TO_PLAN,
  getPlanFromPriceId,
  EXTRA_SEAT_PRICES,
  EXTRA_SEAT_PRICE_SET,
};
