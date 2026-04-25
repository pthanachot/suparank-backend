const mongoose = require('mongoose');

const serpResultSchema = new mongoose.Schema({
  position: { type: Number },
  domain: { type: String },
  title: { type: String },
  link: { type: String },
  snippet: { type: String },
}, { _id: false });

const paaQuestionSchema = new mongoose.Schema({
  question: { type: String },
  snippet: { type: String },
  link: { type: String },
}, { _id: false });

const keywordDetailSchema = new mongoose.Schema({
  keyword: { type: String, required: true, trim: true, lowercase: true },
  country: { type: String, default: 'US', uppercase: true },
  serpResults: { type: [serpResultSchema], default: [] },
  paaQuestions: { type: [paaQuestionSchema], default: [] },
  fetchedAt: { type: Date, default: Date.now },
}, { timestamps: true });

keywordDetailSchema.index({ keyword: 1, country: 1 }, { unique: true });
keywordDetailSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 1209600 });

module.exports = mongoose.model('KeywordDetail', keywordDetailSchema);
