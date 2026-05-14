const mongoose = require('mongoose');

// Per the v4 plan-mode spec (writing-engine plan mode milestone M1):
// Plan is a separate collection (NOT a sub-document on Content) so plan
// history can grow independently of the 16MB document cap on Content.
// Citation refs target stable IDs + anchors_version, never line numbers,
// so they survive Mongo content changes without silent drift.

const differentiatorSchema = new mongoose.Schema(
  {
    competitorPath: { type: String, required: true },  // e.g. "/competitors/notion.com.md"
    gap: { type: String, required: true },
    ourMove: { type: String, required: true },
  },
  { _id: false }
);

const contextRefSchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    anchor: String,                                    // anchor id from file frontmatter
    anchorsVersion: Number,                            // recorded when citation was made
    quote: String,                                     // alternative to anchor: verbatim text
    reason: { type: String, required: true },
  },
  { _id: false }
);

const keyPointSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    evidence: { type: [contextRefSchema], default: [] },
  },
  { _id: false }
);

// Section IDs must be safe slugs — they're used as keys into evidenceMap
// and as JSON Patch path segments. The validator's evidenceMap regex is
// /^\/evidenceMap\/[A-Za-z0-9_-]+$/ — keep the model and validator aligned.
const SECTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const plannedSectionSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      match: [SECTION_ID_PATTERN, 'section.id must match /^[A-Za-z0-9_-]+$/'],
    },
    heading: { type: String, required: true },
    headingLevel: { type: Number, required: true, min: 1, max: 6 },
    keyPoints: { type: [keyPointSchema], default: [] },
    wordTarget: { type: Number, default: 0 },
    internalLinks: { type: [String], default: [] },
  },
  { _id: false }
);

const alternativeSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    pros: { type: [String], default: [] },
    cons: { type: [String], default: [] },
    chosen: { type: Boolean, default: false },
    reason: { type: String, default: '' },
  },
  { _id: false }
);

const riskSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    mitigation: { type: String, default: '' },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  },
  { _id: false }
);

const openQuestionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    question: { type: String, required: true },
    blocking: { type: Boolean, default: false },
    answer: { type: String, default: '' },
  },
  { _id: false }
);

const plannedSourceSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    title: { type: String, default: '' },
    snippet: { type: String, default: '' },
    stance: { type: String, enum: ['supports', 'contradicts', 'background'], default: 'background' },
    addedAt: { type: Number, default: () => Date.now() },
  },
  { _id: false }
);

const PLAN_STATUSES = ['draft', 'proposed', 'approved', 'superseded', 'archived'];

