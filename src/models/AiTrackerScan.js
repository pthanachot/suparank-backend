const mongoose = require('mongoose');

const platformResultSchema = new mongoose.Schema({
  platformId: { type: String, required: true },
  mentioned: { type: Boolean, default: false },
  position: { type: Number, default: null },        // 1-10 scale (1=best), replaces normalizedPosition
  cited: { type: Boolean, default: false },
  citationCount: { type: Number, default: 0 },      // unique citation URL count
  citedUrls: { type: [String], default: [] },
  brandRanking: {
    type: [{
      brandName: { type: String, required: true },
      isTargetBrand: { type: Boolean, default: false },
      mentionCount: { type: Number, default: 1 },
    }],
    default: [],
  },
  aiResponse: { type: String, default: '' },
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative', null], default: null },
  sentimentScore: { type: Number, default: null },
  error: { type: Boolean, default: false },
  fanoutQueries: { type: [String], default: [] },
  // F11-02: when ChatGPT's Responses API fails and we fall back to Chat
  // Completions (which doesn't expose web_search calls), fanoutQueries is
  // necessarily empty. This flag lets the UI distinguish "no fanout
  // captured because of fallback" from "no fanout because the LLM didn't
  // search". Default false so existing scans don't display the warning.
  fanoutUnavailable: { type: Boolean, default: false },
  // F2-10: ChatGPT can fall back from Responses API to Chat Completions,
  // which uses a different model. Tracking the variant lets the dashboard
  // disclose model heterogeneity for honest cross-call comparisons.
  modelVariant: { type: String, default: null },
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
  // Phase 3 (client reports): the scan engine has ALWAYS set isOwn on the
  // own-brand row (runScan's ownBrandResult), but strict casting silently
  // stripped it here — every isOwn read on persisted scans was dead code
  // falling back to isSameBrand name matching. Declaring it makes new scans
  // persist the flag; readers must keep the name fallback for older scans.
  isOwn: { type: Boolean, default: false },
}, { _id: false });

const detectedBrandSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mentionCount: { type: Number, default: 1 },
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
  detectedBrands: { type: [detectedBrandSchema], default: [] },
}, { timestamps: true });

aiTrackerScanSchema.index({ trackerId: 1, completedAt: -1 });
aiTrackerScanSchema.index({ trackerId: 1, status: 1, completedAt: -1 });

module.exports = mongoose.model('AiTrackerScan', aiTrackerScanSchema);
