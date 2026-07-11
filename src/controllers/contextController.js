/**
 * Context File System controller — both internal (Go-facing) and user-facing
 * routes are thin wrappers around services/contextFs.
 *
 * Internal handlers (under /api/internal/cfs/...) trust the internalAuth
 * middleware and resolve content by (workspaceNumber, contentNumber) WITHOUT
 * checking user ownership — Go has scoped access to the specific content.
 *
 * User-facing handlers (under /api/workspace/.../context/...) resolve
 * through workspace membership like the rest of the workspace API.
 */

const Workspace = require('../models/Workspace');
const Content = require('../models/Content');
const Plan = require('../models/Plan');
const contextFs = require('../services/contextFs');
const { applyPatch } = require('../services/jsonPatch');
const planValidator = require('../services/planValidator');
const { toGoPlan } = require('../services/planSerializer');
const { computeDrift } = require('../services/conformance');

// ─── Plan context builder ────────────────────────────────────────────
//
// Several generators (INDEX, plans/*) need to know the plan state. We load
// it once per request and pass it down — avoids each generator hitting Mongo.

async function buildPlanContext(content) {
  // History = TERMINAL statuses only. The current draft/proposed/approved are
  // surfaced via their dedicated slots and via /plans/active.md. Including
  // them in history would (a) duplicate listings under /plans/history/v-N.md
  // and /plans/active.md, and (b) mislabel current plans as "historical."
  // (Bug 1 fix from M2 review.)
  const [draft, proposed, history] = await Promise.all([
    Plan.findDraft(content._id),
    Plan.findProposed(content._id),
    Plan.find({
      contentId: content._id,
      status: { $in: ['superseded', 'archived'] },
    }).sort({ version: -1 }),
  ]);
  let approved = null;
  if (content.activePlanId) {
    approved = await Plan.findById(content.activePlanId);
  }
  const histArr = Array.isArray(history) ? history : [];

  return {
    draft,
    proposed,
    approved,
    activePlan: approved && approved.status === 'approved' ? approved : null,
    history: histArr,
    historyCount: histArr.length,
    latestHistoricalVersion: pickLatestHistoricalVersion(histArr),
  };
}

/**
 * Pick the version number INDEX.md should link to as the "prior plan."
 *
 * Superseded plans were once approved and only displaced by a reopen;
 * archived plans were scrapped before approval. Prefer the newest
 * superseded so the agent reads the prior DECISION, not a prior
 * EXPERIMENT. Falls back to the newest archived only when no superseded
 * plans exist (e.g. user's first ever plan was rejected outright).
 *
 * Returns 0 when no historical plans exist.
 *
 * Exported for direct unit testing without standing up Mongo.
 */
function pickLatestHistoricalVersion(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const superseded = history.filter((p) => p && p.status === 'superseded');
  const pool = superseded.length > 0 ? superseded : history;
  return pool.reduce((max, p) => (p && p.version > max ? p.version : max), 0);
}

// ─── Internal helpers ────────────────────────────────────────────────
// Resolve content from path params WITHOUT user-scope check. Internal-only.
async function resolveContentInternal(req, res) {
  const { workspaceNumber, contentNumber } = req.params;
  const workspace = await Workspace.findOne({ workspaceNumber: Number(workspaceNumber) });
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  const content = await Content.findByNumber(workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  return content;
}

// ─── User-facing helper ──────────────────────────────────────────────
// F1/B1: the user-facing context routes (context/list, context/read) run
// behind the rwr middleware, so req.workspace already holds the
// membership-resolved workspace. The old legacy `members[] OR userId`
// re-query IGNORED it and 404'd every org-scoped teammate. Scope content to
// the resolved workspace. (resolveContentInternal above is the internal-auth
// path — no user scope — and deliberately keeps its own lookup.)
async function resolveContentForUser(req, res) {
  const { contentNumber } = req.params;
  const content = await Content.findByNumber(req.workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  // B4: same lock gate as contentController.getContent — locked content leaks
  // nothing and accepts no AI context ops, closing the context-route bypass.
  // resolveContentInternal (the engine's internal-auth path) is intentionally
  // left as-is: the user-facing route that STARTS an engine run is gated here.
  if (content.locked) {
    res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });
    return null;
  }
  return content;
}

// Common handler factory — both internal and user-facing endpoints share logic
function makeHandler(operation, resolver) {
  return async (req, res) => {
    try {
      const content = await resolver(req, res);
      if (!content) return;
      const planContext = await buildPlanContext(content);
      await operation(req, res, content, planContext);
    } catch (err) {
      console.error('contextFs handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Context FS error' });
      }
    }
  };
}

// ─── Operations ──────────────────────────────────────────────────────

const listOp = async (req, res, content, planContext) => {
  const prefix = typeof req.query.path === 'string' ? req.query.path : '/';
  const entries = contextFs.list(content, planContext, prefix);
  res.json({ entries });
};