const planSchema = new mongoose.Schema(
  {
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Content',
      required: true,
      index: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    contentNumber: { type: Number, required: true },

    version: { type: Number, required: true, min: 1 },
    parentVersion: { type: Number, default: null },
    status: { type: String, enum: PLAN_STATUSES, default: 'draft' },

    // Strategic frame
    targetAudience: { type: String, default: '' },
    angle: { type: String, default: '' },
    thesis: { type: String, default: '' },
    differentiation: { type: [differentiatorSchema], default: [] },

    // Structural
    sections: { type: [plannedSectionSchema], default: [] },
    wordBudget: { type: Number, default: 0 },

    // Evidence — section.id → refs
    // Map allows arbitrary keys; sub-schema not enforced on Map values, so we
    // validate ContextRef shape in planValidator instead.
    evidenceMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    sources: { type: [plannedSourceSchema], default: [] },

    // Deliberation
    alternatives: { type: [alternativeSchema], default: [] },
    risks: { type: [riskSchema], default: [] },
    openQuestions: { type: [openQuestionSchema], default: [] },

    // Verification
    predictedSeoScore: { type: Number, default: 0, min: 0, max: 100 },
    evidenceVerified: { type: Boolean, default: false },

    approvedAt: { type: Number, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Unique compound prevents the race where two concurrent enter/reopen calls
// both compute the same next version. The unique constraint on E11000 lets
// the controller retry and fall back to the existing draft. (-1 sort is just
// query optimization on top of the same index.)
planSchema.index({ contentId: 1, version: 1 }, { unique: true });
planSchema.index({ contentId: 1, status: 1 });

// Defense-in-depth: only one plan per content may sit in `proposed` or
// `approved` at a time. The controller has TOCTOU guards (findProposed
// before create, etc.) but a concurrent racing approve/propose could still
// leave two plans in the same active status. Partial-filter unique indexes
// turn that race into an E11000 the controller's handleSaveError catches,
// rather than silent corruption that breaks scoring/conformance later.
planSchema.index(
  { contentId: 1 },
  { unique: true, partialFilterExpression: { status: 'proposed' }, name: 'one_proposed_per_content' }
);
planSchema.index(
  { contentId: 1 },
  { unique: true, partialFilterExpression: { status: 'approved' }, name: 'one_approved_per_content' }
);

// --- Static helpers used by controller + tests ---

planSchema.statics.STATUSES = PLAN_STATUSES;

planSchema.statics.findActive = function (contentId) {
  return this.findOne({ contentId, status: 'approved' });
};

planSchema.statics.findDraft = function (contentId) {
  return this.findOne({ contentId, status: 'draft' }).sort({ version: -1 });
};

planSchema.statics.findProposed = function (contentId) {
  return this.findOne({ contentId, status: 'proposed' }).sort({ version: -1 });
};

planSchema.statics.findLatestVersion = async function (contentId) {
  const latest = await this.findOne({ contentId }).sort({ version: -1 }).select('version');
  return latest ? latest.version : 0;
};

planSchema.statics.findHistory = function (contentId) {
  return this.find({ contentId }).sort({ version: -1 });
};

// ─── Status-transition helpers (called from controller) ───────────────────
//
// These are explicit functions, not Mongoose hooks. Hooks would couple Plan
// saves to Content writes silently — easy to trigger unintentionally during
// JSON Patch edits. Explicit calls keep the side effects auditable.

/**
 * Approve a draft/proposed plan. Side effects:
 *   - This plan: status=approved, approvedAt set, approvedBy set
 *   - Any prior approved plan for same content: superseded
 *   - Content: mode=execute, activePlanId=this plan
 */
planSchema.statics.approveAndReconcile = async function (planId, userId) {
  const Content = require('./Content');
  const plan = await this.findById(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.status !== 'draft' && plan.status !== 'proposed') {
    throw new Error(`Cannot approve plan with status "${plan.status}"`);
  }

  // Supersede prior approved plans for the same content
  await this.updateMany(
    { contentId: plan.contentId, status: 'approved', _id: { $ne: plan._id } },
    { $set: { status: 'superseded' } }
  );

  plan.status = 'approved';
  plan.approvedAt = Date.now();
  if (userId) plan.approvedBy = userId;
  await plan.save();

  await Content.updateOne(
    { _id: plan.contentId },
    { $set: { mode: 'execute', activePlanId: plan._id } }
  );

  return plan;
};

/**
 * Reject a draft/proposed plan. Archives it.
 *
 * Revival semantics: if this plan was a revision (parentVersion set) of an
 * approved-then-superseded parent, re-promote the parent. The user is
 * scrapping the revision, not abandoning their previously-blessed plan.
 * (Bug 3 fix — without this, rejecting a revision silently strands the user
 * in chat mode with no active plan even though v1 was approved.)
 *
 * If no parent to revive: flip Content to chat and null activePlanId.
 *
 * @returns {{plan: PlanDocument, revivedParent: PlanDocument|null}}
 */
planSchema.statics.rejectAndReconcile = async function (planId) {
  const Content = require('./Content');
  const plan = await this.findById(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.status !== 'draft' && plan.status !== 'proposed') {
    throw new Error(`Cannot reject plan with status "${plan.status}"`);
  }
  plan.status = 'archived';
  await plan.save();

  // Revival path
  if (plan.parentVersion != null) {
    const parent = await this.findOne({
      contentId: plan.contentId,
      version: plan.parentVersion,
      status: 'superseded',
    });
    if (parent) {
      parent.status = 'approved';
      await parent.save();
      await Content.updateOne(
        { _id: plan.contentId },
        { $set: { mode: 'execute', activePlanId: parent._id } }
      );
      return { plan, revivedParent: parent };
    }
  }

  // No revival — fall through to chat mode
  await Content.updateOne(
    { _id: plan.contentId, activePlanId: plan._id },
    { $set: { mode: 'chat', activePlanId: null } }
  );
  await Content.updateOne(
    { _id: plan.contentId, mode: 'plan' },
    { $set: { mode: 'chat' } }
  );

  return { plan, revivedParent: null };
};

/**
 * Archive a plan (terminal state from any non-approved status). Reconciles
 * Content.activePlanId if it pointed here.
 */
planSchema.statics.archiveAndReconcile = async function (planId) {
  const Content = require('./Content');
  const plan = await this.findByIdAndUpdate(
    planId,
    { $set: { status: 'archived' } },
    { new: true }
  );
  if (!plan) throw new Error('Plan not found');
  await Content.updateOne(
    { _id: plan.contentId, activePlanId: plan._id },
    { $set: { activePlanId: null } }
  );
  return plan;
};

module.exports = mongoose.model('Plan', planSchema);
module.exports.PLAN_STATUSES = PLAN_STATUSES;
