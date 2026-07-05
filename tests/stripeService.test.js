/**
 * Tests for the shared Phase 16 Stripe service.
 *
 *   - isConfigured() reflects the presence of STRIPE_SECRET_KEY at call time,
 *   - connectedAccountOptions() returns the { stripeAccount } shape the SDK uses
 *     to act ON a connected account,
 *   - the apiVersion is PINNED (exported constant + baked into the instance).
 *
 * No network calls — the service constructs a placeholder Stripe instance when
 * no key is set, so it imports cleanly without credentials.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const realKey = process.env.STRIPE_SECRET_KEY;
after(() => {
  if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = realKey;
});

const {
  stripe,
  STRIPE_API_VERSION,
  isConfigured,
  connectedAccountOptions,
} = require('../src/services/stripeService');

describe('stripeService', () => {
  it('isConfigured() reflects STRIPE_SECRET_KEY presence', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    assert.equal(isConfigured(), true);

    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(isConfigured(), false);

    process.env.STRIPE_SECRET_KEY = '';
    assert.equal(isConfigured(), false);
  });

  it('connectedAccountOptions() returns { stripeAccount } shape', () => {
    assert.deepEqual(connectedAccountOptions('acct_123'), { stripeAccount: 'acct_123' });
  });

  it('pins a stable apiVersion', () => {
    assert.equal(STRIPE_API_VERSION, '2026-02-25.clover');
    // The pin is actually applied to the constructed instance.
    assert.equal(stripe.getApiField('version'), '2026-02-25.clover');
  });
});
