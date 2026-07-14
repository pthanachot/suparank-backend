const mongoose = require('mongoose');

/**
 * PublicToolCache — result cache for the free marketing tools
 * (/api/public/tools/*). Keyed by a normalized input hash so duplicate
 * requests (the common case when a tool page gets shared) cost $0.
 *
 * Rows expire via the TTL index on `expiresAt` — callers choose the TTL
 * per tool (24h for visibility checks, 7 days for briefs).
 */
const publicToolCacheSchema = new mongoose.Schema(
  {
    // e.g. 'content-score:v1:<sha256-of-normalized-input>'
    cacheKey: { type: String, required: true, unique: true },
    toolId: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: Mongo removes docs once expiresAt passes.
publicToolCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PublicToolCache', publicToolCacheSchema);
