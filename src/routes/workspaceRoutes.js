const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const workspaceController = require('../controllers/workspaceController');
const contentController = require('../controllers/contentController');
const analysisController = require('../controllers/analysisController');
const opportunitiesController = require('../controllers/opportunitiesController');
const aiController = require('../controllers/aiController');
const planController = require('../controllers/planController');
const contextController = require('../controllers/contextController');
const reportController = require('../controllers/reportController');
const exportController = require('../controllers/exportController');
const erasureController = require('../controllers/erasureController');
const denyImpersonation = require('../middleware/denyImpersonation');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');
// Phase 10: granular v4 policy gate is authoritative on the credit-spending AI
// actions (ai.generate / ai.audit). CI route-scan guard matches `requirePermission('...')`.
const { requirePermission } = require('../middleware/permissions.policy');
const { requireQuota: rq } = require('../middleware/tierEnforcement');
const { requireCredits: rc } = require('../middleware/creditGate');
const { resolveCredits } = require('../config/creditRules');
const { rejectIfLocked, contentLockResolver } = require('../middleware/lockGuard');
const rateLimit = require('express-rate-limit');

// W5-b: ghost-text autocomplete fires on every typing pause, so it is EXCLUDED
// from the global per-IP apiLimiter (index.js) — which would 429 the whole app
// for an active writer — and metered here by its OWN per-user bucket instead.
// Keyed by userId (authenticateToken runs at router mount, line 58, so req.user
// is always set; IP is only a defensive fallback). Generous enough never to
// throttle real writing, tight enough to cap a runaway client loop. A throttled
// ghost-text call is a non-event: return 200 {completion:''} (identical to "no
// suggestion"), never a 429 error the editor would have to handle.
const autocompleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.userId || req.ip),
  handler: (_req, res) => res.status(200).json({ completion: '' }),
});

// Phase 6 credit-cost estimators (pull the amount from creditCosts/creditRules
// so Option B (Free fixed-bundle → 0) and mode-aware costs apply consistently).
// The gate passes { tier } as the 2nd arg. Pre-flight estimates for variable
// actions are conservative (max) and reconciled to actual by the controller.
const estAudit = (_req, { tier }) => resolveCredits('contentAudit', { tier });
const estChat = (_req, { tier }) => resolveCredits('aiChatMessage', { tier, tokens: 8001 }); // reserve 2, settle down
// Agent runs are classified per-command (see agentBilling.js): slash commands
// price as their mapped action (edit passes 25/2, image 10); Auto-write,
// unknown commands, and plan-execute writes price as articleGenerate (100,
// count-gated in aiController). Plan-execute detection needs the content's
// server-side mode/plan state — a minimal lean fetch (fail-open to the body
// classification: the controller re-classifies authoritatively anyway).
const { classifyAgentRun } = require('../config/agentBilling');
const Content = require('../models/Content');
const estAgent = async (req, { tier }) => {
  let content = null;
  try {
    // W2-d: fetch the FULL document once and stash it for the controller's
    // resolveContent — previously this was a duplicate read per agent request
    // (3-field lean here + full findByNumber in aiController). Same request,
    // no writes in between, so reuse is safe.
    content = await Content.findByNumber(req.workspace._id, req.params.contentNumber);
    if (content) req._prefetchedContent = content;
  } catch { /* fall back to body-only classification */ }
  return resolveCredits(classifyAgentRun(req.body, content), { tier });
};
// Phase 6 flat à-la-carte estimators (image, import, re-score, brief/outline,
// internal-links). None is a fixed-bundle-free action, so resolveCredits returns
// the flat Table-2 price for EVERY tier — Free funds it from the 200 sample pool.
// Controllers finalize with creditService.deductForRequest AFTER the op succeeds.
const estFixed = (action) => (_req, { tier }) => resolveCredits(action, { tier });

// All workspace routes are protected
router.use(authenticateToken);

// Workspace (no RBAC — finds/creates for authenticated user)
router.get('/', workspaceController.getWorkspace);

// M5 user-facing skills endpoint — proxies the internal bridge so the
// frontend (which doesn't hold INTERNAL_API_KEY) can list skills loaded
// by the Go writing-engine. Auth is the workspaceRoutes-global token check.
router.get('/skills', aiController.listSkills);

// Content under workspace: /api/workspace/:workspaceNumber/content
router.get('/:workspaceNumber/content', rwr, rp('content', 'read'), contentController.listContents);

