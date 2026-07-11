/**
 * Plan controller — M1 of the writing-engine plan-mode build.
 *
 * Endpoints (all under /api/workspace/:workspaceNumber/content/:contentNumber):
 *   POST   /plan/enter      — flip to mode=plan, ensure a draft Plan exists
 *   GET    /plan            — current plan (proposed > draft > active)
 *   PATCH  /plan            — apply JSON Patch ops (user or agent)
 *   POST   /plan/approve    — approved + mode=execute + activePlanId set
 *   POST   /plan/reject     — archived + mode=chat
 *   POST   /plan/reopen     — supersede current, create new draft v+1
 *   POST   /plan/continue   — no state change; returns current draft for resume
 *   GET    /plan/history    — version list
 *
 * Auth + workspace/content scoping match the existing analysisController
 * pattern (workspace members OR owner).
 */

const Content = require('../models/Content');
const Plan = require('../models/Plan');
const AgentUsageLog = require('../models/AgentUsageLog');
const planValidator = require('../services/planValidator');
const { applyPatch } = require('../services/jsonPatch');
const { buildSkeleton, buildValidatorBrief } = require('../services/planSkeleton');
const { benchmarkToContentBrief } = require('../services/benchmarkToContentBrief');
const writingEngine = require('../services/writingEngine');

// ─── Error mapping (Bug 5 fix) ────────────────────────────────────────
//
// Mongoose ValidationError carries structured per-field info — surface it as
// 400 instead of the generic 500. Also catches subdoc match-pattern failures
// (e.g. section.id slug pattern). Returns true if it handled the error.
function handleSaveError(err, res) {
  if (err && err.name === 'ValidationError') {
    const failures = Object.entries(err.errors || {}).map(([path, e]) => ({
      path,
      message: e.message,
      kind: e.kind,
    }));
    if (!res.headersSent) {
      res.status(400).json({ error: 'Validation failed', failures });
    }
    return true;
  }
  if (err && err.name === 'CastError') {
    if (!res.headersSent) {
      res.status(400).json({ error: 'Invalid input', path: err.path });
    }
    return true;
  }
  return false;
}

// Mongo duplicate-key error from the unique (contentId, version) index. Used
// by the enter/reopen race retry (Bug 1 fix).
function isDuplicateKey(err) {
  return err && err.code === 11000;
}


// F1/B1: the workspace + role are already resolved by the rwr middleware on
// every plan route (req.workspace). The old legacy `members[] OR userId`
// re-query here IGNORED that and 404'd every org-scoped teammate (modern
// membership lives in OrgMember). Scope content to the resolved workspace.
async function resolveContent(req, res) {
  const { contentNumber } = req.params;
  const content = await Content.findByNumber(req.workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  // B4: locked content (e.g. paid-created content on a downgraded free tier)
  // must not leak its data or accept AI/plan mutations. Same gate as
  // contentController.getContent — closes the plan-route bypass of that gate.
  if (content.locked) {
    res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });
    return null;
  }
  return content;
}


// ─── POST /plan/enter ─────────────────────────────────────────────────

