const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTracker = require('../models/AiTracker');
const aiTrackerController = require('../controllers/aiTrackerController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');
const { requireQuota: rq } = require('../middleware/tierEnforcement');
const { requireCredits: rc } = require('../middleware/creditGate');

// F4-14: live estimator for the scan credit gate. Was a literal `5` —
// allowed users with very low balances to pass the gate, then hit
// insufficient credits inside executeScan B6 which silently sets scanError
// (user clicks "Scan", nothing happens). The live estimate counts the
// prompts × platforms that will actually run.
//
// Falls back to a small constant on lookup error (rather than 0) so a
// transient Mongo issue doesn't accidentally let a free scan through.
async function estimateScanCredits(req) {
  try {
    const wsNum = Number(req.params.workspaceNumber);
    if (!wsNum) return 5;
    // Resolve tracker: legacy single-monitor by workspace, multi-monitor by id
    let tracker;
    if (req.params.monitorId && /^[0-9a-fA-F]{24}$/.test(req.params.monitorId)) {
      tracker = await AiTracker.findById(req.params.monitorId).select('_id workspaceId defaultModels').lean();
    } else {
      // Without monitorId, find the tracker via workspace. We don't have
      // req.workspace here (middleware chain order — actually we DO since
      // rwr ran before us, but lean and minimal).
      const ws = req.workspace;
      if (!ws) return 5;
      tracker = await AiTracker.findOne({ workspaceId: ws._id }).select('_id workspaceId defaultModels').lean();
    }
    if (!tracker) return 5;
    const promptCount = await AiTrackerPrompt.countDocuments({
      trackerId: tracker._id,
      active: { $ne: false },
      locked: { $ne: true },
    });
    const platformCount = Array.isArray(tracker.defaultModels) ? tracker.defaultModels.length : 0;
    return Math.max(1, promptCount * platformCount * 4);
  } catch (e) {
    console.warn('[ai-tracker] estimateScanCredits fallback to 5:', e.message);
    return 5;
  }
}

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

// Historical scan details (shared handler — resolves legacy vs multi-monitor via req.params.monitorId)
router.get('/:workspaceNumber/ai-tracker/scan-details', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanDetails);

// Scan status & trigger
router.get('/:workspaceNumber/ai-tracker/scan', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanStatus);
router.post('/:workspaceNumber/ai-tracker/scan', ...rwrAiTracker, rp('aiTracker', 'use'), rc('aiTrackerScan', estimateScanCredits), aiTrackerController.triggerScan);

// Prompt CRUD
router.post('/:workspaceNumber/ai-tracker/prompts', ...rwrAiTracker, rp('aiTracker', 'manage'), rq('aiTrackerPromptsCreated', 'maxAiTrackerPromptsPerMonth', 'aiTrackerPromptLimitType'), aiTrackerController.addPrompt);
router.post('/:workspaceNumber/ai-tracker/prompts/bulk-delete', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.bulkDeletePrompts);
router.put('/:workspaceNumber/ai-tracker/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.updatePrompt);
router.delete('/:workspaceNumber/ai-tracker/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removePrompt);

// Competitor CRUD
router.post('/:workspaceNumber/ai-tracker/competitors/dismiss', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.dismissSuggestedCompetitor);
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

// Monitor-scoped historical scan details
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan-details', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanDetails);

// Monitor-scoped scan
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getMonitorScanStatus);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', ...rwrAiTracker, rp('aiTracker', 'use'), rc('aiTrackerScan', estimateScanCredits), aiTrackerController.triggerMonitorScan);

// Monitor-scoped prompts
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts', ...rwrAiTracker, rp('aiTracker', 'manage'), rq('aiTrackerPromptsCreated', 'maxAiTrackerPromptsPerMonth', 'aiTrackerPromptLimitType'), aiTrackerController.addMonitorPrompt);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/bulk-delete', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.bulkDeleteMonitorPrompts);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.updateMonitorPrompt);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removeMonitorPrompt);

// Monitor-scoped competitors
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/dismiss', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.dismissMonitorSuggestedCompetitor);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.addMonitorCompetitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/:competitorId', ...rwrAiTracker, rp('aiTracker', 'manage'), aiTrackerController.removeMonitorCompetitor);

module.exports = router;
