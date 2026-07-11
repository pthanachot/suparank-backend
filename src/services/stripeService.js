/**
 * Shared Stripe service (Phase 16 — Connect + agency-defined client plans).
 *
 * A single, configured platform Stripe instance with a PINNED apiVersion, plus
 * the small helpers new Connect code needs. The legacy billingController and
 * webhookController each keep their own `new Stripe(...)` instance on purpose —
 * do NOT route them through here (avoids regressions). This service is for new
 * Phase 16 code only.
 *
 * Env vars consumed:
 *   STRIPE_SECRET_KEY            — platform secret key (agency/platform account)
 *   STRIPE_WEBHOOK_SECRET        — signing secret for the PLATFORM webhook endpoint
 *   STRIPE_CONNECT_WEBHOOK_SECRET — signing secret for the CONNECT webhook endpoint
 *                                   (events with an `account` field, routed to the
 *                                   agency's connected account)
 *
 * The apiVersion is pinned to the version the installed stripe@^20.x SDK targets
 * so response shapes stay stable across SDK/account upgrades.
 */

const Stripe = require('stripe');

// Pinned Stripe API version — single source shared with every other `new Stripe()`
// in the app (legacy controllers + cutover scripts) via config/stripeApiVersion.
const STRIPE_API_VERSION = require('../config/stripeApiVersion');

// Platform Stripe instance. The Stripe constructor THROWS when the key is
// missing, so fall back to a harmless placeholder to keep module import (and
// CI) working when STRIPE_SECRET_KEY is unset. No network call happens until a
// method is invoked, and real usage must be gated behind isConfigured().
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_unconfigured_placeholder', {
  apiVersion: STRIPE_API_VERSION,
});

/**
 * Whether a Stripe secret key is present in the environment. Callers should
 * short-circuit (503 / no-op) when this is false rather than hitting Stripe.
 */
function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Per-request options object that makes the platform SDK act ON a connected
 * account (Stripe Connect Standard). Pass it as the LAST argument to any Stripe
 * method, e.g.:
 *
 *   stripe.checkout.sessions.create(params, connectedAccountOptions(acctId));
 *   stripe.prices.create(params, connectedAccountOptions(acctId));
 */
function connectedAccountOptions(connectedAccountId) {
  return { stripeAccount: connectedAccountId };
}

// Webhook signing secrets re-exported for the sibling webhook workstreams.
const PLATFORM_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || null;

module.exports = {
  stripe,
  STRIPE_API_VERSION,
  isConfigured,
  connectedAccountOptions,
  PLATFORM_WEBHOOK_SECRET,
  CONNECT_WEBHOOK_SECRET,
};
