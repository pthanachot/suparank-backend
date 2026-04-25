const mongoose = require('mongoose');

const keywordItemSchema = new mongoose.Schema({
  keyword: { type: String, required: true },
  searchVolume: { type: Number, default: 0 },
  keywordDifficulty: { type: Number, default: 0 },
  cpc: { type: Number, default: 0 },
  searchIntent: { type: String, default: 'informational' },
  monthlySearches: { type: [Number], default: [] },
  serpFeatures: { type: [String], default: [] },
  isQuestion: { type: Boolean, default: false },
}, { _id: false });

const keywordSearchSchema = new mongoose.Schema({
  seedKeyword: { type: String, required: true, trim: true, lowercase: true },
  country: { type: String, default: 'US', uppercase: true },
  seedMetrics: { type: keywordItemSchema, default: null },
  relatedKeywords: { type: [keywordItemSchema], default: [] },
  totalCount: { type: Number, default: 0 },
  fetchedAt: { type: Date, default: Date.now },
}, { timestamps: true });

keywordSearchSchema.index({ seedKeyword: 1, country: 1 }, { unique: true });
keywordSearchSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 1209600 });

module.exports = mongoose.model('KeywordSearch', keywordSearchSchema);