const readOp = async (req, res, content, planContext) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  const offset = req.query.offset != null ? Number(req.query.offset) : undefined;
  const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
  const anchor = typeof req.query.anchor === 'string' ? req.query.anchor : undefined;
  if (!path) {
    return res.status(400).json({ error: 'path query parameter required' });
  }
  const result = contextFs.read(content, planContext, path, { offset, limit, anchor });
  if (!result) {
    return res.status(404).json({ error: `path "${path}" not found in CFS` });
  }
  res.json(result);
};

const grepOp = async (req, res, content, planContext) => {
  const pattern = typeof req.query.pattern === 'string' ? req.query.pattern : '';
  const prefix = typeof req.query.path === 'string' ? req.query.path : '/';
  if (!pattern) {
    return res.status(400).json({ error: 'pattern query parameter required' });
  }
  let re;
  try {
    // Accept literal substring or /regex/flags
    const rxMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    re = rxMatch ? new RegExp(rxMatch[1], rxMatch[2] || 'i') : pattern;
  } catch (err) {
    return res.status(400).json({ error: `invalid pattern: ${err.message}` });
  }
  const { results, truncated } = contextFs.grep(content, planContext, re, prefix);
  res.json({ results, truncated });
};

const verifyOp = async (req, res, content, planContext) => {
  const refs = (req.body && req.body.refs) || [];
  if (!Array.isArray(refs)) {
    return res.status(400).json({ error: 'body.refs must be an array' });
  }
  const results = contextFs.verify(content, planContext, refs);
  res.json({ results });
};

// PATCH (internal-only, /plans/active.md only — used by Go's UpdatePlan tool)
const writeOp = async (req, res, content) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (path !== '/plans/active.md') {
    return res.status(403).json({
      error: 'Only /plans/active.md is writable in CFS at this milestone',
    });
  }
  const ops = (req.body && req.body.ops) || [];
  const opCheck = planValidator.validateOps(ops);
  if (!opCheck.ok) {
    return res.status(400).json({ error: 'Invalid patch ops', failures: opCheck.failures });
  }

  // Find the editable plan (proposed > draft). Match the planController contract.
  let plan = await Plan.findProposed(content._id);
  if (!plan) plan = await Plan.findDraft(content._id);
  if (!plan) {
    return res.status(404).json({ error: 'No editable plan exists', code: 'NO_DRAFT' });
  }

  const pojo = plan.toObject();
  try {
    applyPatch(pojo, ops);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const writableFields = [
    'targetAudience', 'angle', 'thesis', 'differentiation',
    'sections', 'wordBudget', 'evidenceMap', 'sources',
    'alternatives', 'risks', 'openQuestions',
  ];
  for (const f of writableFields) plan[f] = pojo[f];
  plan.markModified('evidenceMap');
  try {
    await plan.save();
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      const failures = Object.entries(err.errors || {}).map(([p, e]) => ({
        path: p, message: e.message, kind: e.kind,
      }));
      return res.status(400).json({ error: 'Validation failed', failures });
    }
    throw err;
  }
  // Return the plan in the Go-side wire shape so writing-engine's UpdatePlan
  // can call session.SetPlan() to refresh its denormalized snapshot. Without
  // this conversion, Mongoose's `_id` wouldn't unmarshal into Go's `id` field
  // and the snapshot would drift further away from Mongo on every patch.
  res.json({ plan: toGoPlan(plan) });
};

// ─── Conformance / drift detection ───────────────────────────────────
//
// POST /api/internal/cfs/:ws/:c/conformance — body: { documentMarkdown }
// Returns the same drift shape as Go's ComputeDrift:
//   { ok, violations: [{type, sectionId?, heading?, severity, detail}], summary }
//
// Express owns the AUTHORITATIVE check (block-parser-based so fenced
// code blocks etc. can't bleed into heading detection). Go's in-loop
// heuristic is a fast first-pass; this endpoint is the second-opinion
// check the execute-mode strategy can hit at terminal turns.
//
// Reuses planContext (already populated by makeHandler) instead of
// re-querying Mongo — saves one round-trip per call (Bug #G fix). The
// `activePlan` field is filtered by status='approved' in buildPlanContext,
// so this can't accidentally measure drift against a superseded/archived
// plan (Bug #C fix).
const conformanceOp = async (req, res, content, planContext) => {
  const documentMarkdown = (req.body && req.body.documentMarkdown) || '';
  const plan = planContext.activePlan || planContext.proposed || planContext.draft;
  if (!plan) {
    return res.json({ ok: true, violations: [], summary: 'No plan attached — nothing to check.' });
  }
  const drift = computeDrift(documentMarkdown, plan);
  res.json(drift);
};

module.exports = {
  // Internal (Go-facing)
  internalList:       makeHandler(listOp,         resolveContentInternal),
  internalRead:       makeHandler(readOp,         resolveContentInternal),
  internalGrep:       makeHandler(grepOp,         resolveContentInternal),
  internalVerify:     makeHandler(verifyOp,       resolveContentInternal),
  internalWrite:      makeHandler(writeOp,        resolveContentInternal),
  internalConformance: makeHandler(conformanceOp, resolveContentInternal),
  // User-facing
  userList:       makeHandler(listOp,   resolveContentForUser),
  userRead:       makeHandler(readOp,   resolveContentForUser),
  // exposed for tests
  buildPlanContext,
  pickLatestHistoricalVersion,
};
