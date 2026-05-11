const mongoose = require('mongoose');

/**
 * TierConfig — stores pricing tier limits in MongoDB.
 *
 * One document per tier (free, standard, professional, agency).
 * Values can be edited directly in the database without code changes.
 * Seeded by src/scripts/seedTierConfig.js (idempotent, won't overwrite manual edits).
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
    maxAiTrackerPlatforms: { type: Number, default: 2 },
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

    // ── Sites / GSC ──
    maxSites: { type: Number, default: null }, // null = unlimited

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

    // ── Future extensibility ──
    custom: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TierConfig', tierConfigSchema);