const enter = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    // 409: another tab/session is awaiting approval — don't start a parallel one.
    const proposed = await Plan.findProposed(content._id);
    if (proposed) {
      return res.status(409).json({
        error: 'A plan is awaiting approval for this content',
        code: 'PLAN_PROPOSED',
        planId: proposed._id,
      });
    }

    // 409: content is in execute mode. Starting a fresh plan would silently
    // abandon the active one. Caller must explicitly /plan/reopen (carries
    // forward) or pass ?force=true to start clean. (Bug 7 fix.)
    const force = req.query && req.query.force === 'true';
    const wasExecuteMode = content.mode === 'execute';
    if (wasExecuteMode && !force) {
      return res.status(409).json({
        error:
          'Content is in execute mode with an active plan. Use /plan/reopen to revise, or pass ?force=true to start fresh.',
        code: 'IN_EXECUTE_MODE',
        activePlanId: content.activePlanId,
      });
    }

    // Force-clear when transitioning out of execute mode: don't leave a
    // stale activePlanId pointing at the abandoned approved plan, and
    // mark that plan as superseded so reads don't treat it as current.
    // (Bug #1 from second-round review.)
    if (wasExecuteMode && force && content.activePlanId) {
      await Plan.updateOne(
        { _id: content.activePlanId, status: 'approved' },
        { $set: { status: 'superseded' } }
      );
      content.activePlanId = null;
    }

    const priorMode = content.mode || 'chat';
    if (content.mode !== 'plan') {
      content.mode = 'plan';
      await content.save();
    }
    const modeChanged = priorMode !== 'plan';

    // Reuse an in-progress draft if there is one
    let plan = await Plan.findDraft(content._id);
    if (!plan) {
      // Race-safe create: a concurrent enter call may have already created
      // a draft at the version we computed. The unique (contentId, version)
      // index (Bug 1 fix) returns E11000; we retry by re-reading the latest
      // version or falling back to the now-existing draft.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const latest = await Plan.findLatestVersion(content._id);
          plan = await Plan.create(buildSkeleton({ content, version: latest + 1 }));
          break;
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
          const existing = await Plan.findDraft(content._id);
          if (existing) {
            plan = existing;
            break;
          }
          // Race winner created at same version but it's not a draft — bump and retry
        }
      }
      if (!plan) {
        return res.status(503).json({
          error: 'Could not allocate a plan version (too many concurrent writes)',
        });
      }
    }

    res.status(200).json({
      plan,
      mode: content.mode,
      event: {
        type: 'plan_entered',
        planId: plan._id,
        version: plan.version,
        modeChanged: modeChanged ? { from: priorMode, to: 'plan' } : null,
      },
    });
  } catch (err) {
    if (handleSaveError(err, res)) return;
    console.error('plan/enter error:', err);
    res.status(500).json({ error: err.message || 'Failed to enter plan mode' });
  }
};

// ─── GET /plan ────────────────────────────────────────────────────────

const get = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const proposed = await Plan.findProposed(content._id);
    if (proposed) return res.json({ plan: proposed, kind: 'proposed' });

    const draft = await Plan.findDraft(content._id);
    if (draft) return res.json({ plan: draft, kind: 'draft' });

    if (content.activePlanId) {
      const active = await Plan.findById(content.activePlanId);
      if (active) return res.json({ plan: active, kind: 'approved' });
    }

    res.json({ plan: null, kind: null });
  } catch (err) {
    console.error('plan/get error:', err);
    res.status(500).json({ error: err.message || 'Failed to get plan' });
  }
};

// ─── PATCH /plan ──────────────────────────────────────────────────────

const patch = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { ops } = req.body || {};
    const opCheck = planValidator.validateOps(ops);
    if (!opCheck.ok) {
      return res.status(400).json({
        error: 'Invalid patch ops',
        failures: opCheck.failures,
      });
    }

    // Only the latest draft or proposed plan is patchable
    let plan = await Plan.findProposed(content._id);
    if (!plan) plan = await Plan.findDraft(content._id);
    if (!plan) {
      return res.status(404).json({
        error: 'No editable plan exists. Call /plan/enter first.',
        code: 'NO_DRAFT',
      });
    }

    // Apply patch to a plain object copy, then assign back. Mongoose Mixed
    // fields (evidenceMap) need markModified to persist.
    const pojo = plan.toObject();
    try {
      applyPatch(pojo, ops);
    } catch (patchErr) {
      return res.status(400).json({ error: patchErr.message });
    }

    // Reassign whitelisted fields only — never trust the patch to touch
    // status/version/contentId/etc even if the validator missed something.
    const writableFields = [
      'targetAudience', 'angle', 'thesis', 'differentiation',
      'sections', 'wordBudget', 'evidenceMap', 'sources',
      'alternatives', 'risks', 'openQuestions',
    ];
    for (const f of writableFields) plan[f] = pojo[f];
    plan.markModified('evidenceMap');
    await plan.save();

    res.json({ plan });
  } catch (err) {
    if (handleSaveError(err, res)) return;
    console.error('plan/patch error:', err);
    res.status(500).json({ error: err.message || 'Failed to patch plan' });
  }
};

