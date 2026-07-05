const mongoose = require('mongoose');
const Counter = require('./Counter');

const workspaceSchema = new mongoose.Schema(
  {
    workspaceNumber: { type: Number, required: true, unique: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
      // Links workspace to an organization. null = personal (legacy, pre-migration).
    },
    name: { type: String, trim: true, maxlength: 50, default: 'My Workspace' },
    color: { type: String, default: '#6366F1' },
    isDefault: { type: Boolean, default: false },
    members: {
      type: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          email: { type: String, required: true, lowercase: true, trim: true },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      validate: [arr => arr.length <= 3, 'Maximum 3 members allowed per workspace'],
    },

    // Downgrade locking — locked workspaces are inaccessible until the org upgrades
    locked: { type: Boolean, default: false },

    // Client-billing lock (Phase 16) — SEPARATE from `locked`, which
    // downgradeService owns for tier downgrades. Set true when this workspace's
    // agency-billed ClientSubscription goes past_due/canceled; access is
    // suspended independently of any tier downgrade.
    // NOTE: access requires BOTH `locked !== true` AND `clientLocked !== true`
    // (the sibling workstreams + listWorkspaces filter enforce this).
    clientLocked: { type: Boolean, default: false },
    clientLockedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

workspaceSchema.index({ userId: 1, workspaceNumber: 1 });
workspaceSchema.index({ userId: 1, name: 1 }, { unique: true });
workspaceSchema.index({ userId: 1, isDefault: 1 });
workspaceSchema.index({ 'members.userId': 1 });

// Generate random 6-digit workspace number (100000–999999).
// Accepts an optional Mongoose session so callers inside a transaction read
// their own writes consistently. NOTE: this only proposes a free number — the
// unique index on workspaceNumber is the real guard, so callers that create
// concurrently must retry on a duplicate-key (11000) collision.
workspaceSchema.statics.getNextNumber = async function (session = null) {
  for (let i = 0; i < 10; i++) {
    const num = Math.floor(100000 + Math.random() * 900000);
    const exists = await this.findOne({ workspaceNumber: num }).session(session);
    if (!exists) return num;
  }
  // Extremely unlikely fallback: use counter
  const counter = await Counter.findByIdAndUpdate(
    'workspaceNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session }
  );
  return counter.seq + 100000;
};

// Find or create default workspace for a user
workspaceSchema.statics.findOrCreateForUser = async function (userId) {
  let workspace = await this.findOne({ userId });
  if (!workspace) {
    const workspaceNumber = await this.getNextNumber();
    workspace = await this.create({ workspaceNumber, userId, isDefault: true });
  }
  return workspace;
};

module.exports = mongoose.model('Workspace', workspaceSchema);
