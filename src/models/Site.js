const mongoose = require('mongoose');

/**
 * Site — represents a website connected to Google Search Console.
 *
 * TODO: Not yet implemented. This is a placeholder model.
 *
 * Navigation item exists in the frontend sidebar ("Sites").
 * Backend GSC integration is not yet built.
 * See TierConfig.maxSites for per-tier limits.
 */

const siteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
      // The site URL as registered in GSC (e.g., "https://example.com/")
    },
    gscPropertyId: {
      type: String,
      default: null,
      // Google Search Console property identifier.
    },
    verified: {
      type: Boolean,
      default: false,
    },
    lastSyncAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

siteSchema.index({ organizationId: 1, url: 1 }, { unique: true });

// TODO: Add instance methods:
//   syncFromGSC()            — fetch performance data from Google Search Console API
//   getPerformanceData(range) — return cached performance metrics for a date range
//
// TODO: Add GSC OAuth integration and API client

module.exports = mongoose.model('Site', siteSchema);
