const mongoose = require('mongoose');

const resetTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
  },
  hashedToken: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

resetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
resetTokenSchema.index({ hashedToken: 1 });

module.exports = mongoose.model('ResetToken', resetTokenSchema);