// ─── POST /plan/approve ───────────────────────────────────────────────

const approve = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    let plan = await Plan.findProposed(content._id);
    if (!plan) plan = await Plan.findDraft(content._id);
    if (!plan) {
      return res.status(404).json({ error: 'No plan to approve' });
    }

    // Final completeness check — refuse to approve incomplete plans.
    // Brief must be built from Content's real fields, NOT content.contentBrief
    // (that's a different shape from the analysis pipeline). See Bug #3.
    const brief = buildValidatorBrief(content);
    const check = planValidator.validateCompleteness(plan.toObject(), brief);
    if (!check.ok) {
      return res.status(400).json({
        error: 'Plan is not complete',
        failures: check.failures,
      });
    }

    const approved = await Plan.approveAndReconcile(plan._id, req.user.userId);
    // M5: standardize the event envelope so the frontend's reducer can
    // unify plan_approved + mode_changed handling across endpoints.
    res.json({
      plan: approved,
      mode: 'execute',
      event: {
        type: 'plan_approved',
        planId: approved._id,
        version: approved.version,
        modeChanged: { from: 'plan', to: 'execute' },
      },
    });
  } catch (err) {
    if (handleSaveError(err, res)) return;
    console.error('plan/approve error:', err);
    res.status(500).json({ error: err.message || 'Failed to approve plan' });
  }
};

// ─── POST /plan/reject ────────────────────────────────────────────────

const reject = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    let plan = await Plan.findProposed(content._id);
    if (!plan) plan = await Plan.findDraft(content._id);
    if (!plan) {
      return res.status(404).json({ error: 'No plan to reject' });
    }

    // rejectAndReconcile now returns {plan, revivedParent}. If parent was an
    // approved plan that this revision superseded, it's re-promoted and the
    // content goes back to execute mode. (Bug 3 fix.)
    const priorMode = 'plan';
    const { plan: rejected, revivedParent } = await Plan.rejectAndReconcile(plan._id);
    const nextMode = revivedParent ? 'execute' : 'chat';
    res.json({
      plan: rejected,
      mode: nextMode,
      revivedPlanId: revivedParent ? revivedParent._id : null,
      event: {
        type: 'plan_rejected',
        planId: rejected._id,
        version: rejected.version,
        modeChanged: { from: priorMode, to: nextMode },
        revivedPlanId: revivedParent ? revivedParent._id : null,
      },
    });
  } catch (err) {
    if (handleSaveError(err, res)) return;
    console.error('plan/reject error:', err);
    res.status(500).json({ error: err.message || 'Failed to reject plan' });
  }
};

// ─── POST /plan/reopen ────────────────────────────────────────────────

