/**
 * Phase 5 — configTiers.js must equal v4.1 Table 1 (LIVE cells).
 *
 * SPEC-ORACLE: EXPECTED is transcribed DIRECTLY from GEO-PRICING-v4.md Table 1.
 * If a cell here disagrees with configTiers.js, the default assumption is that
 * configTiers is wrong — fix the config, not this fixture. Only edit a cell when
 * Table 1 itself changes.
 *
 * Credits (creditsPerMonth) are pinned as of Phase 7: 0 / 3000 / 10000 / 30000.
 * Free's pool is 0 (recurring) — its in-editor AI is the one-time 200 sample
 * seeded at bootstrap (creditRules.FREE_SAMPLE_POOL_CREDITS), not this field.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TIERS } = require('../src/scripts/configTiers');
const TierConfig = require('../src/models/TierConfig');

// v4.1 Table 1 — LIVE cells. null = unlimited.
const EXPECTED = {
  free: {
    maxArticlesPerMonth: 3, articleLimitType: 'lifetime',
    maxAiTrackerPromptsPerMonth: 5, aiTrackerPromptLimitType: 'lifetime',
    // Free tracker-instance cap is a STOPGAP 1 (NOT Table 1's "Monitors (alert rules)=0"):
    // 0 would 429-block Free's only path to its 5 one-off checks. See configTiers.js.
    maxAiTrackerMonitors: 1, maxAiTrackerPlatforms: 2, aiTrackerRefreshInterval: 'weekly',
    maxKeywordLookupsPerMonth: 50, keywordLimitType: 'lifetime',
    maxAuditsPerMonth: 5, auditLimitType: 'lifetime',
    maxBrandVoices: 1, maxAvatars: 1, maxWorkspaces: 1, maxSites: 1, maxCrawlPages: 100,
    maxSeats: 1, extraSeatPrice: 0, clientViewers: 0,
    contentVersionHistoryDays: 7, supportTier: 'docs',
    creditsPerMonth: 0, creditLimitType: 'lifetime',
  },
  standard: {
    maxArticlesPerMonth: 20, articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 25, aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerMonitors: 3, maxAiTrackerPlatforms: 4, aiTrackerRefreshInterval: 'weekly',
    maxKeywordLookupsPerMonth: 1000, keywordLimitType: 'monthly',
    maxAuditsPerMonth: 50, auditLimitType: 'monthly',
    maxBrandVoices: 1, maxAvatars: 2, maxWorkspaces: 2, maxSites: 3, maxCrawlPages: 1000,
    maxSeats: 2, extraSeatPrice: 0, clientViewers: 3,
    contentVersionHistoryDays: 30, supportTier: 'email24h',
    creditsPerMonth: 3000, creditLimitType: 'monthly',
  },
  professional: {
    maxArticlesPerMonth: 50, articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 30, aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerMonitors: 10, maxAiTrackerPlatforms: 4, aiTrackerRefreshInterval: 'daily',
    maxKeywordLookupsPerMonth: 5000, keywordLimitType: 'monthly',
    maxAuditsPerMonth: 200, auditLimitType: 'monthly',
    maxBrandVoices: 5, maxAvatars: 5, maxWorkspaces: 5, maxSites: 10, maxCrawlPages: 5000,
    maxSeats: 5, extraSeatPrice: 10, clientViewers: 10,
    contentVersionHistoryDays: 90, supportTier: 'priority12h',
    creditsPerMonth: 10000, creditLimitType: 'monthly',
  },
  agency: {
    maxArticlesPerMonth: 300, articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 100, aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerMonitors: null, maxAiTrackerPlatforms: 4, aiTrackerRefreshInterval: 'daily',
    maxKeywordLookupsPerMonth: 25000, keywordLimitType: 'monthly',
    maxAuditsPerMonth: 1000, auditLimitType: 'monthly',
    maxBrandVoices: null, maxAvatars: null, maxWorkspaces: 10, maxSites: null, maxCrawlPages: 25000,
    maxSeats: 15, extraSeatPrice: 10, clientViewers: null,
    contentVersionHistoryDays: 365, supportTier: 'slack',
    creditsPerMonth: 30000, creditLimitType: 'monthly',
  },
};

test('configTiers matches v4.1 Table 1 for every LIVE cell', () => {
  assert.deepEqual(TIERS.map((t) => t.tier).sort(), Object.keys(EXPECTED).sort());
  for (const [tier, want] of Object.entries(EXPECTED)) {
    const cfg = TIERS.find((t) => t.tier === tier);
    assert.ok(cfg, `tier ${tier} present`);
    for (const [field, value] of Object.entries(want)) {
      assert.strictEqual(cfg[field], value, `${tier}.${field}: expected ${value}, got ${cfg[field]}`);
    }
  }
});

test('Free is a fixed lifetime bundle (article/keyword/audit/tracker one-time)', () => {
  const free = TIERS.find((t) => t.tier === 'free');
  assert.equal(free.articleLimitType, 'lifetime');
  assert.equal(free.keywordLimitType, 'lifetime');
  assert.equal(free.auditLimitType, 'lifetime');
  assert.equal(free.aiTrackerPromptLimitType, 'lifetime');
});

test('every tier can create >=1 AI Tracker instance (else the tracker feature is dead)', () => {
  // maxAiTrackerMonitors is the tracker-INSTANCE cap; setup/createMonitor block at
  // `count >= limit`, so any tier at 0 (or a positive tier that only offers one-off
  // checks) cannot run the tracker at all. null = unlimited. Guards the Free stopgap.
  for (const t of TIERS) {
    assert.ok(
      t.maxAiTrackerMonitors == null || t.maxAiTrackerMonitors >= 1,
      `${t.tier}.maxAiTrackerMonitors must be >=1 (or null); got ${t.maxAiTrackerMonitors} — 0 locks the tracker`
    );
  }
});

test('extra editor seat is $10 on both paid tiers that offer it (Pro, Agency)', () => {
  assert.equal(TIERS.find((t) => t.tier === 'professional').extraSeatPrice, 10);
  assert.equal(TIERS.find((t) => t.tier === 'agency').extraSeatPrice, 10);
  assert.equal(TIERS.find((t) => t.tier === 'free').extraSeatPrice, 0);
});

test('new fields (clientViewers, supportTier) survive the TierConfig schema', () => {
  // Mongoose strict mode would drop undeclared fields → this proves the schema
  // declares them, so syncTiers actually persists the values.
  const doc = new TierConfig(TIERS.find((t) => t.tier === 'professional'));
  assert.equal(doc.clientViewers, 10);
  assert.equal(doc.supportTier, 'priority12h');
  assert.equal(doc.extraSeatPrice, 10);
});

test('supportTier enum rejects an unknown value', () => {
  const doc = new TierConfig({ tier: 'free', displayName: 'Free', supportTier: 'carrier-pigeon' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.supportTier, 'invalid supportTier should fail schema validation');
});
