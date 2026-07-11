'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildPriceManifest, TEST_MODE_FALLBACK_PRICE_IDS, stripeKeyMode } = require('../src/config/stripeCatalog');
const { validateStripeConfig, assertStripeConfigAtBoot } = require('../src/config/validateStripeConfig');
const { TIERS } = require('../src/scripts/configTiers');
const { CREDIT_PACKS } = require('../src/config/creditPacks');

// ─── Manifest is derived from the SSOT (no drift) ──────────────────────────

test('manifest has the 11 wired prices with the correct env var names', () => {
  const m = buildPriceManifest();
  const byEnv = Object.fromEntries(m.map((x) => [x.envVar, x]));
  const expectedEnv = [
    'STRIPE_STANDARD_MONTHLY_PRICE_ID',
    'STRIPE_STANDARD_YEARLY_PRICE_ID',
    'STRIPE_PRO_MONTHLY_PRICE_ID',
    'STRIPE_PRO_YEARLY_PRICE_ID',
    'STRIPE_AGENCY_MONTHLY_PRICE_ID',
    'STRIPE_AGENCY_YEARLY_PRICE_ID',
    'STRIPE_PRO_EXTRA_SEAT_MONTHLY_PRICE_ID',
    'STRIPE_AGENCY_EXTRA_SEAT_MONTHLY_PRICE_ID',
    'STRIPE_CREDIT_PACK_SMALL_PRICE_ID',
    'STRIPE_CREDIT_PACK_MEDIUM_PRICE_ID',
    'STRIPE_CREDIT_PACK_LARGE_PRICE_ID',
  ];
  assert.strictEqual(m.length, 11);
  assert.deepStrictEqual(Object.keys(byEnv).sort(), [...expectedEnv].sort());
});

test('subscription amounts match configTiers monthly/yearly prices', () => {
  const m = buildPriceManifest();
  const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
  const tier = (k) => TIERS.find((t) => t.tier === k);

  const cases = [
    ['standard-monthly', tier('standard').monthlyPrice, 'month'],
    ['standard-yearly', tier('standard').yearlyPrice, 'year'],
    ['pro-monthly', tier('professional').monthlyPrice, 'month'],
    ['pro-yearly', tier('professional').yearlyPrice, 'year'],
    ['agency-monthly', tier('agency').monthlyPrice, 'month'],
    ['agency-yearly', tier('agency').yearlyPrice, 'year'],
  ];
  for (const [key, usd, interval] of cases) {
    assert.ok(byKey[key], `missing ${key}`);
    assert.strictEqual(byKey[key].unitAmount, Math.round(usd * 100), `${key} amount`);
    assert.strictEqual(byKey[key].interval, interval, `${key} interval`);
    assert.strictEqual(byKey[key].currency, 'usd');
  }
});

test('concrete expected cents match v4.1 pricing (guards against config edits)', () => {
  const byKey = Object.fromEntries(buildPriceManifest().map((x) => [x.key, x.unitAmount]));
  assert.strictEqual(byKey['standard-monthly'], 2900);
  assert.strictEqual(byKey['standard-yearly'], 27600);
  assert.strictEqual(byKey['pro-monthly'], 9900);
  assert.strictEqual(byKey['pro-yearly'], 94800);
  assert.strictEqual(byKey['agency-monthly'], 29900);
  assert.strictEqual(byKey['agency-yearly'], 286800);
});

test('extra-seat prices are monthly and match extraSeatPrice', () => {
  const byKey = Object.fromEntries(buildPriceManifest().map((x) => [x.key, x]));
  const pro = byKey['pro-extra-seat-monthly'];
  const agy = byKey['agency-extra-seat-monthly'];
  assert.strictEqual(pro.unitAmount, TIERS.find((t) => t.tier === 'professional').extraSeatPrice * 100);
  assert.strictEqual(agy.unitAmount, TIERS.find((t) => t.tier === 'agency').extraSeatPrice * 100);
  assert.strictEqual(pro.interval, 'month');
  assert.strictEqual(agy.interval, 'month');
  assert.strictEqual(pro.unitAmount, 1000);
});

