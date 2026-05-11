const TierConfig = require('../models/TierConfig');

/**
 * Tier configuration — the source of truth for per-tier limits.
 *
 * Values can be edited directly in MongoDB without code changes.
 * This seed uses $setOnInsert so re-running will NOT overwrite manual edits.
 *
 * null = unlimited for numeric limits.
 * limitType 'lifetime' = one-time allotment (free tier).
 * limitType 'monthly'  = resets each billing cycle.
 */

const TIERS = [
  {
    tier: 'free',
    displayName: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    maxArticlesPerMonth: 3,
    articleLimitType: 'lifetime',
    maxAiTrackerPromptsPerMonth: 5,
    aiTrackerPromptLimitType: 'lifetime',
    maxAiTrackerPlatforms: 2,
    aiTrackerRefreshInterval: 'weekly',
    maxKeywordLookupsPerMonth: 50,
    keywordLimitType: 'lifetime',
    maxAuditsPerMonth: 5,
    auditLimitType: 'lifetime',
    maxBrandVoices: 1,
    maxSites: 1,
    maxSeats: 1,
    extraSeatPrice: 0,
    creditsPerMonth: 300,
    creditLimitType: 'lifetime',
  },
  {
    tier: 'standard',
    displayName: 'Standard',
    monthlyPrice: 29,
    yearlyPrice: 290,
    maxArticlesPerMonth: 20,
    articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 25,
    aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerPlatforms: 4,
    aiTrackerRefreshInterval: 'weekly',
    maxKeywordLookupsPerMonth: 1000,
    keywordLimitType: 'monthly',
    maxAuditsPerMonth: 50,
    auditLimitType: 'monthly',
    maxBrandVoices: 1,
    maxSites: 3,
    maxSeats: 2,
    extraSeatPrice: 0,
    creditsPerMonth: 3000,
    creditLimitType: 'monthly',
  },
  {
    tier: 'professional',
    displayName: 'Professional',
    monthlyPrice: 79,
    yearlyPrice: 790,
    maxArticlesPerMonth: 50,
    articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 100,
    aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerPlatforms: 5,
    aiTrackerRefreshInterval: 'daily',
    maxKeywordLookupsPerMonth: 5000,
    keywordLimitType: 'monthly',
    maxAuditsPerMonth: 200,
    auditLimitType: 'monthly',
    maxBrandVoices: 5,
    maxSites: 10,
    maxSeats: 5,
    extraSeatPrice: 10,
    creditsPerMonth: 8000,
    creditLimitType: 'monthly',
  },
  {
    tier: 'agency',
    displayName: 'Agency',
    monthlyPrice: 299,
    yearlyPrice: 2990,
    maxArticlesPerMonth: null,  // unlimited
    articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 1000,
    aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerPlatforms: 8,
    aiTrackerRefreshInterval: 'daily',
    maxKeywordLookupsPerMonth: 25000,
    keywordLimitType: 'monthly',
    maxAuditsPerMonth: 1000,
    auditLimitType: 'monthly',
    maxBrandVoices: null,   // unlimited
    maxSites: null,          // unlimited
    maxSeats: 15,
    extraSeatPrice: 15,
    creditsPerMonth: 25000,
    creditLimitType: 'monthly',
  },
];

async function seedTierConfig() {
  let created = 0;
  let skipped = 0;

  for (const config of TIERS) {
    const result = await TierConfig.updateOne(
      { tier: config.tier },
      { $setOnInsert: config },
      { upsert: true }
    );
    if (result.upsertedCount > 0) created++;
    else skipped++;
  }

  console.log(`[seedTierConfig] ${created} created, ${skipped} already existed`);
}

module.exports = { seedTierConfig, TIERS };
