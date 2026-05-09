const mongoose = require('mongoose');

const orgMemberSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      // The "organization" = the owner's account.
      // All workspaces under this owner are accessible to the member.
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      // Denormalized from User for display — avoids extra lookups.
    },
    role: {
      type: String,
      required: true,
      default: 'viewer',
      // References Role.name: 'admin' | 'editor' | 'viewer'
      // 'owner' is NEVER stored — it's implicit when workspace.userId === req.user.userId
    },
    status: {
      type: String,
      enum: ['active', 'pending'],
      default: 'active',
    },
    invitedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One membership per user per organization
orgMemberSchema.index({ ownerId: 1, userId: 1 }, { unique: true });
// Fast lookup: "which orgs am I a member of?"
orgMemberSchema.index({ userId: 1, status: 1 });

// ─── Static methods ─────────────────────────────────────────

/**
 * Find a single membership (or null).
 */
orgMemberSchema.statics.findMembership = function (ownerId, userId) {
  return this.findOne({ ownerId, userId, status: 'active' });
};

/**
 * Find all orgs this user belongs to (active memberships).
 */
orgMemberSchema.statics.findMembershipsForUser = function (userId) {
  return this.find({ userId, status: 'active' });
};

module.exports = mongoose.model('OrgMember', orgMemberSchema);