test('credit packs are one-time and match creditPacks priceUsd + credits', () => {
  const byKey = Object.fromEntries(buildPriceManifest().map((x) => [x.key, x]));
  for (const p of CREDIT_PACKS) {
    const entry = byKey[p.id];
    assert.ok(entry, `missing pack ${p.id}`);
    assert.strictEqual(entry.interval, null, `${p.id} must be one-time`);
    assert.strictEqual(entry.unitAmount, p.priceUsd * 100, `${p.id} amount`);
    assert.strictEqual(entry.packCredits, p.credits, `${p.id} credits`);
  }
});

test('every entry has a unique, namespaced lookup_key', () => {
  const keys = buildPriceManifest().map((x) => x.lookupKey);
  assert.strictEqual(new Set(keys).size, keys.length, 'lookup keys must be unique');
  for (const k of keys) assert.match(k, /^suparank_/);
});

// ─── validateStripeConfig ──────────────────────────────────────────────────

const LIVE = 'sk_live_abc';
const TEST = 'sk_test_abc';

// A fully-wired live env (all price vars set to plausible live ids).
function liveEnvAllSet(overrides = {}) {
  const env = { STRIPE_SECRET_KEY: LIVE, STRIPE_WEBHOOK_SECRET: 'whsec_live', NODE_ENV: 'production' };
  for (const m of buildPriceManifest()) env[m.envVar] = `price_live_${m.key}`;
  return { ...env, ...overrides };
}

test('no key → ok with a warning (billing disabled, not fatal)', () => {
  const r = validateStripeConfig({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'none');
  assert.strictEqual(r.warnings.length, 1);
});

test('test mode → ok even with price vars unset (uses fallbacks)', () => {
  const r = validateStripeConfig({ STRIPE_SECRET_KEY: TEST });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'test');
  assert.strictEqual(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /Test mode/.test(w)));
});

test('unrecognized key shape (no _live_/_test_) → unknown, not validated', () => {
  const r = validateStripeConfig({ STRIPE_SECRET_KEY: 'garbagekey123' });
  assert.strictEqual(r.mode, 'unknown');
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /unrecognized shape/.test(w)));
});

test('restricted LIVE key (rk_live_) is treated as live and validated', () => {
  // Regression guard: the sk_-prefix-only check let rk_live_ deploys skip
  // validation entirely. rk_live_ must now be validated like sk_live_.
  const env = { STRIPE_SECRET_KEY: 'rk_live_abc' }; // nothing else wired
  const r = validateStripeConfig(env);
  assert.strictEqual(r.mode, 'live');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /STRIPE_WEBHOOK_SECRET/.test(e)));
  assert.ok(r.errors.length >= buildPriceManifest().length, 'every unset price var should error');
});

test('restricted TEST key (rk_test_) is treated as test', () => {
  const r = validateStripeConfig({ STRIPE_SECRET_KEY: 'rk_test_abc' });
  assert.strictEqual(r.mode, 'test');
  assert.strictEqual(r.ok, true);
});

test('live + an OPTIONAL yearly-seat var set to a test id → error', () => {
  const env = liveEnvAllSet({ STRIPE_PRO_EXTRA_SEAT_YEARLY_PRICE_ID: [...TEST_MODE_FALLBACK_PRICE_IDS][0] });
  const r = validateStripeConfig(env);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /STRIPE_PRO_EXTRA_SEAT_YEARLY_PRICE_ID/.test(e)));
});

test('live + fully wired → ok', () => {
  const r = validateStripeConfig(liveEnvAllSet());
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.mode, 'live');
  assert.strictEqual(r.errors.length, 0);
});

test('live + missing webhook secret → error', () => {
  const env = liveEnvAllSet();
  delete env.STRIPE_WEBHOOK_SECRET;
  const r = validateStripeConfig(env);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /STRIPE_WEBHOOK_SECRET/.test(e)));
});

