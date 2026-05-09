const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      index: true,
      // references Role.name: 'owner', 'admin', 'editor', 'viewer'
    },
    resource: {
      type: String,
      required: true,
      // 'workspace', 'content', 'members', 'billing',
      // 'analysis', 'aiChat', 'aiTracker', 'keywords', 'brandVoice'
    },
    action: {
      type: String,
      required: true,
      // 'create', 'read', 'update', 'delete', 'use', 'manage', 'changeRole', 'comment'
    },
    allowed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One permission entry per role+resource+action combination
permissionSchema.index({ role: 1, resource: 1, action: 1 }, { unique: true });

module.exports = mongoose.model('Permission', permissionSchema);
