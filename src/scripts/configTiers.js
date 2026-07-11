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
    // v4.1 Table 1 — Free: fixed lifetime bundles (3 articles, 5 audits, 50 keywords,
    // 5 one-off tracker checks), budget model preset, 0 monitors, 2 engines.
    maxArticlesPerMonth: 3,
    articleLimitType: 'lifetime',
    maxAiTrackerPromptsPerMonth: 5,
    aiTrackerPromptLimitType: 'lifetime',
    // Phase 11 (kept at 1, deliberately): Table 1's "Monitors (alert rules)=0"
    // for Free means NO automated/recurring monitoring. maxAiTrackerMonitors here
    // is the tracker-INSTANCE cap (a DIFFERENT axis): setup/createMonitor block at
    // `count >= limit`, so 0 would lock Free out of the AI Tracker entirely — its
    // "5 one-off checks" can only live inside one tracker instance. So Free keeps 1
    // instance to hold those manual checks. The "0 recurring monitoring" half is
    // enforced separately in executeScan (step 2a): scheduled cron scans are
    // ZERO-CREDIT, so the credit model does NOT gate them — instead the scan
    // chokepoint UNSCHEDULES (nextScanAt=null) and skips any scheduled scan for a
    // Free-tier org. Manual on-demand refreshes (force=true) still run. Net: Free
    // gets 1 instance for 5 manual checks and 0 recurring scans — exactly Table 1.
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
    clientViewers: 0,
    supportTier: 'docs',
    // Phase 7: Free has NO monthly/recurring credit pool. Its in-editor AI is
    // funded by a ONE-TIME 200-credit lifetime sample seeded at org bootstrap
    // (creditRules.FREE_SAMPLE_POOL_CREDITS → user_free pool), separate from this
    // field. creditsPerMonth stays 0 so nothing recurring is ever granted.
    creditsPerMonth: 0,
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
    yearlyPrice: 276,
    // v4.1 Table 1 — Standard $29: 20 articles/mo, 25 prompts weekly, all 4 engines,
    // 2 workspaces, 2 seats + 3 client viewers.
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
    clientViewers: 3,
    supportTier: 'email24h',
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
    monthlyPrice: 99,
    yearlyPrice: 948,
    // v4.1 Table 1 — Professional $99: 50 articles/mo, 30 prompts daily, all 4 engines,
    // 5 voices/avatars, 5 workspaces, 5 seats (+$10) + 10 client viewers, 10 monitors.
    maxArticlesPerMonth: 50,
    articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 30,
    aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerMonitors: 10,
    maxAiTrackerPlatforms: 4,
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
    clientViewers: 10,
    supportTier: 'priority12h',
    creditsPerMonth: 10000, // Phase 7: Table-1 Pro allocation
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
    yearlyPrice: 2868,
    // v4.1 Table 1 — Agency $299: 300 articles/mo, 100 pooled prompts daily, all 4
    // engines, 10 workspaces, 15 seats (+$10) + unlimited client viewers, 25k crawl.
    maxArticlesPerMonth: 300,
    articleLimitType: 'monthly',
    maxAiTrackerPromptsPerMonth: 100,
    aiTrackerPromptLimitType: 'monthly',
    maxAiTrackerMonitors: null,  // unlimited
    maxAiTrackerPlatforms: 4,
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
    maxCrawlPages: 25000,
    maxSeats: 15,
    extraSeatPrice: 10,
    clientViewers: null,     // unlimited
    supportTier: 'slack',
    creditsPerMonth: 30000, // Phase 7: Table-1 Agency allocation
    creditLimitType: 'monthly',
    contentVersionHistoryDays: 365, // v4.1: 12 months
    custom: {
      // White-label entitlement — gates BrandConfig (custom branding),
      // and later tenant domains + per-tenant email (Phases 8-12).
      whiteLabel: true,
      // SaaS mode entitlement — gates agencies rebilling their own clients
      // via Stripe Connect (Phase 16). Folds into the existing agency tier.
      saasMode: true,
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
