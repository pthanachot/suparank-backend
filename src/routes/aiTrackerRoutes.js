const express = require('express');
const router = express.Router();
const aiTrackerController = require('../controllers/aiTrackerController');
const { authenticateToken } = require('../middleware/auth');

// All AI tracker routes require authentication
router.use(authenticateToken);

// Tracker dashboard
router.get('/:workspaceNumber/ai-tracker', aiTrackerController.getTracker);
router.put('/:workspaceNumber/ai-tracker', aiTrackerController.updateTracker);

// Prompt suggestions (LLM-generated)
router.post('/:workspaceNumber/ai-tracker/suggest-prompts', aiTrackerController.suggestPrompts);

// Setup (onboarding)
router.post('/:workspaceNumber/ai-tracker/setup', aiTrackerController.setup);

// Scan status & trigger
router.get('/:workspaceNumber/ai-tracker/scan', aiTrackerController.getScanStatus);
router.post('/:workspaceNumber/ai-tracker/scan', aiTrackerController.triggerScan);

// Prompt CRUD
router.post('/:workspaceNumber/ai-tracker/prompts', aiTrackerController.addPrompt);
router.post('/:workspaceNumber/ai-tracker/prompts/bulk-delete', aiTrackerController.bulkDeletePrompts);
router.put('/:workspaceNumber/ai-tracker/prompts/:promptId', aiTrackerController.updatePrompt);
router.delete('/:workspaceNumber/ai-tracker/prompts/:promptId', aiTrackerController.removePrompt);

// Competitor CRUD
router.post('/:workspaceNumber/ai-tracker/competitors', aiTrackerController.addCompetitor);
router.delete('/:workspaceNumber/ai-tracker/competitors/:competitorId', aiTrackerController.removeCompetitor);

module.exports = router;
