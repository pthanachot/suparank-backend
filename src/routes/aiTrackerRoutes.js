const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const mongoose = require('mongoose');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTracker = require('../models/AiTracker');
const aiTrackerController = require('../controllers/aiTrackerController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');
// Phase 8: the GRANULAR (v4 Table-3) policy gate — imported under its real name
// so the CI un-gated-credit-route guard's source scan matches `requirePermission('...')`.
const { requirePermission } = require('../middleware/permissions.policy');
const { requireQuota: rq } = require('../middleware/tierEnforcement');
const { requireCredits: rc } = require('../middleware/creditGate');
const { resolveCredits } = require('../config/creditRules');

// F4-14: live estimator for the scan credit gate. Was a literal `5` —
// allowed users with very low balances to pass the gate, then hit
// insufficient credits inside executeScan B6 which silently sets scanError
// (user clicks "Scan", nothing happens). The live estimate counts the active
// prompts that will actually run.
//
// Phase 6: on-demand refresh-all costs 5 × active prompts (Table 2), matching
// executeScan's fixed per-prompt deduction (was prompts × platforms × 4).
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
    return Math.max(1, resolveCredits('trackerRefreshAll', { activePrompts: promptCount }));
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
router.put('/:workspaceNumber/ai-tracker', ...rwrAiTracker, requirePermission('tracker.manageMonitor'), aiTrackerController.updateTracker);

// Prompt suggestions (LLM-generated, domain-scoped — shared by all monitors).
// Phase 6: flat prompt-research charge (10; Free draws from the 200 sample pool).
// Controller finalizes with deductForRequest only when the LLM actually ran.
const estPromptResearch = (_req, { tier }) => resolveCredits('promptResearch', { tier });
// Phase 8: single on-demand refresh is a flat 5 (one prompt, all engines).
const estRefreshSingle = () => resolveCredits('trackerRefreshSingle');
router.post('/:workspaceNumber/ai-tracker/suggest-prompts', ...rwrAiTracker, requirePermission('tracker.managePrompts'), rc('promptResearch', estPromptResearch), aiTrackerController.suggestPrompts);

// Setup (onboarding) — creates the tracker/monitor → manageMonitor (Admin+)
router.post('/:workspaceNumber/ai-tracker/setup', ...rwrAiTracker, requirePermission('tracker.manageMonitor'), aiTrackerController.setup);

// Historical scan details (shared handler — resolves legacy vs multi-monitor via req.params.monitorId)
router.get('/:workspaceNumber/ai-tracker/scan-details', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanDetails);

// Scan status & trigger
router.get('/:workspaceNumber/ai-tracker/scan', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanStatus);
// Refresh-all (5×n) → Admin+ (tracker.refreshAll)
router.post('/:workspaceNumber/ai-tracker/scan', ...rwrAiTracker, requirePermission('tracker.refreshAll'), rc('aiTrackerScan', estimateScanCredits), aiTrackerController.triggerScan);

// Single on-demand refresh (5, one prompt) → Editor+ (tracker.refreshOne)
router.post('/:workspaceNumber/ai-tracker/prompts/:promptId/refresh', ...rwrAiTracker, requirePermission('tracker.refreshOne'), rc('trackerRefreshSingle', estRefreshSingle), aiTrackerController.refreshPrompt);

// Prompt CRUD → Editor+ (tracker.managePrompts)
router.post('/:workspaceNumber/ai-tracker/prompts', ...rwrAiTracker, requirePermission('tracker.managePrompts'), rq('aiTrackerPromptsCreated', 'maxAiTrackerPromptsPerMonth', 'aiTrackerPromptLimitType'), aiTrackerController.addPrompt);
// Rec 11: "Track this keyword" from the editor — adds the content's keyword
// (+ up to 2 fanout queries) as ordinary tracker prompts. Same stack as
// addPrompt: quota-gated at add time; scans bill per-scan via the scheduler.
router.post('/:workspaceNumber/content/:contentNumber/track-keyword', ...rwrAiTracker, requirePermission('tracker.managePrompts'), rq('aiTrackerPromptsCreated', 'maxAiTrackerPromptsPerMonth', 'aiTrackerPromptLimitType'), aiTrackerController.trackContentKeyword);
router.post('/:workspaceNumber/ai-tracker/prompts/bulk-delete', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.bulkDeletePrompts);
router.put('/:workspaceNumber/ai-tracker/prompts/:promptId', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.updatePrompt);
router.delete('/:workspaceNumber/ai-tracker/prompts/:promptId', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.removePrompt);

// Competitor CRUD → Editor+ (tracker.managePrompts covers prompts/competitors)
router.post('/:workspaceNumber/ai-tracker/competitors/dismiss', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.dismissSuggestedCompetitor);
router.post('/:workspaceNumber/ai-tracker/competitors', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.addCompetitor);
router.delete('/:workspaceNumber/ai-tracker/competitors/:competitorId', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.removeCompetitor);

// ═══════════════════════════════════════════════════════════════════════════
// Multi-monitor routes
// ═══════════════════════════════════════════════════════════════════════════

// Monitor list & create → create is manageMonitor (Admin+)
router.get('/:workspaceNumber/ai-tracker/monitors', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.listMonitors);
router.post('/:workspaceNumber/ai-tracker/monitors', ...rwrAiTracker, requirePermission('tracker.manageMonitor'), aiTrackerController.createMonitor);

// Single monitor CRUD → update/delete are manageMonitor (Admin+)
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getMonitor);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId', ...rwrAiTracker, requirePermission('tracker.manageMonitor'), aiTrackerController.updateMonitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId', ...rwrAiTracker, requirePermission('tracker.manageMonitor'), aiTrackerController.deleteMonitor);

// Monitor-scoped historical scan details
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan-details', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getScanDetails);

// Monitor-scoped scan → refresh-all (Admin+)
router.get('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', ...rwrAiTracker, rp('aiTracker', 'read'), aiTrackerController.getMonitorScanStatus);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/scan', ...rwrAiTracker, requirePermission('tracker.refreshAll'), rc('aiTrackerScan', estimateScanCredits), aiTrackerController.triggerMonitorScan);

// Monitor-scoped single on-demand refresh (Editor+)
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId/refresh', ...rwrAiTracker, requirePermission('tracker.refreshOne'), rc('trackerRefreshSingle', estRefreshSingle), aiTrackerController.refreshPrompt);

// Monitor-scoped prompts → Editor+ (tracker.managePrompts)
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts', ...rwrAiTracker, requirePermission('tracker.managePrompts'), rq('aiTrackerPromptsCreated', 'maxAiTrackerPromptsPerMonth', 'aiTrackerPromptLimitType'), aiTrackerController.addMonitorPrompt);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/bulk-delete', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.bulkDeleteMonitorPrompts);
router.put('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.updateMonitorPrompt);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.removeMonitorPrompt);

// Monitor-scoped competitors → Editor+ (tracker.managePrompts)
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/dismiss', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.dismissMonitorSuggestedCompetitor);
router.post('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.addMonitorCompetitor);
router.delete('/:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/:competitorId', ...rwrAiTracker, requirePermission('tracker.managePrompts'), aiTrackerController.removeMonitorCompetitor);

module.exports = router;
