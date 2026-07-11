const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    userAgent: String,
    ip: String,
    lastActivity: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['active', 'ended'],
      default: 'active',
    },

    // ─── Impersonation (Phase 19B) ──────────────────────────────
    // Set ONLY on sessions minted by a platform admin's "login as". `userId` is
    // the TARGET being impersonated; `impersonatorId` is the real admin; and
    // `organizationId` scopes it (the audit home for start/stop). A normal login
    // leaves all three null, so existing behaviour is unchanged. Because the
    // session lives under the target's `userId`, it appears in the target's
    // active sessions and is killed by "revoke all sessions" — impersonation is
    // always revocable. `expiresAt` mirrors the short-lived token's expiry.
    impersonatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1, status: 1 });

sessionSchema.methods.end = function () {
  this.status = 'ended';
  return this.save();
};

sessionSchema.statics.findActiveSessions = function (userId) {
  return this.find({ userId, status: 'active' }).sort({ lastActivity: -1 });
};

module.exports = mongoose.model('Session', sessionSchema);
