const mongoose = require('mongoose');

const brandVoiceSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: { type: String, required: true, default: 'Default' },
    active: { type: Boolean, default: true },
    locked: { type: Boolean, default: false },
    createdOnPlan: { type: String, enum: ['free', 'paid'], default: 'free' },
    filename: { type: String, default: 'brand_voice.md' },
    b2Key: { type: String, default: '' },
    content: { type: String, default: '' },
    settings: {
      formality: { type: Number, default: 50, min: 0, max: 100 },
      warmth: { type: Number, default: 50, min: 0, max: 100 },
      humor: { type: Number, default: 50, min: 0, max: 100 },
      technicality: { type: Number, default: 50, min: 0, max: 100 },
      perspective: { type: String, default: 'you', enum: ['you', 'we', 'they'] },
      sentenceStyle: { type: String, default: 'mixed', enum: ['short', 'mixed', 'detailed'] },
      formattingHabits: { type: [String], default: [] },
      useWords: { type: [String], default: [] },
      avoidWords: { type: [String], default: [] },
    },
  },
  { timestamps: true }
);

brandVoiceSchema.index({ workspace: 1, active: 1 });

module.exports = mongoose.model('BrandVoice', brandVoiceSchema);