const reopen = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { strategy = 'carry-forward', feedback = '' } = req.body || {};
    if (!['carry-forward', 'clean-slate'].includes(strategy)) {
      return res.status(400).json({ error: `Unknown strategy "${strategy}"` });
    }

    // Find the plan to supersede — prefer proposed, then approved, then draft
    const prior =
      (await Plan.findProposed(content._id)) ||
      (await Plan.findOne({ contentId: content._id, status: 'approved' })) ||
      (await Plan.findDraft(content._id));

    if (prior) {
      // Only approved parents become 'superseded' (preserved for revival in
      // reject-after-reopen). Draft/proposed parents were never blessed —
      // they're archived. (Bug 3 fix companion to rejectAndReconcile.)
      prior.status = prior.status === 'approved' ? 'superseded' : 'archived';
      await prior.save();
    }

    // Race-safe create with unique (contentId, version) index (Bug 1 fix).
    // On E11000 we first check whether a parallel reopen already produced a
    // child of the same prior — if so, return that instead of creating a
    // duplicate revision (Bug #2 from second-round review). Only if no such
    // child exists do we retry with a higher version.
    let newPlan = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const latest = await Plan.findLatestVersion(content._id);
        newPlan = await Plan.create(
          buildSkeleton({
            content,
            version: latest + 1,
            parentVersion: prior ? prior.version : null,
            carryFrom: strategy === 'carry-forward' ? prior : null,
          })
        );
        break;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        if (prior) {
          const sibling = await Plan.findOne({
            contentId: content._id,
            parentVersion: prior.version,
            status: 'draft',
          }).sort({ version: -1 });
          if (sibling) {
            newPlan = sibling;
            break;
          }
        }
        // No sibling reopen — somebody else bumped the version; loop and retry
      }
    }
    if (!newPlan) {
      return res.status(503).json({
        error: 'Could not allocate a plan version (too many concurrent writes)',
      });
    }

    await Content.updateOne(
      { _id: content._id },
      { $set: { mode: 'plan', activePlanId: null } }
    );

    res.json({
      plan: newPlan,
      feedback,
      mode: 'plan',
      event: {
        type: 'plan_reopened',
        planId: newPlan._id,
        version: newPlan.version,
        strategy,
        modeChanged: { from: content.mode || 'unknown', to: 'plan' },
      },
    });
  } catch (err) {
    if (handleSaveError(err, res)) return;
    console.error('plan/reopen error:', err);
    res.status(500).json({ error: err.message || 'Failed to reopen plan' });
  }
};

// ─── POST /plan/continue ──────────────────────────────────────────────
// No state change. Returns the current draft so the editor can resume.
// (Actual agent continuation is wired in M3+.)

const continueResume = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    if (content.mode !== 'plan') {
      return res.status(409).json({
        error: `Content is in mode "${content.mode}", not "plan"`,
        code: 'NOT_IN_PLAN_MODE',
      });
    }

    const draft = await Plan.findDraft(content._id);
    if (!draft) {
      return res.status(404).json({ error: 'No draft plan to continue' });
    }

    res.json({ plan: draft, mode: content.mode });
  } catch (err) {
    console.error('plan/continue error:', err);
    res.status(500).json({ error: err.message || 'Failed to continue plan' });
  }
};

// ─── GET /plan/history ────────────────────────────────────────────────

const history = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const plans = await Plan.findHistory(content._id);
    res.json({ plans });
  } catch (err) {
    console.error('plan/history error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch plan history' });
  }
};

