const mongoose = require('mongoose');
const Counter = require('./Counter');
const { SUPPORTED_LANGUAGE_CODES } = require('../config/locales');

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

const toggleDataSchema = new mongoose.Schema(
  { summary: String, content: String },
  { _id: false }
);

const embedDataSchema = new mongoose.Schema(
  {
    url: String,
    embedType: { type: String, enum: ['youtube', 'twitter', 'generic'] },
    embedUrl: String,
  },
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
    // caption/indent/toggleData/embedData were missing here — Mongoose strict
    // mode silently stripped them on every save, so toggle/embed blocks and
    // image captions never survived a reload even when the editor sent them.
    caption: String,
    width: Number,
    align: { type: String, enum: ['left', 'center', 'right', 'justify'] },
    indent: Number,
    // Measured pixel size of an image's source. Drives the width/height
    // attributes in the export (reserved layout box → no CLS) and the
    // low-resolution warning in the editor.
    intrinsicWidth: Number,
    intrinsicHeight: Number,
    // Transient: marks an imported/pasted image whose shape-based sizing is
    // still pending its first load. Persisted so an autosave that lands before
    // the image loads does not strand it un-sized (which is exactly what
    // strict mode did to caption/indent/toggleData above).
    autoSize: Boolean,
    faqItems: [faqItemSchema],
    ctaData: ctaDataSchema,
    tableData: tableDataSchema,
    codeData: codeDataSchema,
    toggleData: toggleDataSchema,
    embedData: embedDataSchema,
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
    // Content/analysis language (ISO 639-1). Drives locale-aware SERP/volume
    // fetch, prompts, and scoring (Issue 2 Phase A+). Defaults to English so
    // pre-existing content and non-localized create paths are unaffected.
    language: { type: String, enum: SUPPORTED_LANGUAGE_CODES, default: 'en' },
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
             'product-page', 'category-page', 'service-page', 'llm-optimized',
             'homepage', 'glossary', 'documentation', 'faq', ''],
      default: '',
    },
    contentContext: { type: String, default: '' },
    targetWordCount: { type: Number, default: 0 },
    // writingMode removed: the wizard step that set it asked the user to commit
    // to "write it yourself" vs "generate", but nothing ever read the field —
    // both paths stayed fully available in the editor either way. Its only real
    // effect was a ?reviewOutline query param, now rehomed as an editor action.
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

    // Per-user favorites (the content-editors star). Never returned to the
    // client: listContents collapses it to a per-caller `favorite` boolean and
    // getContent/updateContent strip it. Deliberately NOT `select: false` —
    // nothing else in the codebase uses that flag, and four call sites load a
    // full doc and call content.save(), which is exactly where an unselected
    // path is easy to get wrong.
    favoritedBy: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },

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

// Threads P5: a deleted content's conversations are unreachable (every thread
// route resolves through the content) — DELETE them children-first rather
// than archive (deviation from the plan's early wording: contents don't
// undelete, and 90 days of unreachable rows serves nobody). Lazy requires
// avoid cycles; deleteMany on messages first mirrors deletionService.
async function deleteThreadsForContent(contentId) {
  if (!contentId) return;
  const AiThread = require('./AiThread');
  const AiThreadMessage = require('./AiThreadMessage');
  const threads = await AiThread.find({ contentId }).select('_id').lean();
  if (!threads.length) return;
  const ids = threads.map((t) => t._id);
  await AiThreadMessage.deleteMany({ threadId: { $in: ids } });
  await AiThread.deleteMany({ _id: { $in: ids } });
}

async function cascadeContentDelete(contentId) {
  await archivePlansForContent(contentId);
  await deleteThreadsForContent(contentId);
}

// Batch variant for deleteMany (P5 review): the per-content loop was 2+
// queries × N contents inside a user-facing workspace/admin delete, and a
// mid-loop failure left contents 1..k-1 stripped of conversations while the
// delete itself aborted. Four bulk statements shrink that window to a
// single all-or-nothing step per collection. Fail-closed like the rest of
// the hooks: a throw here blocks the content delete (orphaned-but-live
// threads would be unreachable, which is worse).
async function cascadeContentDeleteBulk(contentIds) {
  if (!contentIds.length) return;
  const Plan = require('./Plan');
  const AiThread = require('./AiThread');
  const AiThreadMessage = require('./AiThreadMessage');
  await Plan.updateMany(
    { contentId: { $in: contentIds }, status: { $nin: ['archived'] } },
    { $set: { status: 'archived' } }
  );
  const threads = await AiThread.find({ contentId: { $in: contentIds } }).select('_id').lean();
  if (!threads.length) return;
  const ids = threads.map((t) => t._id);
  await AiThreadMessage.deleteMany({ threadId: { $in: ids } });
  await AiThread.deleteMany({ _id: { $in: ids } });
}

contentSchema.pre('deleteOne', { document: true, query: false }, async function () {
  await cascadeContentDelete(this._id);
});

contentSchema.pre('deleteOne', { document: false, query: true }, async function () {
  const doc = await this.model.findOne(this.getFilter()).select('_id');
  if (doc) await cascadeContentDelete(doc._id);
});

contentSchema.pre('deleteMany', { document: false, query: true }, async function () {
  const docs = await this.model.find(this.getFilter()).select('_id');
  await cascadeContentDeleteBulk(docs.map((d) => d._id));
});

contentSchema.pre('findOneAndDelete', async function () {
  const doc = await this.model.findOne(this.getFilter()).select('_id');
  if (doc) await cascadeContentDelete(doc._id);
});

// Test-only handles (P5 review: hook *registration* is provable from outside,
// hook *behavior* is not — a vacuous presence-assert passed with the thread
// cascade deleted). Not part of the model's public API.
contentSchema.statics._cascadeContentDelete = cascadeContentDelete;
contentSchema.statics._cascadeContentDeleteBulk = cascadeContentDeleteBulk;
 
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
    .select('contentNumber title slug description targetKeywords country device score wordCount status folder platform contentType analysisStatus analyzedAt publishedAt scheduledAt locked createdOnPlan favoritedBy createdAt updatedAt')
    .sort({ updatedAt: -1 });
};

module.exports = mongoose.model('Content', contentSchema);
