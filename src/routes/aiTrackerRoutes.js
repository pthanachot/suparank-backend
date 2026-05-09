const express = require('express');
const router = express.Router();
const aiTrackerController = require('../controllers/aiTrackerController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');

// All AI tracker routes require authentication
router.use(authenticateToken);

// Shared middleware: resolve workspace + check feature flag
const rwrAiTracker = [rwr, rf('aiTracker')];

// ═══════════════════════════════════════════════════════════════════════════
// Legacy single-monitor routes (backward compatible)
// ═══════════════════════════════════════════════════════════════════════════

// Tracker dashboard
router.get('/:workspaceNumber/ai-tracker', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getTracker);
router.put('/:workspaceNumber/ai-tracker', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.updateTracker);

// Prompt suggestions (LLM-generated, domain-scoped — shared by all monitors)
router.post('/:workspaceNumber/ai-tracker/suggest-prompts', ...rwrAiTracker, rp('aiTracker', 'use'), aiTrackerController.suggestPrompts);

// Setup (onboarding)
router.post('/:workspaceNumber/ai-tracker/setup', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.setup);

// Scan status & trigger
router.get('/:workspaceNumber/ai-tracker/scan', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanStatus);
router.post('/:workspaceNumber/ai-tracker/scan', ...rwrAiTracker, rp('aiTracker', 'use'), aiTrackerController.triggerScan);

// Prompt CRUD
router.post('/:workspaceNumber/ai-tracker/prompts', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.addPrompt);
router.post('/:workspaceNumber/ai-tracker/prompts/bulk-delete', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.bulkDeletePrompts);
router.put('/:workspaceNumber/ai-tracker/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.updatePrompt);
router.delete('/:workspaceNumber/ai-tracker/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removePrompt);

// Competitor CRUD
router.post('/:workspaceNumber/ai-tracker/competitors', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.addCompetitor);
router.delete('/:workspaceNumber/ai-tracker/competitors/:competitorId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removeCompetitor);

// ═══════════════════════════════════════════════════════════════════════════
// Multi-monitor routes
// ═══════════════════════════════════════════════════════════════════════════

// Monitor list & create
router.get('/:workspaceNumber/ai-tracker/monitors', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.listMonitors);
router.post('/:workspaceNumber/ai-tracker/monitors', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.createMonitor);

// Single monitor CRUD
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getMonitor);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.updateMonitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.deleteMonitor);

// Monitor-scoped scan
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getMonitorScanStatus);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', ...rwrAiTracker, rp('aiTracker', 'use'), aiTrackerController.triggerMonitorScan);

// Monitor-scoped prompts
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.addMonitorPrompt);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/bulk-delete', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.bulkDeleteMonitorPrompts);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.updateMonitorPrompt);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removeMonitorPrompt);

// Monitor-scoped competitors
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.addMonitorCompetitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/:competitorId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removeMonitorCompetitor);

module.exports = router;
