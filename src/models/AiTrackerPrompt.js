const mongoose = require('mongoose');

const aiTrackerPromptSchema = new mongoose.Schema({
  trackerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AiTracker',
    required: true,
  },
  prompt: { type: String, required: true, trim: true, maxlength: 500 },
  // Semantic: per-prompt platform restriction. The scan engine
  // (aiTrackerScanEngine.js, runScan inner loop) treats BOTH `[]` and the
  // full platform list as "no restriction — scan on every available platform."
  // A non-empty proper subset restricts the prompt to that subset. The default
  // here is the full list rather than `[]` for API-shape backward compatibility
  // — older frontend code reads `models` as a populated array.
  models: { type: [{ type: String, enum: ['chatgpt', 'gemini', 'claude', 'perplexity'] }], default: ['chatgpt', 'gemini', 'claude', 'perplexity'] },
  frequency: { type: String, enum: ['Daily', 'Weekly', 'Bi-weekly', 'Monthly'], default: 'Weekly' },
  active: { type: Boolean, default: true },
  lastScannedAt: { type: Date, default: null },

  // Wave 1 (§4c-2): where the prompt text came from — 'suggested' when the
  // user accepted an AI-suggested prompt during setup, 'manual' otherwise.
  // Measures suggestion quality (accepted/offered lives client-side; this is
  // the durable per-prompt half). Frontend sends suggestedPrompts in Wave 3;
  // until then everything defaults 'manual'.
  source: { type: String, enum: ['manual', 'suggested'], default: 'manual' },

  // Downgrade locking
  locked: { type: Boolean, default: false },
  createdOnPlan: { type: String, enum: ['free', 'paid'], default: 'free' },
}, { timestamps: true });

aiTrackerPromptSchema.index({ trackerId: 1 });
aiTrackerPromptSchema.index({ trackerId: 1, prompt: 1 }, { unique: true });
aiTrackerPromptSchema.index({ trackerId: 1, active: 1 });

module.exports = mongoose.model('AiTrackerPrompt', aiTrackerPromptSchema);
