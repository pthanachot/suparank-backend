const express = require('express');
const router = express.Router();
const workspaceController = require('../controllers/workspaceController');
const contentController = require('../controllers/contentController');
const analysisController = require('../controllers/analysisController');
const aiController = require('../controllers/aiController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');
const { requireQuota: rq } = require('../middleware/tierEnforcement');
const { requireCredits: rc } = require('../middleware/creditGate');
const { rejectIfLocked, contentLockResolver } = require('../middleware/lockGuard');

// All workspace routes are protected
router.use(authenticateToken);

// Workspace (no RBAC — finds/creates for authenticated user)
router.get('/', workspaceController.getWorkspace);

// Content under workspace: /api/workspace/:workspaceNumber/content
router.get('/:workspaceNumber/content', rwr, rp('content', 'read'), contentController.listContents);
router.post('/:workspaceNumber/content', rwr, rp('content', 'create'), rq('articlesCreated', 'maxArticlesPerMonth', 'articleLimitType'), contentController.createContent);
router.get('/:workspaceNumber/content/:contentNumber', rwr, rp('content', 'read'), contentController.getContent);
router.put('/:workspaceNumber/content/:contentNumber', rwr, rp('content', 'update'), rejectIfLocked(null, contentLockResolver), contentController.updateContent);
router.delete('/:workspaceNumber/content/:contentNumber', rwr, rp('content', 'delete'), contentController.deleteContent);

// Comments under content
router.post('/:workspaceNumber/content/:contentNumber/comments', rwr, rp('content', 'comment'), contentController.addComment);
router.put('/:workspaceNumber/content/:contentNumber/comments/:commentId', rwr, rp('content', 'comment'), contentController.updateComment);
router.delete('/:workspaceNumber/content/:contentNumber/comments/:commentId', rwr, rp('content', 'comment'), contentController.deleteComment);

// Content audit
router.post('/:workspaceNumber/content/:contentNumber/audit', rwr, rf('analysis'), rp('analysis', 'use'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), rc('contentAudit', 10), contentController.runAudit);
router.post('/:workspaceNumber/content/:contentNumber/writing-quality', rwr, rf('analysis'), rp('analysis', 'use'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), rc('writingQualityAudit', 10), contentController.runWritingQualityAudit);

// Analysis under content: /api/workspace/:workspaceNumber/content/:contentNumber/...
router.post('/:workspaceNumber/content/:contentNumber/analyze', rwr, rf('analysis'), rp('analysis', 'use'), rq('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'), analysisController.triggerAnalysis);
router.get('/:workspaceNumber/content/:contentNumber/benchmark', rwr, rf('analysis'), rp('analysis', 'read'), analysisController.getBenchmark);
router.post('/:workspaceNumber/content/:contentNumber/reanalyze', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.reanalyze);
router.post('/:workspaceNumber/content/:contentNumber/score', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.computeScore);
router.post('/:workspaceNumber/content/:contentNumber/readability-check', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.readabilityCheck);
router.post('/:workspaceNumber/content/:contentNumber/regenerate-outline', rwr, rf('analysis'), rp('analysis', 'use'), analysisController.regenerateOutline);

// AI writing under content: /api/workspace/:workspaceNumber/content/:contentNumber/ai/...
router.post('/:workspaceNumber/content/:contentNumber/ai/chat', rwr, rf('aiChat'), rp('aiChat', 'use'), rc('aiChat', 10), aiController.chat);
router.post('/:workspaceNumber/content/:contentNumber/ai/agent', rwr, rf('aiChat'), rp('aiChat', 'use'), rc('aiAgent', 10), aiController.agent);
router.post('/:workspaceNumber/content/:contentNumber/ai/generate-image', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.generateImage);
router.post('/:workspaceNumber/content/:contentNumber/ai/upload-image', rwr, rp('content', 'update'), aiController.uploadImage);
router.post('/:workspaceNumber/content/:contentNumber/ai/clarify-answer', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.clarifyAnswer);
router.post('/:workspaceNumber/content/:contentNumber/ai/plan-confirm', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.planConfirm);
router.post('/:workspaceNumber/content/:contentNumber/ai/tool-confirm', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.toolConfirm);
router.post('/:workspaceNumber/content/:contentNumber/ai/execution-mode', rwr, rf('aiChat'), rp('aiChat', 'use'), aiController.setExecutionMode);

module.exports = router;
