const express = require('express');
const router = express.Router();
const aiTrackerController = require('../controllers/aiTrackerController');
const { authenticateToken } = require('../middleware/auth');

// All AI tracker routes require authentication
router.use(authenticateToken);

// ═══════════════════════════════════════════════════════════════════════════
// Legacy single-monitor routes (backward compatible)
// ═══════════════════════════════════════════════════════════════════════════

// Tracker dashboard
router.get('/:workspaceNumber/ai-tracker', aiTrackerController.getTracker);
router.put('/:workspaceNumber/ai-tracker', aiTrackerController.updateTracker);

// Prompt suggestions (LLM-generated, domain-scoped — shared by all monitors)
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

// ═══════════════════════════════════════════════════════════════════════════
// Multi-monitor routes
// ═══════════════════════════════════════════════════════════════════════════

// Monitor list & create
router.get('/:workspaceNumber/ai-tracker/monitors', aiTrackerController.listMonitors);
router.post('/:workspaceNumber/ai-tracker/monitors', aiTrackerController.createMonitor);

// Single monitor CRUD
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId', aiTrackerController.getMonitor);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId', aiTrackerController.updateMonitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId', aiTrackerController.deleteMonitor);

// Monitor-scoped scan
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', aiTrackerController.getMonitorScanStatus);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', aiTrackerController.triggerMonitorScan);

// Monitor-scoped prompts
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts', aiTrackerController.addMonitorPrompt);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/bulk-delete', aiTrackerController.bulkDeleteMonitorPrompts);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', aiTrackerController.updateMonitorPrompt);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', aiTrackerController.removeMonitorPrompt);

// Monitor-scoped competitors
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors', aiTrackerController.addMonitorCompetitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/:competitorId', aiTrackerController.removeMonitorCompetitor);

module.exports = router;
