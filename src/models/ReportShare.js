const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Public share link for a ReportSnapshot (Phase 14).
 *
 * The shared URL carries the RAW token; only its SHA-256 hash is stored
 * (mirrors Invite.js). Expired shares are auto-removed by the TTL index.
 *
 * `internal: true` rows are short-lived (~15 min) tokens minted by
 * reportPdfService so headless Chrome can load the public report page —
 * they are excluded from user-facing "is this report shared?" queries and
 * from revocation, and are deleted right after the PDF renders.
 */
const reportShareSchema = new mongoose.Schema(
  {
    reportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReportSnapshot',
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    internal: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Auto-delete once expired
reportShareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

reportShareSchema.statics.hashToken = function (rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

reportShareSchema.statics.findValidByToken = function (rawToken) {
  return this.findOne({
    tokenHash: this.hashToken(rawToken),
    expiresAt: { $gt: new Date() },
  });
};

module.exports = mongoose.model('ReportShare', reportShareSchema);
