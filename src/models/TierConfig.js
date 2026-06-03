const mongoose = require('mongoose');

/**
 * TierConfig — stores pricing tier limits in MongoDB.
 *
 * One document per tier (free, standard, professional, agency).
 * Synced from src/scripts/configTiers.js on every server startup.
 * To change values, edit configTiers.js and restart the server.
 *
 * null = unlimited for numeric limits.
 * limitType = 'lifetime' means the allotment is one-time (free tier);
 *             'monthly' means it resets each billing cycle.
 */

const tierConfigSchema = new mongoose.Schema(
  {
    tier: {
      type: String,
      required: true,
      unique: true,
      enum: ['free', 'standard', 'professional', 'agency'],
    },
    displayName: { type: String, required: true },
    monthlyPrice: { type: Number, default: 0 },
    yearlyPrice: { type: Number, default: 0 },

    // ── Articles ──
    maxArticlesPerMonth: { type: Number, default: null },
    articleLimitType: {
      type: String,
      enum: ['monthly', 'lifetime'],
      default: 'monthly',
    },

    // ── AI Tracker ──
    maxAiTrackerPromptsPerMonth: { type: Number, default: null },
    aiTrackerPromptLimitType: {
      type: String,
      enum: ['monthly', 'lifetime'],
      default: 'monthly',
    },
    maxAiTrackerMonitors: { type: Number, default: 1 },
    maxAiTrackerPlatforms: { type: Number, default: 2 },
    // Hard cap on active prompts per monitor. F4-15: previously, executeScan
    // did `.limit(500)` which silently truncated the back half of any
    // tracker that exceeded 500 active prompts. Enforced at addPrompt time.
    // null = unlimited.
    maxAiTrackerPromptsPerMonitor: { type: Number, default: 100 },
    aiTrackerRefreshInterval: {
      type: String,
      enum: ['daily', 'weekly'],
      default: 'weekly',
    },

    // ── Keywords ──
    maxKeywordLookupsPerMonth: { type: Number, default: null },
    keywordLimitType: {
      type: String,
      enum: ['monthly', 'lifetime'],
      default: 'monthly',
    },

    // ── Audits / Analyses ──
    maxAuditsPerMonth: { type: Number, default: null },
    auditLimitType: {
      type: String,
      enum: ['monthly', 'lifetime'],
      default: 'monthly',
    },

    // ── Brand Voice ──
    maxBrandVoices: { type: Number, default: null }, // null = unlimited

    // ── Avatars (writer personas) ──
    maxAvatars: { type: Number, default: null }, // null = unlimited

    // ── Workspaces ──
    maxWorkspaces: { type: Number, default: 1 },

    // ── Sites / GSC ──
    maxSites: { type: Number, default: null }, // null = unlimited
    sitesSyncFrequency: {
      type: String,
      enum: ['daily', 'weekly'],
      default: 'weekly',
    },

    // ── Sitemap Crawler ──
    maxSitemaps: { type: Number, default: 3 },
    maxCrawlPages: { type: Number, default: 100 },

    // ── Seats (organization members) ──
    maxSeats: { type: Number, default: 1 },
    extraSeatPrice: { type: Number, default: 0 }, // USD per extra seat per month

    // ── Credits ──
    creditsPerMonth: { type: Number, default: null },
    creditLimitType: {
      type: String,
      enum: ['monthly', 'lifetime'],
      default: 'monthly',
    },

    // ── Content Version History ──
    contentVersionHistoryDays: { type: Number, default: 7 }, // how many days of revision history to keep

    // ── Future extensibility ──
    custom: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TierConfig', tierConfigSchema);
