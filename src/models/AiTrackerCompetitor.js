const mongoose = require('mongoose');

const aiTrackerCompetitorSchema = new mongoose.Schema({
  trackerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiTracker',
    required: true,
  },
  name: { type: String, required: true, trim: true },
  isOwn: { type: Boolean, default: false },
}, { timestamps: true });

aiTrackerCompetitorSchema.index({ trackerId: 1 });

module.exports = mongoose.model('AiTrackerCompetitor', aiTrackerCompetitorSchema);
