const mongoose = require('mongoose');

const featureFlagSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // camelCase to match Permission.resource names:
      // 'workspace', 'content', 'analysis', 'aiChat', 'aiTracker',
      // 'keywords', 'billing', 'brandVoice', 'members', etc.
    },
    displayName: { type: String, required: true },
    description: { type: String, default: '' },
    enabled: {
      type: Boolean,
      default: true,
      // Master switch — if false, feature is completely disabled.
    },
    implemented: {
      type: Boolean,
      default: true,
      // false = feature code is not done yet (placeholder flag).
      // Routes will return 404 "Feature coming soon".
    },
    conditions: {
      requiresAuth: { type: Boolean, default: true },
      minimumPlan: {
        type: String,
        default: null,
        // null = any plan. 'pro', 'enterprise' = requires that subscription tier.
      },
      allowedRoles: {
        type: [String],
        default: [],
        // Empty = all roles allowed. ['owner', 'admin'] = restricted to those roles.
        // This is feature-level gating, separate from the Permission model.
      },
      maxUsagePerDay: {
        type: Number,
        default: null,
        // null = unlimited.
      },
      custom: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
        // Per-feature custom conditions. Examples:
        //   aiTracker: { maxMonitors: 1 }
        //   keywords:  { maxSearchesPerDay: 10 }
        //   members:   { maxMembers: 3 }
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeatureFlag', featureFlagSchema);
