const mongoose = require('mongoose');

const orgMemberSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      // Denormalized from Organization.ownerId for fast permission checks.
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
      // 'owner' is NEVER stored — it's implicit via Organization.ownerId
    },
    status: {
      type: String,
      enum: ['active', 'pending'],
      default: 'active',
    },
    accessScope: {
      type: String,
      enum: ['all', 'assigned'],
      default: 'all',
      // 'all'      — role applies to every workspace in the org (legacy behavior)
      // 'assigned' — access only to workspaces with a WorkspaceMember row;
      //              the per-workspace role comes from that row, not this one.
    },
    invitedAt: { type: Date, default: Date.now },

    // Downgrade locking — locked members are suspended until the org upgrades
    locked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One membership per user per organization
orgMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
orgMemberSchema.index({ ownerId: 1, userId: 1 });
// Fast lookup: "which orgs am I a member of?"
orgMemberSchema.index({ userId: 1, status: 1 });

// ─── Static methods ─────────────────────────────────────────

/**
 * Find a single membership by owner (or null).
 */
orgMemberSchema.statics.findMembership = function (ownerId, userId) {
  return this.findOne({ ownerId, userId, status: 'active', locked: { $ne: true } });
};

/**
 * Find a single membership by organization (or null).
 */
orgMemberSchema.statics.findMembershipByOrg = function (organizationId, userId) {
  return this.findOne({ organizationId, userId, status: 'active', locked: { $ne: true } });
};

/**
 * Find all orgs this user belongs to (active memberships).
 */
orgMemberSchema.statics.findMembershipsForUser = function (userId) {
  return this.find({ userId, status: 'active', locked: { $ne: true } });
};

module.exports = mongoose.model('OrgMember', orgMemberSchema);
