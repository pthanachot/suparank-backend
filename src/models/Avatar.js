const mongoose = require('mongoose');

const uploadSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    b2Key: { type: String, required: true },
    size: { type: Number, required: true },
    words: { type: Number, default: 0 },
    summary: { type: String, default: '' },
    status: { type: String, enum: ['learning', 'learned', 'failed'], default: 'learning' },
  },
  { _id: true }
);

const avatarSchema = new mongoose.Schema(
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
    filename: { type: String, default: 'avatar.md' },
    b2Key: { type: String, default: '' },
    content: { type: String, default: '' },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    emoji: { type: String, default: '✍️' },
    role: { type: String, trim: true, maxlength: 100, default: '' },
    experience: { type: String, trim: true, maxlength: 50, default: '' },
    tagline: { type: String, trim: true, maxlength: 200, default: '' },
    traits: { type: [String], default: [] },
    writingQuirks: { type: String, default: '' },
    toneOverrides: {
      formality: { type: Number, default: null, min: 0, max: 100 },
      warmth: { type: Number, default: null, min: 0, max: 100 },
      humor: { type: Number, default: null, min: 0, max: 100 },
    },
    vocabulary: {
      uses: { type: [String], default: [] },
      avoids: { type: [String], default: [] },
    },
    openingStyle: { type: String, default: '' },
    sample: { type: String, default: '' },
    background: { type: String, trim: true, default: '' },
    avatarImage: { type: String, default: '' },
    generatedSample: { type: String, default: '' },
    generatedComparison: { type: String, default: '' },
    previewsStale: { type: Boolean, default: false },
    previewsGenerating: { type: Boolean, default: false },
    previewRegenCount: { type: Number, default: 0 },
    previewRegenWindowStart: { type: Date, default: null },
    active: { type: Boolean, default: true },
    uploads: {
      type: [uploadSchema],
      default: [],
      validate: [arr => arr.length <= 5, 'Maximum 5 uploads per avatar'],
    },
  },
  { timestamps: true }
);

avatarSchema.index({ workspace: 1, name: 1 });

module.exports = mongoose.model('Avatar', avatarSchema);
