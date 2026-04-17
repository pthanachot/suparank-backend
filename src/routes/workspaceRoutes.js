const express = require('express');
const router = express.Router();
const workspaceController = require('../controllers/workspaceController');
const contentController = require('../controllers/contentController');
const analysisController = require('../controllers/analysisController');
const aiController = require('../controllers/aiController');
const { authenticateToken } = require('../middleware/auth');

// All workspace routes are protected
router.use(authenticateToken);

// Workspace
router.get('/', workspaceController.getWorkspace);

// Content under workspace: /api/workspace/:workspaceNumber/content
router.get('/:workspaceNumber/content', contentController.listContents);
router.post('/:workspaceNumber/content', contentController.createContent);
router.get('/:workspaceNumber/content/:contentNumber', contentController.getContent);
router.put('/:workspaceNumber/content/:contentNumber', contentController.updateContent);
router.delete('/:workspaceNumber/content/:contentNumber', contentController.deleteContent);

// Analysis under content: /api/workspace/:workspaceNumber/content/:contentNumber/...
router.post('/:workspaceNumber/content/:contentNumber/analyze', analysisController.triggerAnalysis);
router.get('/:workspaceNumber/content/:contentNumber/benchmark', analysisController.getBenchmark);
router.post('/:workspaceNumber/content/:contentNumber/reanalyze', analysisController.reanalyze);
router.post('/:workspaceNumber/content/:contentNumber/score', analysisController.computeScore);
router.post('/:workspaceNumber/content/:contentNumber/readability-check', analysisController.readabilityCheck);
router.post('/:workspaceNumber/content/:contentNumber/regenerate-outline', analysisController.regenerateOutline);

// AI writing under content: /api/workspace/:workspaceNumber/content/:contentNumber/ai/...
router.post('/:workspaceNumber/content/:contentNumber/ai/chat', aiController.chat);
router.post('/:workspaceNumber/content/:contentNumber/ai/agent', aiController.agent);
router.post('/:workspaceNumber/content/:contentNumber/ai/generate-image', aiController.generateImage);
router.post('/:workspaceNumber/content/:contentNumber/ai/upload-image', aiController.uploadImage);

module.exports = router;
