const mongoose = require('mongoose');

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

    // Core content
    title: { type: String, default: 'Untitled' },
    slug: { type: String, default: '' },
    description: { type: String, default: '' },
    blocks: [blockSchema],

    // SEO & metrics
    targetKeyword: { type: String, default: '' },
    score: { type: Number, default: 0, min: 0, max: 100 },
    wordCount: { type: Number, default: 0 },

    // Organization
    status: {
      type: String,
      enum: ['draft', 'optimizing', 'published', 'scheduled'],
      default: 'draft',
    },
    folder: { type: String, default: '' },
    platform: { type: String, default: '' },

    // Version history
    versions: {
      type: [versionSnapshotSchema],
      default: [],
      validate: [arr => arr.length <= 10, 'Maximum 10 version snapshots allowed'],
    },

    // Scheduling
    publishedAt: Date,
    scheduledAt: Date,
  },
  { timestamps: true }
);

// Compound indexes
contentSchema.index({ userId: 1, status: 1 });
contentSchema.index({ userId: 1, folder: 1 });
contentSchema.index({ userId: 1, updatedAt: -1 });

// List contents for a user (used by workspace dashboard)
contentSchema.statics.findByUser = function (userId, { status, folder } = {}) {
  const query = { userId };
  if (status) query.status = status;
  if (folder) query.folder = folder;
  return this.find(query).sort({ updatedAt: -1 });
};

// Summary projection (for listing, excludes heavy blocks/versions)
contentSchema.statics.findSummariesByUser = function (userId, { status, folder } = {}) {
  const query = { userId };
  if (status) query.status = status;
  if (folder) query.folder = folder;
  return this.find(query)
    .select('title slug description targetKeyword score wordCount status folder platform publishedAt scheduledAt createdAt updatedAt')
    .sort({ updatedAt: -1 });
};

module.exports = mongoose.model('Content', contentSchema);
