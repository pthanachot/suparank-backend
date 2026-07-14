const mongoose = require('mongoose');

/**
 * PublicToolUsage — per-IP daily counters for the free marketing tools.
 * Mongo-backed (not in-memory) so limits survive restarts and apply across
 * instances. One row per (ip, toolId, UTC day); TTL cleans them up.
 */
const publicToolUsageSchema = new mongoose.Schema(
  {
    // e.g. '203.0.113.7:content-score:2026-07-14'
    key: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

publicToolUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PublicToolUsage', publicToolUsageSchema);
