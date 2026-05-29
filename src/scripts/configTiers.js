const TierConfig = require('../models/TierConfig');

/**
 * Tier configuration — the source of truth for per-tier limits.
 *
 * THIS FILE IS THE SOURCE OF TRUTH. Changes here are synced to the
 * database on every server startup. Do not edit values in MongoDB directly.
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
    maxAiTrackerMonitors: 1,
    maxAiTrackerPlatforms: 2,
    aiTrackerRefreshInterval: 'weekly',
    maxKeywordLookupsPerMonth: 50,
    keywordLimitType: 'lifetime',
    maxAuditsPerMonth: 5,
    auditLimitType: 'lifetime',
    maxBrandVoices: 1,
    maxAvatars: 1,
    maxWorkspaces: 1,

    maxSites: 1,
    sitesSyncFrequency: 'weekly',
    maxSitemaps: 2,
    maxCrawlPages: 100,
    maxSeats: 1,
    extraSeatPrice: 0,
    creditsPerMonth: 300,
    creditLimitType: 'lifetime',
    contentVersionHistoryDays: 7,
    custom: {
      creditDeductionFlags: {
        aiChat: true,
        aiAgent: true,
        brandVoiceTest: true,
        avatarTest: true,
        contentAudit: true,
        writingQualityAudit: true,
        aiTrackerScan: true,
      },
    },
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
    maxAiTrackerMonitors: 3,
    maxAiTrackerPlatforms: 4,
    aiTrackerRefreshInterval: 'weekly',
    maxKeywordLookupsPerMonth: 1000,
    keywordLimitType: 'monthly',
    maxAuditsPerMonth: 50,
    auditLimitType: 'monthly',
    maxBrandVoices: 1,
    maxAvatars: 2,
    maxWorkspaces: 2,
    maxSites: 3,
    sitesSyncFrequency: 'weekly',
    maxSitemaps: 5,
    maxCrawlPages: 1000,
    maxSeats: 2,
    extraSeatPrice: 0,
    creditsPerMonth: 3000,
    creditLimitType: 'monthly',
    contentVersionHistoryDays: 30,
    custom: {
      creditDeductionFlags: {
        aiChat: true,
        aiAgent: true,
        brandVoiceTest: true,
        avatarTest: true,
        contentAudit: true,
        writingQualityAudit: true,
        aiTrackerScan: true,
      },
    },
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
    maxAiTrackerMonitors: 5,
    maxAiTrackerPlatforms: 5,
    aiTrackerRefreshInterval: 'daily',
    maxKeywordLookupsPerMonth: 5000,
    keywordLimitType: 'monthly',
    maxAuditsPerMonth: 200,
    auditLimitType: 'monthly',
    maxBrandVoices: 5,
    maxAvatars: 5,
    maxWorkspaces: 5,
    maxSites: 10,
    sitesSyncFrequency: 'daily',
    maxSitemaps: 15,
    maxCrawlPages: 5000,
    maxSeats: 5,
    extraSeatPrice: 10,
    creditsPerMonth: 8000,
    creditLimitType: 'monthly',
    contentVersionHistoryDays: 90,
    custom: {
      creditDeductionFlags: {
        aiChat: true,
        aiAgent: true,
        brandVoiceTest: true,
        avatarTest: true,
        contentAudit: true,
        writingQualityAudit: true,
        aiTrackerScan: true,
      },
    },
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
    maxAiTrackerMonitors: null,  // unlimited
    maxAiTrackerPlatforms: 8,
    aiTrackerRefreshInterval: 'daily',
    maxKeywordLookupsPerMonth: 25000,
    keywordLimitType: 'monthly',
    maxAuditsPerMonth: 1000,
    auditLimitType: 'monthly',
    maxBrandVoices: null,   // unlimited
    maxAvatars: null,       // unlimited
    maxWorkspaces: 10,
    maxSites: null,          // unlimited
    sitesSyncFrequency: 'daily',
    maxSitemaps: 50,
    maxCrawlPages: 100000,
    maxSeats: 15,
    extraSeatPrice: 15,
    creditsPerMonth: 25000,
    creditLimitType: 'monthly',
    contentVersionHistoryDays: 180,
    custom: {
      creditDeductionFlags: {
        aiChat: true,
        aiAgent: true,
        brandVoiceTest: true,
        avatarTest: true,
        contentAudit: true,
        writingQualityAudit: true,
        aiTrackerScan: true,
      },
    },
  },
];

async function syncTiers() {
  let upserted = 0;
  let updated = 0;

  const configTiers = TIERS.map((t) => t.tier);

  for (const config of TIERS) {
    const result = await TierConfig.updateOne(
      { tier: config.tier },
      { $set: config },
      { upsert: true }
    );
    if (result.upsertedCount > 0) upserted++;
    else if (result.modifiedCount > 0) updated++;
  }

  // Remove tiers no longer in config
  const removed = await TierConfig.deleteMany({ tier: { $nin: configTiers } });

  // Flush the in-memory tier cache so stale data isn't served
  try {
    const { clearTierCache } = require('../services/tierService');
    clearTierCache();
  } catch { /* tierService may not be loaded yet during standalone sync */ }

  console.log(`[syncTiers] ${upserted} created, ${updated} updated, ${removed.deletedCount} removed`);
}

module.exports = { syncTiers, TIERS };
