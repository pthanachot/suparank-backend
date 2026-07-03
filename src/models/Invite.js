const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Pending organization invite for users who don't have an account yet
 * (or haven't accepted). The emailed link carries the RAW token; only its
 * SHA-256 hash is stored. Accepting converts the invite into an OrgMember
 * (+ WorkspaceMember rows when accessScope is 'assigned') and deletes it.
 *
 * Expired invites are auto-removed by the TTL index on expiresAt.
 */
const inviteSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    role: {
      type: String,
      required: true,
      // Org-wide roles for accessScope 'all'; may also be 'client' for 'assigned'
      enum: ['admin', 'editor', 'viewer', 'client'],
    },
    accessScope: {
      type: String,
      enum: ['all', 'assigned'],
      default: 'all',
    },
    workspaceIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' }],
      default: [],
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// One pending invite per email per org (re-inviting replaces it)
inviteSchema.index({ organizationId: 1, email: 1 }, { unique: true });
// Auto-delete once expired
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

inviteSchema.statics.hashToken = function (rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

inviteSchema.statics.findValidByToken = function (rawToken) {
  return this.findOne({
    tokenHash: this.hashToken(rawToken),
    expiresAt: { $gt: new Date() },
  });
};

module.exports = mongoose.model('Invite', inviteSchema);
