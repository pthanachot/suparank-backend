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
    name: { type: String, default: 'My Workspace' },
  },
  { timestamps: true }
);

workspaceSchema.index({ userId: 1, workspaceNumber: 1 });

// Generate next 6-digit workspace number (100000–999999)
workspaceSchema.statics.getNextNumber = async function () {
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
    workspace = await this.create({ workspaceNumber, userId });
  }
  return workspace;
};

module.exports = mongoose.model('Workspace', workspaceSchema);
