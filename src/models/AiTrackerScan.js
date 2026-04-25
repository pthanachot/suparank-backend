const mongoose = require('mongoose');

const platformResultSchema = new mongoose.Schema({
  platformId: { type: String, required: true },
  mentioned: { type: Boolean, default: false },
  tier: {
    type: String,
    enum: ['top', 'mentioned', 'not_mentioned'],
    default: 'not_mentioned',
  },
  cited: { type: Boolean, default: false },
  citedFrom: { type: String, default: null },
  aiResponse: { type: String, default: '' },
}, { _id: false });

const promptResultSchema = new mongoose.Schema({
  promptId: { type: mongoose.Schema.Types.ObjectId, required: true },
  prompt: { type: String, required: true },
  platforms: { type: [platformResultSchema], default: [] },
}, { _id: false });

const competitorResultSchema = new mongoose.Schema({
  competitorId: { type: mongoose.Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  mentions: { type: Number, default: 0 },
  citations: { type: Number, default: 0 },
  visibility: { type: Number, default: 0 },
}, { _id: false });

const aiTrackerScanSchema = new mongoose.Schema({
  trackerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiTracker',
    required: true,
  },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ['running', 'ready', 'failed'],
    default: 'running',
  },
  results: { type: [promptResultSchema], default: [] },
  competitorResults: { type: [competitorResultSchema], default: [] },
}, { timestamps: true });

aiTrackerScanSchema.index({ trackerId: 1, completedAt: -1 });

module.exports = mongoose.model('AiTrackerScan', aiTrackerScanSchema);
