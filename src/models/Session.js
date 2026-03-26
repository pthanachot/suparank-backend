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
