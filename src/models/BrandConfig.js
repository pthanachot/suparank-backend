const mongoose = require('mongoose');

/**
 * Per-organization white-label branding (white-label Phase 5).
 *
 * One document per agency org, plus a single platform-default document
 * identified by scopeKey 'platform' (NOT organizationId: null — a sparse
 * unique index on null values is unreliable, so scopeKey is the unique
 * identity: 'platform' or the org id string).
 *
 * Resolution (brandService): hardcoded defaults ← platform doc ← org doc
 * (org overrides apply only while the org's tier has custom.whiteLabel).
 */
const brandConfigSchema = new mongoose.Schema(
  {
    scopeKey: {
      type: String,
      required: true,
      unique: true, // 'platform' | '<organizationId>'
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null, // null = platform default
      index: true,
    },

    // Identity
    productName: { type: String, trim: true, maxlength: 40, default: '' },
    logoUrl: { type: String, trim: true, default: '' },
    logoIconUrl: { type: String, trim: true, default: '' }, // square mark
    faviconUrl: { type: String, trim: true, default: '' },

    // Theme — single seed color; the frontend derives the full scale
    primaryColor: { type: String, trim: true, default: '' }, // '#RRGGBB'

    // Email identity (sender domain verification lands in Phase 11)
    emailFromName: { type: String, trim: true, maxlength: 60, default: '' },
    emailDomain: {
      domain: { type: String, trim: true, lowercase: true, default: '' },
      status: {
        type: String,
        enum: ['unverified', 'pending', 'verified'],
        default: 'unverified',
      },
      providerId: { type: String, default: '' },
    },

    // Agency-facing links & copy
    supportEmail: { type: String, trim: true, lowercase: true, default: '' },
    termsUrl: { type: String, trim: true, default: '' },
    privacyUrl: { type: String, trim: true, default: '' },
    loginCopy: {
      headline: { type: String, trim: true, maxlength: 80, default: '' },
      subline: { type: String, trim: true, maxlength: 160, default: '' },
    },

    // 'Powered by' attribution toggle. NO default — an absent field means
    // 'inherit from platform'; a stored false is an explicit override
    // (brandService._merge copies any stored boolean).
    hideAttribution: { type: Boolean },
  },
  { timestamps: true }
);

brandConfigSchema.statics.scopeKeyFor = function (organizationId) {
  return organizationId ? String(organizationId) : 'platform';
};

module.exports = mongoose.model('BrandConfig', brandConfigSchema);
