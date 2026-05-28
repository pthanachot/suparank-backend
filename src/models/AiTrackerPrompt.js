const mongoose = require('mongoose');

const aiTrackerPromptSchema = new mongoose.Schema({
  trackerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiTracker',
    required: true,
  },
  prompt: { type: String, required: true, trim: true, maxlength: 500 },
  models: { type: [{ type: String, enum: ['chatgpt', 'gemini', 'claude', 'perplexity'] }], default: ['chatgpt', 'gemini', 'claude', 'perplexity'] },
  frequency: { type: String, enum: ['Daily', 'Weekly', 'Bi-weekly', 'Monthly'], default: 'Weekly' },
  active: { type: Boolean, default: true },
  lastScannedAt: { type: Date, default: null },

  // Downgrade locking
  locked: { type: Boolean, default: false },
  createdOnPlan: { type: String, enum: ['free', 'paid'], default: 'free' },
}, { timestamps: true });

aiTrackerPromptSchema.index({ trackerId: 1 });
aiTrackerPromptSchema.index({ trackerId: 1, prompt: 1 }, { unique: true });
aiTrackerPromptSchema.index({ trackerId: 1, active: 1 });

module.exports = mongoose.model('AiTrackerPrompt', aiTrackerPromptSchema);
