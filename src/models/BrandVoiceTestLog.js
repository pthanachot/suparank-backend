const mongoose = require('mongoose');

const brandVoiceTestLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  createdAt: { type: Date, default: Date.now, expires: 14400 },
});

brandVoiceTestLogSchema.index({ userId: 1, createdAt: 1 });

module.exports = mongoose.model('BrandVoiceTestLog', brandVoiceTestLogSchema);