// Phase 18B (DARK behind `dataExport`): download all of a workspace's data as a
// tar.gz (content MD/HTML/JSON, AI-tracker history, reports, keyword history,
// brand voices) — offboarding + GDPR portability. Gated on brandVoice:read (NOT
// content:read): the bundle includes brand voices, which the external 'client'
// role is denied — content:read alone would leak that agency IP to clients. This
// permission admits owner/admin/editor/viewer and excludes 'client'.
router.get('/:workspaceNumber/export', rf('dataExport'), rwr, rp('brandVoice', 'read'), exportController.exportWorkspace);
// Phase 18C data erasure (DARK) — hard-delete a workspace. Owner/admin + name
// confirmation are enforced in the controller (not a plain rp permission).
router.delete('/:workspaceNumber/erase', denyImpersonation, rf('dataErasure'), rwr, erasureController.eraseWorkspace);
router.post('/:workspaceNumber/content', rwr, rp('content', 'create'), rq('articlesCreated', 'maxArticlesPerMonth', 'articleLimitType'), contentController.createContent);
router.get('/:workspaceNumber/content/:contentNumber', rwr, rp('content', 'read'), contentController.getContent);
router.put('/:workspaceNumber/content/:contentNumber', rwr, rp('content', 'update'), rejectIfLocked(null, contentLockResolver), contentController.updateContent);
router.delete('/:workspaceNumber/content/:contentNumber', rwr, rp('content', 'delete'), contentController.deleteContent);

// Per-user favorite toggle (content-editors star). Gated on content:read, NOT
// content:update, so viewers/clients can star what they can see — same reasoning
// as content:comment. No rejectIfLocked: this writes per-user metadata, not the
// document's content.
router.put('/:workspaceNumber/content/:contentNumber/favorite', rwr, rp('content', 'read'), contentController.setFavorite);

// Comments under content. B4: add/update mutate the locked doc's comments[] —
// gate them like updateContent (rejectIfLocked). DELETE stays exempt (a member
// may still remove a comment on a locked doc, same delete-a-locked-resource rule).
router.post('/:workspaceNumber/content/:contentNumber/comments', rwr, rp('content', 'comment'), rejectIfLocked(null, contentLockResolver), contentController.addComment);
router.put('/:workspaceNumber/content/:contentNumber/comments/:commentId', rwr, rp('content', 'comment'), rejectIfLocked(null, contentLockResolver), contentController.updateComment);
router.delete('/:workspaceNumber/content/:contentNumber/comments/:commentId', rwr, rp('content', 'comment'), contentController.deleteComment);

// Content audit
router.post('/:workspaceNumber/content/:contentNumber/audit', rwr, rf('analysis'), requirePermission('ai.audit'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), rc('contentAudit', estAudit), contentController.runAudit);
router.post('/:workspaceNumber/content/:contentNumber/writing-quality', rwr, rf('analysis'), requirePermission('ai.audit'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), rc('writingQualityAudit', estAudit), contentController.runWritingQualityAudit);

// Analysis under content: /api/workspace/:workspaceNumber/content/:contentNumber/...
router.post('/:workspaceNumber/content/:contentNumber/analyze', rwr, rf('analysis'), rp('analysis', 'use'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), analysisController.triggerAnalysis);
router.get('/:workspaceNumber/content/:contentNumber/benchmark', rwr, rf('analysis'), rp('analysis', 'read'), analysisController.getBenchmark);

// Outcome feedback (Rec 14) — score/position/clicks history + deltas for the
// Results panel. Read-only Mongo; 'read' so viewers see results too.
router.get('/:workspaceNumber/content/:contentNumber/outcomes', rwr, rf('analysis'), rp('analysis', 'read'), analysisController.getOutcomes);

// AI crawler access audit (Rec 7) — deterministic robots.txt + CDN check,
// 7-day cached on the Site; no quota (2-4 cheap HTTP fetches, no LLM).
router.get('/:workspaceNumber/site/bot-access', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.getBotAccess);

// GSC Opportunities (Rec 15) — viewing is free (read); apply/dismiss mutate (use).
router.get('/:workspaceNumber/opportunities', rwr, rf('analysis'), rp('analysis', 'read'), opportunitiesController.getWorkspaceOpportunities);
router.get('/:workspaceNumber/content/:contentNumber/opportunities', rwr, rf('analysis'), rp('analysis', 'read'), opportunitiesController.getContentOpportunities);
router.post('/:workspaceNumber/opportunities/:id/apply', rwr, rf('analysis'), rp('analysis', 'use'), opportunitiesController.applyOpportunity);
router.post('/:workspaceNumber/opportunities/:id/dismiss', rwr, rf('analysis'), rp('analysis', 'use'), opportunitiesController.dismissOpportunity);

