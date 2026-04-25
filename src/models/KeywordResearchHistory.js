const mongoose = require('mongoose');

const keywordResearchHistorySchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
  },
  seedKeyword: { type: String, required: true, trim: true, lowercase: true },
  country: { type: String, default: 'US', uppercase: true },
  searchedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Fast history listing per workspace
keywordResearchHistorySchema.index({ workspaceId: 1, searchedAt: -1 });

// Prevent duplicate entries — upsert updates searchedAt on re-search
keywordResearchHistorySchema.index({ workspaceId: 1, seedKeyword: 1, country: 1 }, { unique: true });

module.exports = mongoose.model('KeywordResearchHistory', keywordResearchHistorySchema);
