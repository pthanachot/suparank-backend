const mongoose = require('mongoose');
const Counter = require('./Counter');

/* ───────────── sub-schemas (match frontend editor types) ───────────── */

const faqItemSchema = new mongoose.Schema(
  { question: String, answer: String },
  { _id: false }
);

const ctaDataSchema = new mongoose.Schema(
  { buttonText: String, url: String, style: { type: String, enum: ['primary', 'outline'] } },
  { _id: false }
);

const codeDataSchema = new mongoose.Schema(
  { language: String, code: String },
  { _id: false }
);

const tableDataSchema = new mongoose.Schema(
  {
    headers: [String],
    rows: [[String]],
    caption: String,
    columnAligns: [{ type: String, enum: ['left', 'center', 'right'] }],
    showHeader: Boolean,
    stripedRows: Boolean,
  },
  { _id: false }
);

const blockSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'ol', 'quote', 'img', 'toc', 'faq', 'cta', 'table', 'code', 'divider'],
    },
    text: { type: String, default: '' },
    src: String,
    alt: String,
    width: Number,
    align: { type: String, enum: ['left', 'center', 'right', 'justify'] },
    faqItems: [faqItemSchema],
    ctaData: ctaDataSchema,
    tableData: tableDataSchema,
    codeData: codeDataSchema,
  },
  { _id: false }
);

const versionSnapshotSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: String,
    timestamp: { type: Number, required: true },
    blocks: [blockSchema],
  },
  { _id: false }
);

/* ───────────── main content schema ───────────── */

const contentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    contentNumber: { type: Number, required: true, unique: true },

    // Core content
    title: { type: String, default: 'Untitled' },
    slug: { type: String, default: '' },
    description: { type: String, default: '' },
    blocks: [blockSchema],

    // SEO & metrics
    targetKeywords: {
      type: [String],
      default: [],
      validate: [arr => arr.length <= 5, 'Maximum 5 keywords allowed'],
    },
    country: { type: String, default: '' },
    device: { type: String, enum: ['desktop', 'mobile', ''], default: '' },
    score: { type: Number, default: 0, min: 0, max: 100 },
    wordCount: { type: Number, default: 0 },

    // Organization
    status: {
      type: String,
      enum: ['draft', 'optimizing', 'done', 'published', 'scheduled'],
      default: 'draft',
    },
    folder: { type: String, default: '' },
    platform: { type: String, default: '' },

    // Wizard selections (from article creation flow)
    contentType: {
      type: String,
      enum: ['serp-based', 'blog-post', 'landing-page', 'comparison', 'listicle',
             'product-page', 'category-page', 'service-page', 'llm-optimized', ''],
      default: '',
    },
    contentContext: { type: String, default: '' },
    targetWordCount: { type: Number, default: 0 },
    writingMode: {
      type: String,
      enum: ['write', 'generate', ''],
      default: '',
    },

    // Version history
    versions: {
      type: [versionSnapshotSchema],
      default: [],
      validate: [arr => arr.length <= 10, 'Maximum 10 version snapshots allowed'],
    },

    // Engine analysis results (persisted from Go engine)
    analysisStatus: {
      type: String,
      enum: ['idle', 'pending', 'analyzing', 'ready', 'failed'],
      default: 'idle',
    },
    analysisError: { type: String, default: '' },
    analyzedAt: Date,

    benchmark: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    intent: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    competitors: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    relatedSearches: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    peopleAlsoAsk: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    keywordVolumes: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    aiFormatData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    contentBrief: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    competitorPages: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    recommendedOutline: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    aiConversations: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    aiAnswerAnalysis: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Scheduling
    publishedAt: Date,
    scheduledAt: Date,
  },
  { timestamps: true }
);

// Compound indexes
contentSchema.index({ workspaceId: 1, contentNumber: 1 });
contentSchema.index({ workspaceId: 1, status: 1 });
contentSchema.index({ workspaceId: 1, folder: 1 });
contentSchema.index({ workspaceId: 1, updatedAt: -1 });

// Generate random 8-digit content number (10000000–99999999)
contentSchema.statics.getNextContentNumber = async function () {
  for (let i = 0; i < 10; i++) {
    const num = Math.floor(10000000 + Math.random() * 90000000);
    const exists = await this.findOne({ contentNumber: num });
    if (!exists) return num;
  }
  // Extremely unlikely fallback: use counter
  const counter = await Counter.findByIdAndUpdate(
    'contentNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq + 10000000;
};

// Find by workspace and contentNumber
contentSchema.statics.findByNumber = function (workspaceId, contentNumber) {
  return this.findOne({ workspaceId, contentNumber: Number(contentNumber) });
};

// List contents for a workspace (used by workspace dashboard)
contentSchema.statics.findByWorkspace = function (workspaceId, { status, folder } = {}) {
  const query = { workspaceId };
  if (status) query.status = status;
  if (folder) query.folder = folder;
  return this.find(query).sort({ updatedAt: -1 });
};

// Summary projection (for listing, excludes heavy blocks/versions)
contentSchema.statics.findSummariesByWorkspace = function (workspaceId, { status, folder } = {}) {
  const query = { workspaceId };
  if (status) query.status = status;
  if (folder) query.folder = folder;
  return this.find(query)
    .select('contentNumber title slug description targetKeywords country device score wordCount status folder platform analysisStatus analyzedAt publishedAt scheduledAt createdAt updatedAt')
    .sort({ updatedAt: -1 });
};

module.exports = mongoose.model('Content', contentSchema);
