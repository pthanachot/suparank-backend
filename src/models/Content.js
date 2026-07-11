const mongoose = require('mongoose');
const Counter = require('./Counter');

/* ───────────── sub-schemas (match frontend editor types)  ───────────── */

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
      enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'ol', 'quote', 'img', 'toc', 'faq', 'cta', 'table', 'code', 'divider', 'toggle', 'embed'],
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

const commentReplySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    authorEmail: { type: String, required: true },
    authorName: String,
    createdAt: { type: Number, required: true },
  },
  { _id: false }
);

const commentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    blockId: { type: String, required: true },
    selectedText: String,
    text: { type: String, required: true },
    authorEmail: { type: String, required: true },
    authorName: String,
    createdAt: { type: Number, required: true },
    resolvedAt: Number,
    replies: { type: [commentReplySchema], default: [] },
  },
  { _id: false }
);

const auditCriterionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    score: { type: Number, required: true, min: 1, max: 10 },
    status: { type: String, enum: ['good', 'warning', 'fail'], required: true },
    feedback: { type: String, required: true },
  },
  { _id: false }
);

const auditResultSchema = new mongoose.Schema(
  {
    overallScore: { type: Number, required: true, min: 0, max: 100 },
    summary: { type: String, required: true },
    criteria: { type: [auditCriterionSchema], required: true },
    contentHash: { type: String, required: true },
    createdAt: { type: Number, required: true },
    model: { type: String, default: 'moonshotai/kimi-k2-0905' },
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
    // The existing page being optimized, when this content was started from a
    // GSC striking-distance opportunity ("improve /blog/x that ranks #12").
    // Lets the editor show/import the target page so the user improves it
    // rather than creating a second page that competes with their own.
    targetPageUrl: { type: String, default: '' },
    // Position snapshot when this draft was started from a GSC
    // striking-distance opportunity — lets us show how far the page moved.
    strikingSnapshot: {
      positionAtStart: { type: Number, default: null },
      siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', default: null },
      dateRange: { type: String, default: '' },
      snapshotAt: { type: Date, default: null },
    },
    // The live URL where this content is published (set at export or in content
    // settings). Enables GSC "decay" opportunities (Rec 15): declining Search
    // Console pages are matched to content by normalized publishedUrl.
    publishedUrl: { type: String, default: '' },
    // GSC striking-distance queries the user chose to optimize for via the
    // Opportunities "Apply" action. Merged (deduped, capped) into the writing
    // brief's secondaryKeywords so the whole scoring loop targets them.
    appliedGscQueries: { type: [String], default: [] },
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
    // Optional writing-style reference — the contentNumber of another draft in
    // the SAME workspace whose markdown will be appended to the engine brief's
    // authorContext with a "STYLE ONLY" instruction. Lets users keep the voice
    // consistent across articles without copying any facts or topics.
    styleReferenceContentNumber: { type: Number, default: null },

    // Version history
    versions: {
      type: [versionSnapshotSchema],
      default: [],
      validate: [arr => arr.length <= 10, 'Maximum 10 version snapshots allowed'],
    },

    // Comments
    comments: { type: [commentSchema], default: [] },

    // Content audit results
    audits: { type: [auditResultSchema], default: [] },

    // Writing quality audit results
    writingQualityAudits: { type: [auditResultSchema], default: [] },

    // Engine analysis results (persisted from Go engine)
    analysisStatus: {
      type: String,
      enum: ['idle', 'pending', 'analyzing', 'ready', 'failed'],
      default: 'idle',
    },
    analysisError: { type: String, default: '' },
    // Per-URL competitor-crawl failures surfaced by the engine's /analyze
    // (SSRF rejection, timeout, 4xx, empty body) — these explain WHY a
    // requested competitor page is absent from the benchmark.
    crawlErrors: {
      type: [{ url: { type: String, default: '' }, reason: { type: String, default: '' }, _id: false }],
      default: [],
    },
    analyzedAt: Date,

    benchmark: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Rec 10: weekly drift-sweep flag — set when the SERP for this content's
    // keywords has shifted materially since analysis ({ at, overlap,
    // newCompetitors }). Cleared by runAnalysis on successful re-analysis.
    driftDetected: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Rec 11: prompts this content opted into tracking via "Track this
    // keyword" (primary keyword + up to 2 fanout queries). Non-empty =
    // tracking enabled; the prompts live on the workspace's AiTracker and are
    // scanned by the existing scheduler — this array only links content →
    // prompts for the editor's trend display.
    trackedPrompts: { type: [String], default: [] },
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

    // Downgrade locking — locked resources are read-only until the org upgrades
    locked: { type: Boolean, default: false },

    // Tracks whether this resource was created on a free or paid plan.
    // On downgrade to free, paid-created resources are locked.
    createdOnPlan: { type: String, enum: ['free', 'paid'], default: 'free' },

    // Plan mode (v4 spec). mode is the persistent source of truth — frontend
    // reads it on load and disables incompatible UI. Per-request mode is NOT
    // threaded through; conflicts are surfaced as 409 at the application layer.
    // activePlanId points at the currently-approved Plan (if any). Reconciled
    // by Plan.js status-change hook when the active plan transitions away.
    mode: {
      type: String,
      enum: ['chat', 'plan', 'execute'],
      default: 'chat',
    },
    activePlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      default: null,
    },

    // Phase 6 (article count-gate): set on the first successful full-article
    // generation on this doc. The FIRST generation doesn't decrement the article
    // allowance (content creation already counted it); every RE-generation after
    // this is set consumes a slot — see aiController article-gate.
    articleGeneratedAt: { type: Date, default: null },
    // Which approved plan produced the current article (null for Auto-write
    // outside plan mode). Each approved plan buys ONE article generation:
    // execute-mode runs under a plan whose id differs from this stamp classify
    // as the plan's article write (agentBilling.isPlanArticleWrite).
    articleGeneratedPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
  },
  { timestamps: true }
);

// Cascade: when a Content is removed, archive its Plans (do NOT delete — audit
// trail). Mongoose has two delete paths (document.deleteOne vs Model.deleteOne)
// — register on both. Plan model is required lazily to avoid a require-cycle
// since Plan refs Content.
async function archivePlansForContent(contentId) {
  if (!contentId) return;
  const Plan = require('./Plan');
  await Plan.updateMany(
    { contentId, status: { $nin: ['archived'] } },
    { $set: { status: 'archived' } }
  );
}

contentSchema.pre('deleteOne', { document: true, query: false }, async function () {
  await archivePlansForContent(this._id);
});

contentSchema.pre('deleteOne', { document: false, query: true }, async function () {
  const doc = await this.model.findOne(this.getFilter()).select('_id');
  if (doc) await archivePlansForContent(doc._id);
});

contentSchema.pre('deleteMany', { document: false, query: true }, async function () {
  const docs = await this.model.find(this.getFilter()).select('_id');
  for (const d of docs) await archivePlansForContent(d._id);
});

contentSchema.pre('findOneAndDelete', async function () {
  const doc = await this.model.findOne(this.getFilter()).select('_id');
  if (doc) await archivePlansForContent(doc._id);
});
 
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
    .select('contentNumber title slug description targetKeywords country device score wordCount status folder platform contentType analysisStatus analyzedAt publishedAt scheduledAt locked createdOnPlan createdAt updatedAt')
    .sort({ updatedAt: -1 });
};

module.exports = mongoose.model('Content', contentSchema);
