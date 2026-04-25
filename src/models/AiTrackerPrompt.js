const mongoose = require('mongoose');

const aiTrackerPromptSchema = new mongoose.Schema({
  trackerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiTracker',
    required: true,
  },
  prompt: { type: String, required: true, trim: true },
  models: { type: [String], default: ['chatgpt', 'gemini', 'claude', 'perplexity'] },
  frequency: { type: String, enum: ['Weekly', 'Bi-weekly', 'Monthly'], default: 'Weekly' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

aiTrackerPromptSchema.index({ trackerId: 1 });
aiTrackerPromptSchema.index({ trackerId: 1, prompt: 1 }, { unique: true });

module.exports = mongoose.model('AiTrackerPrompt', aiTrackerPromptSchema);