// ─── POST /plan/fast ──────────────────────────────────────────────────
//
// One-click plan seeding. Builds a brief from the content's benchmark,
// asks the writing-engine's /api/session/{id}/fast-plan generator for a
// section-skeleton derived from brief.subtopics, persists the result as
// a draft Plan (mode → plan), and returns the saved plan with a
// fast_plan_proposed event payload the frontend can render as a banner.
//
// Unlike /plan/enter (which creates an EMPTY draft and lets the agent
// build from zero), /plan/fast frontloads the section structure so the
// agent only has to fill strategic frame + evidence — far less back-
// and-forth.
const fast = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    // 409 if a proposed plan is already pending — same guard as /plan/enter.
    const proposed = await Plan.findProposed(content._id);
    if (proposed) {
      return res.status(409).json({
        error: 'A plan is awaiting approval for this content',
        code: 'PLAN_PROPOSED',
        planId: proposed._id,
      });
    }

    // Get or create a draft Plan. If there's already a draft with
    // substantive content, refuse — don't clobber user/agent work.
    let plan = await Plan.findDraft(content._id);
    if (plan && (plan.thesis || plan.angle || (plan.sections || []).length > 0)) {
      return res.status(409).json({
        error: 'A draft plan already has substantive content. Use /plan/reopen if you want to start fresh.',
        code: 'PLAN_DRAFT_IN_PROGRESS',
        planId: plan._id,
      });
    }

    if (content.mode !== 'plan') {
      content.mode = 'plan';
      await content.save();
    }

    // Bug #B fix: mirror /plan/enter's race-safe Plan.create loop.
    // Two concurrent /plan/fast calls would otherwise collide on the
    // unique (contentId, version) index and one would crash with E11000.
    if (!plan) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const latest = await Plan.findLatestVersion(content._id);
          plan = await Plan.create(buildSkeleton({ content, version: latest + 1 }));
          break;
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
          // The race winner may have created a draft at our target version.
          // If so, adopt it. Otherwise bump and retry.
          const existing = await Plan.findDraft(content._id);
          if (existing) {
            plan = existing;
            break;
          }
        }
      }
      if (!plan) {
        return res.status(503).json({
          error: 'Could not allocate a plan version (too many concurrent writes)',
        });
      }
    }

    // Ask the writing-engine for a sectioned skeleton from the brief.
    // generateFastPlan reads the brief from the request body, not the
    // session — so we don't pushBrief here (Bug #D cleanup).
    const brief = benchmarkToContentBrief(content);
    let generated = null;
    let generatorFailed = false;
    try {
      const sessionId = await writingEngine.createSession();
      const resp = await writingEngine.generateFastPlan(sessionId, { brief });
      generated = resp && resp.plan;
    } catch (err) {
      generatorFailed = true;
      console.error('[plan/fast] writing-engine generator failed:', err.message);
      // Fall through with the empty skeleton — the user can still iterate.
    }

    if (generated && Array.isArray(generated.sections) && generated.sections.length > 0) {
      // Merge generator output into the draft. Only overwrite empty
      // fields so we don't clobber any user edits between draft create
      // and fast call.
      const fields = ['targetAudience', 'angle', 'thesis'];
      for (const f of fields) {
        if (!plan[f] && generated[f]) plan[f] = generated[f];
      }
      if ((plan.sections || []).length === 0 && Array.isArray(generated.sections)) {
        plan.sections = generated.sections;
      }
      try {
        await plan.save();
      } catch (err) {
        if (handleSaveError(err, res)) return;
        throw err;
      }
    }

    res.status(200).json({
      plan,
      mode: content.mode,
      // 16a: the draft is always usable, but a 200 with 0 sections used to hide
      // WHY — a writing-engine outage looked identical to a legitimately empty
      // skeleton. Surface the generator outcome so the FE can show "couldn't
      // auto-build a plan, start from scratch" instead of a silent blank.
      ...(generatorFailed && { warning: 'plan_generator_unavailable' }),
      event: {
        type: 'fast_plan_proposed',
        planId: plan._id,
        version: plan.version,
        sections: (plan.sections || []).length,
        generated: !generatorFailed && !!(generated && Array.isArray(generated.sections) && generated.sections.length > 0),
      },
    });
  } catch (err) {
    if (handleSaveError(err, res)) return;
    console.error('plan/fast error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate fast plan' });
  }
};

// ─── GET /plan/estimate ───────────────────────────────────────────────
//
// Cost-estimate UI: returns the workspace's rolling p25/p50/p75 of token
// spend for plan-mode runs at this content's contentType, plus a small
// sampleSize so the frontend can hide the band when the data is thin.
//
// Why "workspace" scope: pricing varies per Anthropic API key, and the
// agent's prompt is workspace-bound. Aggregating globally would mix
// experimental and production usage.

const estimate = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const band = await AgentUsageLog.computeBand(content.workspaceId, {
      contentType: content.contentType || '',
      mode: 'plan',
    });
    res.json({
      contentType: content.contentType || '',
      mode: 'plan',
      ...band,
    });
  } catch (err) {
    console.error('plan/estimate error:', err);
    res.status(500).json({ error: err.message || 'Failed to compute estimate' });
  }
};

module.exports = {
  enter,
  fast,
  get,
  patch,
  approve,
  reject,
  reopen,
  continueResume,
  history,
  estimate,
};