test('live + a missing price env var → error naming it', () => {
  const env = liveEnvAllSet();
  delete env.STRIPE_PRO_MONTHLY_PRICE_ID;
  const r = validateStripeConfig(env);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /STRIPE_PRO_MONTHLY_PRICE_ID/.test(e)));
});

test('live + a price var still set to a TEST fallback id → error', () => {
  const testId = [...TEST_MODE_FALLBACK_PRICE_IDS][0];
  const env = liveEnvAllSet({ STRIPE_STANDARD_MONTHLY_PRICE_ID: testId });
  const r = validateStripeConfig(env);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /TEST-MODE price id/.test(e) && e.includes('STRIPE_STANDARD_MONTHLY_PRICE_ID')));
});

// ─── stripeKeyMode ─────────────────────────────────────────────────────────

test('stripeKeyMode classifies sk_/rk_ live/test and none/unknown', () => {
  assert.strictEqual(stripeKeyMode('sk_live_x'), 'live');
  assert.strictEqual(stripeKeyMode('rk_live_x'), 'live');
  assert.strictEqual(stripeKeyMode('sk_test_x'), 'test');
  assert.strictEqual(stripeKeyMode('rk_test_x'), 'test');
  assert.strictEqual(stripeKeyMode(''), 'none');
  assert.strictEqual(stripeKeyMode(undefined), 'none');
  assert.strictEqual(stripeKeyMode('whatever'), 'unknown');
});

// ─── assertStripeConfigAtBoot (boot gate) ──────────────────────────────────

function fakeLogger() { return { warn() {}, error() {}, log() {} }; }

test('boot: live + broken exits(1) even when NODE_ENV is NOT production', () => {
  let code = null;
  assertStripeConfigAtBoot({
    env: { STRIPE_SECRET_KEY: 'sk_live_x', NODE_ENV: 'staging' }, // broken (no prices)
    exit: (c) => { code = c; },
    logger: fakeLogger(),
  });
  assert.strictEqual(code, 1);
});

test('boot: fully-wired live does NOT exit', () => {
  let code = null;
  assertStripeConfigAtBoot({ env: liveEnvAllSet(), exit: (c) => { code = c; }, logger: fakeLogger() });
  assert.strictEqual(code, null);
});

test('boot: test mode never exits (dev/CI safe)', () => {
  let code = null;
  assertStripeConfigAtBoot({ env: { STRIPE_SECRET_KEY: 'sk_test_x' }, exit: (c) => { code = c; }, logger: fakeLogger() });
  assert.strictEqual(code, null);
});

// ─── Drift guard vs the runtime consumers (stripePrices.js / creditPacks.js) ──

test('manifest env vars all exist in the runtime files that read them', () => {
  const cfgDir = path.join(__dirname, '..', 'src', 'config');
  const src =
    fs.readFileSync(path.join(cfgDir, 'stripePrices.js'), 'utf8') +
    fs.readFileSync(path.join(cfgDir, 'creditPacks.js'), 'utf8');
  const readEnvVars = new Set((src.match(/process\.env\.(STRIPE_[A-Z0-9_]+)/g) || []).map((s) => s.replace('process.env.', '')));
  for (const m of buildPriceManifest()) {
    assert.ok(readEnvVars.has(m.envVar), `${m.envVar} is in the manifest but NOT read by stripePrices.js/creditPacks.js`);
  }
});

test('TEST_MODE_FALLBACK_PRICE_IDS equals the hardcoded literals in stripePrices.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'stripePrices.js'), 'utf8');
  const literals = new Set((src.match(/'(price_[A-Za-z0-9]+)'/g) || []).map((s) => s.replace(/'/g, '')));
  assert.deepStrictEqual(
    [...TEST_MODE_FALLBACK_PRICE_IDS].sort(),
    [...literals].sort(),
    'the frozen fallback set must match the price_ literals in stripePrices.js'
  );
});
