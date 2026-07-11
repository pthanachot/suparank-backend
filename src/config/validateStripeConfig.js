/**
 * Boot-time Stripe configuration validation (Phase 13 cutover safety).
 *
 * The billing subsystem is entirely env-var-driven, with TEST-MODE price ids
 * hardcoded as fallbacks in stripePrices.js. That means a half-configured
 * test→live switch (live key, but stale/missing price env vars) fails SILENTLY
 * at request time: `getPlanFromPriceId` returns null and the webhook drops the
 * subscription instead of granting it. This validator turns that silent,
 * revenue-losing failure into a loud boot-time signal.
 *
 * Pure over an env object so it is unit-testable (tests/stripeCatalog.test.js).
 * Wiring: index.js calls this at boot; in production a live-mode misconfig is
 * fatal (exit 1); in dev/test it only warns so a sk_test setup is never blocked.
 */

const {
  buildPriceManifest,
  TEST_MODE_FALLBACK_PRICE_IDS,
  OPTIONAL_PRICE_ENV_VARS,
  stripeKeyMode,
} = require('./stripeCatalog');

/**
 * @param {Object} [env=process.env]
 * @returns {{ ok: boolean, mode: 'live'|'test'|'unknown'|'none', errors: string[], warnings: string[] }}
 */
function validateStripeConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const key = env.STRIPE_SECRET_KEY;
  const mode = stripeKeyMode(key);

  if (mode === 'none') {
    return {
      ok: true, // not fatal — billing simply disabled (dev/CI)
      mode,
      errors,
      warnings: ['STRIPE_SECRET_KEY not set — billing/checkout endpoints will 500 until configured.'],
    };
  }

  if (mode === 'unknown') {
    // Neither _live_ nor _test_ in the key — cannot infer mode, so cannot safely
    // validate the price set. Warn loudly; do not claim the config is verified.
    warnings.push(
      'STRIPE_SECRET_KEY has an unrecognized shape (no _live_/_test_ segment) — cannot infer mode, '
      + 'so price/webhook config was NOT validated. Verify manually.'
    );
    return { ok: true, mode, errors, warnings };
  }

  const manifest = buildPriceManifest();

  if (mode === 'live') {
    // Live: everything the customer-facing flows touch must be wired to LIVE ids.
    if (!env.STRIPE_WEBHOOK_SECRET) {
      errors.push(
        'Live key set but STRIPE_WEBHOOK_SECRET is missing — every webhook will 400, so '
        + 'subscriptions and credit grants will NEVER be recorded.'
      );
    }
    for (const m of manifest) {
      const val = env[m.envVar];
      if (!val) {
        errors.push(
          `Live key set but ${m.envVar} (${m.key}) is unset — checkout will fall back to the `
          + 'hardcoded TEST price id and the webhook will drop the subscription.'
        );
      } else if (TEST_MODE_FALLBACK_PRICE_IDS.has(val)) {
        errors.push(
          `${m.envVar} points at a TEST-MODE price id (${val}) while STRIPE_SECRET_KEY is LIVE — `
          + 'checkout will fail / the subscription will be dropped. Set it to the live price id.'
        );
      }
    }
    // Optional (unwired) price vars: not required, but if set they must not be a
    // stale test id (would 500 the add-on flow against a live subscription).
    for (const envVar of OPTIONAL_PRICE_ENV_VARS) {
      const val = env[envVar];
      if (val && TEST_MODE_FALLBACK_PRICE_IDS.has(val)) {
        errors.push(
          `${envVar} points at a TEST-MODE price id (${val}) while STRIPE_SECRET_KEY is LIVE — `
          + 'unset it or set it to the live price id.'
        );
      }
    }
  } else {
    // Test mode: purely informational.
    const unset = manifest.filter((m) => !env[m.envVar]).map((m) => m.envVar);
    if (unset.length > 0) {
      warnings.push(
        `Test mode: ${unset.length} price env var(s) unset — the code will use test-mode fallback `
        + 'ids from stripePrices.js. Fine for dev; must be set with LIVE ids before going live.'
      );
    }
  }

  return { ok: errors.length === 0, mode, errors, warnings };
}

/**
 * Boot wrapper: log the result and, in production, exit(1) on any error so the
 * process manager reports a clear failure instead of silently losing revenue.
 * Never throws in non-production.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.env=process.env]
 * @param {Function} [opts.exit=process.exit]
 * @param {Object} [opts.logger=console]
 */
function assertStripeConfigAtBoot({ env = process.env, exit = process.exit, logger = console } = {}) {
  const { ok, mode, errors, warnings } = validateStripeConfig(env);

  for (const w of warnings) logger.warn(`[stripe-config] ⚠ ${w}`);
  for (const e of errors) logger.error(`[stripe-config] ✗ ${e}`);

  if (ok) {
    if (mode === 'live') logger.log('[stripe-config] LIVE mode — all wired price env vars present. ✓');
    return { ok, mode };
  }

  // Errors are only ever raised for a LIVE key, so !ok unambiguously means "a
  // live key with broken config" — dangerous in ANY environment (it charges/
  // drops against the real account), not just NODE_ENV=production. Abort boot so
  // the failure is loud, not a silent revenue leak on a mis-labeled env.
  logger.error('');
  logger.error('================================================');
  logger.error('FATAL: Stripe is in LIVE mode but mis-configured.');
  logger.error('Refusing to boot — fix the price env vars and restart.');
  logger.error('Run: node scripts/verifyStripePrices.js for a full report.');
  logger.error('================================================');
  exit(1);
  return { ok, mode };
}

module.exports = { validateStripeConfig, assertStripeConfigAtBoot };