// Internal-link inventory (same list pushed to the writing engine as brief.availableLinks)
router.get('/:workspaceNumber/content/:contentNumber/available-links', rwr, rp('content', 'read'), contentController.getAvailableLinks);
router.get('/:workspaceNumber/content/:contentNumber/movement', rwr, rp('content', 'read'), contentController.getMovement);
router.post('/:workspaceNumber/content/:contentNumber/reanalyze', rwr, rf('analysis'), requirePermission('ai.audit'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), rc('reScore', estFixed('reScore')), analysisController.reanalyze);
// Phase 1: free retry after a TRANSIENT engine failure — deliberately NO rq/rc
// billing (our fault, not the user's). Server-gated to transient-failed content.
router.post('/:workspaceNumber/content/:contentNumber/retry-analysis', rwr, rf('analysis'), requirePermission('ai.audit'), analysisController.retryAnalysis);
// NOTE: the /score endpoint (backend scorer) was removed — scoring is done
// entirely client-side in the editor (scoreContent.ts). Term counts still come
// from the engine via /score-terms below.
router.post('/:workspaceNumber/content/:contentNumber/score-terms', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.scoreTerms);
router.post('/:workspaceNumber/content/:contentNumber/import-url', rwr, requirePermission('ai.generate'), rc('importUrl', estFixed('importUrl')), analysisController.importUrl);
router.post('/:workspaceNumber/content/:contentNumber/internal-links', rwr, requirePermission('ai.generate'), rc('internalLinks', estFixed('internalLinks')), analysisController.internalLinks);
router.post('/:workspaceNumber/content/:contentNumber/readability-check', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.readabilityCheck);
router.post('/:workspaceNumber/content/:contentNumber/regenerate-outline', rwr, rf('analysis'), requirePermission('ai.generate'), rc('briefOutline', estFixed('briefOutline')), analysisController.regenerateOutline);

// Monthly reports (Phase 14): /api/workspace/:workspaceNumber/reports
// 'analysis' read = client-visible; 'analysis' use = editors+; share
// management is owner/admin only ('members' manage).
// Reports feature-gating: only GENERATE (which consumes the analysis pipeline
// to build a NEW report) is gated by rf('analysis') — matching how sibling
// analysis routes gate the resource-consuming action. Viewing/downloading/
// sharing EXISTING reports is intentionally NOT feature-gated, for two reasons:
// (1) it mirrors the downgrade model (existing resources stay readable, not
// hidden), and (2) it keeps share-REVOKE reachable through the reports UI so a
// downgraded org can still kill a live public link (gating the list — the only
// path to ShareModal — would make revoke UI-unreachable). A never-entitled tier
// simply has no reports to list, since generate is gated. Share create/revoke
// stay owner/admin via members.manage.
router.get('/:workspaceNumber/reports', rwr, rp('analysis', 'read'), reportController.listReports);
router.post('/:workspaceNumber/reports/generate', rwr, rf('analysis'), rp('analysis', 'use'), reportController.generateReport);
router.get('/:workspaceNumber/reports/:period', rwr, rp('analysis', 'read'), reportController.getReport);
router.post('/:workspaceNumber/reports/:period/share', rwr, rp('members', 'manage'), reportController.createShareLink);
router.delete('/:workspaceNumber/reports/:period/share', rwr, rp('members', 'manage'), reportController.revokeShareLink);
router.get('/:workspaceNumber/reports/:period/pdf', rwr, rp('analysis', 'read'), reportController.downloadPdf);

