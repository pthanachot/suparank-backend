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
    name: { type: String, trim: true, maxlength: 50, default: 'My Workspace' },
    color: { type: String, default: '#6366F1' },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

workspaceSchema.index({ userId: 1, workspaceNumber: 1 });
workspaceSchema.index({ userId: 1, name: 1 }, { unique: true });
workspaceSchema.index({ userId: 1, isDefault: 1 });

// Generate random 6-digit workspace number (100000–999999)
workspaceSchema.statics.getNextNumber = async function () {
  for (let i = 0; i < 10; i++) {
    const num = Math.floor(100000 + Math.random() * 900000);
    const exists = await this.findOne({ workspaceNumber: num });
    if (!exists) return num;
  }
  // Extremely unlikely fallback: use counter
  const counter = await Counter.findByIdAndUpdate(
    'workspaceNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
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
