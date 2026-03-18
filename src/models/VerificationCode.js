const mongoose = require('mongoose');

const verificationCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    code: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['signup', 'password_reset'],
    },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

verificationCodeSchema.index({ email: 1, type: 1 });
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('VerificationCode', verificationCodeSchema);