// AI writing under content: /api/workspace/:workspaceNumber/content/:contentNumber/ai/...
router.post('/:workspaceNumber/content/:contentNumber/ai/chat', rwr, rf('aiChat'), requirePermission('ai.generate'), rc('aiChat', estChat), aiController.chat);
router.post('/:workspaceNumber/content/:contentNumber/ai/agent', rwr, rf('aiChat'), requirePermission('ai.generate'), rc('aiAgent', estAgent), aiController.agent);
router.post('/:workspaceNumber/content/:contentNumber/ai/generate-image', rwr, rf('aiChat'), requirePermission('ai.generate'), rc('imageGenerate', estFixed('imageGenerate')), aiController.generateImage);
router.post('/:workspaceNumber/content/:contentNumber/ai/inline-edit', rwr, rf('aiChat'), requirePermission('ai.generate'), rc('aiChat', estChat), aiController.inlineEdit);
// W5-b ghost text: the FLYWEIGHT AI route. Per-user limiter FIRST (shed
// over-limit calls before the workspace query). Feature-gated + the SAME v4
// policy (ai.generate) as chat/agent/inline-edit so authorization can't drift —
// it calls a paid model into the user's doc. Both gates are CACHED (~free). NO
// credit gate (rc): it is free (COGS-ledger only). No doc push either — see
// setupSessionAutocomplete.
router.post('/:workspaceNumber/content/:contentNumber/ai/autocomplete', autocompleteLimiter, rwr, rf('aiChat'), requirePermission('ai.generate'), aiController.autocomplete);
router.post('/:workspaceNumber/content/:contentNumber/ai/upload-image', rwr, rp('content', 'update'), aiController.uploadImage);
// R18: rehost a picked image-search result to B2 (SSRF-hardened). Gated like
// upload-image (content:update, no credit gate) — it's a content mutation with
// no LLM cost, not an AI feature.
router.post('/:workspaceNumber/content/:contentNumber/ai/rehost-image', rwr, rp('content', 'update'), aiController.rehostImage);
router.post('/:workspaceNumber/content/:contentNumber/ai/clarify-answer', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.clarifyAnswer);
router.post('/:workspaceNumber/content/:contentNumber/ai/plan-confirm', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.planConfirm);
// W4-a/b/c: mid-run side-channels + run status. Gated like the confirm family
// (no rc credit gate: steering tokens ride the run's own usage tap; stop-revert
// and run-status consume nothing).
router.post('/:workspaceNumber/content/:contentNumber/ai/steer', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.steer);
router.post('/:workspaceNumber/content/:contentNumber/ai/stop-revert', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.stopRevert);
router.post('/:workspaceNumber/content/:contentNumber/ai/stop', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.stopRun);
router.get('/:workspaceNumber/content/:contentNumber/ai/run-status', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.runStatus);
router.get('/:workspaceNumber/content/:contentNumber/ai/engine-content', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.engineContent);
// Threads Phase 1: durable conversation history. Gated on the aiThreads flag
// (rf — the same flag also gates the capture writes via flagService inside
// the handlers) + the aiChat permission family like run-status. No rc.
router.get('/:workspaceNumber/content/:contentNumber/ai/thread', rwr, rf('aiThreads'), rp('aiChat', 'use'), aiController.getThread);
router.post('/:workspaceNumber/content/:contentNumber/ai/threads', rwr, rf('aiThreads'), rp('aiChat', 'use'), aiController.newThread);
// Threads Phase 4: picker list + resume-an-archived-conversation.
router.get('/:workspaceNumber/content/:contentNumber/ai/threads', rwr, rf('aiThreads'), rp('aiChat', 'use'), aiController.listThreads);
router.post('/:workspaceNumber/content/:contentNumber/ai/threads/:threadId/activate', rwr, rf('aiThreads'), rp('aiChat', 'use'), aiController.activateThread);
// Conversations Phase 2: rename. Same four-middleware shape as its siblings —
// threadCapture/threadUx assert that shape, and a route that gates differently
// is how a permission hole gets introduced by copy-paste.
router.patch('/:workspaceNumber/content/:contentNumber/ai/threads/:threadId', rwr, rf('aiThreads'), rp('aiChat', 'use'), aiController.renameThread);
// Conversations Phase 5: permanent delete. Same four-middleware shape; the
// handler carries the in-flight guard and the Phase-4 session eviction.
router.delete('/:workspaceNumber/content/:contentNumber/ai/threads/:threadId', rwr, rf('aiThreads'), rp('aiChat', 'use'), aiController.deleteThread);

// Plan mode under content (M1 — writing-engine plan mode).
// Gated like the confirm family (ai/plan-confirm): rf('aiChat') + rp('aiChat','use').
// The 'aiChat' resource only defines a 'use' action (configPermissions), and
// approve/reopen spend credits + trigger agent execution, so every route —
// including the GETs — requires 'use'; membership alone is insufficient.
router.post('/:workspaceNumber/content/:contentNumber/plan/enter', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.enter);
router.post('/:workspaceNumber/content/:contentNumber/plan/fast', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.fast);
router.get('/:workspaceNumber/content/:contentNumber/plan', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.get);
router.patch('/:workspaceNumber/content/:contentNumber/plan', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.patch);
router.post('/:workspaceNumber/content/:contentNumber/plan/approve', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.approve);
router.post('/:workspaceNumber/content/:contentNumber/plan/reject', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.reject);
router.post('/:workspaceNumber/content/:contentNumber/plan/reopen', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.reopen);
router.post('/:workspaceNumber/content/:contentNumber/plan/continue', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.continueResume);
router.get('/:workspaceNumber/content/:contentNumber/plan/history', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.history);
router.get('/:workspaceNumber/content/:contentNumber/plan/estimate', rwr, rf('aiChat'), rp('aiChat', 'use'), planController.estimate);

// CFS read-only endpoints for the frontend (M2 — user-facing transparency).
// Same gate: context surfaces the plan-mode working set, editor-tier only.
router.get('/:workspaceNumber/content/:contentNumber/context/list', rwr, rf('aiChat'), rp('aiChat', 'use'), contextController.userList);
router.get('/:workspaceNumber/content/:contentNumber/context/read', rwr, rf('aiChat'), rp('aiChat', 'use'), contextController.userRead);

module.exports = router;
