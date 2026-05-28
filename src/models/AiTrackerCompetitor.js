const mongoose = require('mongoose');

const aiTrackerCompetitorSchema = new mongoose.Schema({
  trackerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiTracker',
    required: true,
  },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  isOwn: { type: Boolean, default: false },
}, { timestamps: true });

aiTrackerCompetitorSchema.index({ trackerId: 1 });
aiTrackerCompetitorSchema.index({ trackerId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('AiTrackerCompetitor', aiTrackerCompetitorSchema);
