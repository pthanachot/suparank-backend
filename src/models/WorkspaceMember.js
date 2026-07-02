const mongoose = require('mongoose');

/**
 * Per-workspace membership — scopes a user's access to specific workspaces
 * within an organization. Only consulted for OrgMembers whose
 * accessScope is 'assigned'; members with accessScope 'all' keep their
 * org-wide role and never need rows here.
 *
 * This is the foundation for agency → client isolation: one org (agency)
 * holds many workspaces (clients), and a client user is granted access
 * to exactly their own workspace.
 */
const workspaceMemberSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
      // Denormalized from Workspace.organizationId for org-wide queries.
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
      enum: ['admin', 'editor', 'viewer', 'client'],
      default: 'viewer',
      // 'owner' is NEVER stored — implicit via Organization.ownerId.
    },
    status: {
      type: String,
      enum: ['active', 'pending'],
      default: 'active',
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Downgrade locking — mirrors OrgMember.locked semantics
    locked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One membership per user per workspace
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
// Fast lookup: "which workspaces is this user assigned to in this org?"
workspaceMemberSchema.index({ organizationId: 1, userId: 1 });

// ─── Static methods ─────────────────────────────────────────

/**
 * Find a single active, unlocked membership (or null).
 */
workspaceMemberSchema.statics.findMembership = function (workspaceId, userId) {
  return this.findOne({
    workspaceId,
    userId,
    status: 'active',
    locked: { $ne: true },
  });
};

/**
 * All workspaceIds this user can access within an org (active, unlocked).
 */
workspaceMemberSchema.statics.findWorkspaceIdsForUser = async function (
  organizationId,
  userId
) {
  const rows = await this.find({
    organizationId,
    userId,
    status: 'active',
    locked: { $ne: true },
  })
    .select('workspaceId')
    .lean();
  return rows.map((r) => r.workspaceId);
};

module.exports = mongoose.model('WorkspaceMember', workspaceMemberSchema);
