const mongoose = require('mongoose');

const emailSendLogSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true },
    recipientCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    fromName: { type: String, default: 'SupaRank' },
    replyTo: { type: String, default: '' },
    sentBy: { type: String, default: 'admin' },
    status: {
      type: String,
      enum: ['completed', 'partial', 'failed'],
      default: 'completed',
    },
    failedRecipients: [{ type: String }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailSendLog', emailSendLogSchema);
