/**
 * Phase 8 — single source of truth for AI-Tracker security coverage.
 *
 * parseRoutes() extracts every route from aiTrackerRoutes.js SOURCE, so the
 * completeness checks in security-rbac.test.js fail the moment someone adds
 * a route without declaring its gate expectation AND its tenancy-probe
 * status here. That is the Phase 8 exit criterion, made executable.
 */

const fs = require('fs');
const path = require('path');

const ROUTES_FILE = path.resolve(__dirname, '../../../src/routes/aiTrackerRoutes.js');

function parseRoutes() {
  const src = fs.readFileSync(ROUTES_FILE, 'utf8');
  const routes = [];
  const re = /router\.(get|post|put|delete)\(\s*'([^']+)'\s*,([^;]*?)aiTrackerController\.(\w+)/gs;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, method, routePath, middle, handler] = m;
    routes.push({
      id: `${method.toUpperCase()} ${routePath}`,
      method: method.toUpperCase(),
      path: routePath,
      handler,
      gates: {
        policy: [...middle.matchAll(/requirePermission\('([^']+)'\)/g)].map((x) => x[1]),
        legacy: [...middle.matchAll(/rp\('([^']+)',\s*'([^']+)'\)/g)].map((x) => `${x[1]}:${x[2]}`),
        quota: /rq\(/.test(middle),
        credits: /rc\(/.test(middle),
      },
    });
  }
  return routes;
}

/**
 * Expected gate per route id. `policy` = granular v4 key, `legacy` = old
 * Permission-grid pair. Every parsed route MUST have an entry.
 */
const EXPECTED_GATES = {
  'GET /:workspaceNumber/ai-tracker': { legacy: 'aiTracker:read' },
  'PUT /:workspaceNumber/ai-tracker': { policy: 'tracker.manageMonitor' },
  'POST /:workspaceNumber/ai-tracker/suggest-prompts': { policy: 'tracker.managePrompts', credits: true },
  'POST /:workspaceNumber/ai-tracker/setup': { policy: 'tracker.manageMonitor' },
  'GET /:workspaceNumber/ai-tracker/scan-details': { legacy: 'aiTracker:read' },
  'GET /:workspaceNumber/ai-tracker/scan': { legacy: 'aiTracker:read' },
  'POST /:workspaceNumber/ai-tracker/scan': { policy: 'tracker.refreshAll', credits: true },
  'POST /:workspaceNumber/ai-tracker/prompts/:promptId/refresh': { policy: 'tracker.refreshOne', credits: true },
  'POST /:workspaceNumber/ai-tracker/prompts': { policy: 'tracker.managePrompts', quota: true },
  'POST /:workspaceNumber/content/:contentNumber/track-keyword': { policy: 'tracker.managePrompts', quota: true },
  'POST /:workspaceNumber/ai-tracker/prompts/bulk-delete': { policy: 'tracker.managePrompts' },
  'PUT /:workspaceNumber/ai-tracker/prompts/:promptId': { policy: 'tracker.managePrompts' },
  'DELETE /:workspaceNumber/ai-tracker/prompts/:promptId': { policy: 'tracker.managePrompts' },
  'POST /:workspaceNumber/ai-tracker/competitors/dismiss': { policy: 'tracker.managePrompts' },
  'POST /:workspaceNumber/ai-tracker/competitors': { policy: 'tracker.managePrompts' },
  'DELETE /:workspaceNumber/ai-tracker/competitors/:competitorId': { policy: 'tracker.managePrompts' },
  'GET /:workspaceNumber/ai-tracker/monitors': { legacy: 'aiTracker:read' },
  'POST /:workspaceNumber/ai-tracker/monitors': { policy: 'tracker.manageMonitor' },
  'GET /:workspaceNumber/ai-tracker/monitors/:monitorId': { legacy: 'aiTracker:read' },
  'PUT /:workspaceNumber/ai-tracker/monitors/:monitorId': { policy: 'tracker.manageMonitor' },
  'DELETE /:workspaceNumber/ai-tracker/monitors/:monitorId': { policy: 'tracker.manageMonitor' },
  'GET /:workspaceNumber/ai-tracker/monitors/:monitorId/scan-details': { legacy: 'aiTracker:read' },
  'GET /:workspaceNumber/ai-tracker/monitors/:monitorId/scan': { legacy: 'aiTracker:read' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/scan': { policy: 'tracker.refreshAll', credits: true },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId/refresh': { policy: 'tracker.refreshOne', credits: true },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts': { policy: 'tracker.managePrompts', quota: true },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/bulk-delete': { policy: 'tracker.managePrompts' },
  'PUT /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId': { policy: 'tracker.managePrompts' },
  'DELETE /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId': { policy: 'tracker.managePrompts' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/dismiss': { policy: 'tracker.managePrompts' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/competitors': { policy: 'tracker.managePrompts' },
  'DELETE /:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/:competitorId': { policy: 'tracker.managePrompts' },
};

/**
 * Tenancy coverage per route id: either { probe: '<test name in
 * security-tenancy.test.js>' } or { exempt: '<why no cross-tenant ids are
 * reachable>' }. Every parsed route MUST have an entry.
 */
const TENANCY_COVERAGE = {
  'GET /:workspaceNumber/ai-tracker': { exempt: 'workspace-scoped via rwr; no foreign ids in path/body' },
  'PUT /:workspaceNumber/ai-tracker': { exempt: 'resolveTracker(workspace) — operates on own workspace tracker only' },
  'POST /:workspaceNumber/ai-tracker/suggest-prompts': { exempt: 'takes only a domain string; no ids' },
  'POST /:workspaceNumber/ai-tracker/setup': { exempt: 'creates resources in own workspace only' },
  'GET /:workspaceNumber/ai-tracker/scan-details': { exempt: 'resolveTracker(workspace); date query only' },
  'GET /:workspaceNumber/ai-tracker/scan': { exempt: 'resolveTracker(workspace); no ids' },
  'POST /:workspaceNumber/ai-tracker/scan': { exempt: 'resolveTracker(workspace); no ids' },
  'POST /:workspaceNumber/ai-tracker/prompts/:promptId/refresh': { probe: 'refreshPrompt legacy: foreign promptId' },
  'POST /:workspaceNumber/ai-tracker/prompts': { exempt: 'creates under own resolveTracker(workspace) tracker' },
  'POST /:workspaceNumber/content/:contentNumber/track-keyword': { probe: 'trackContentKeyword: foreign contentNumber' },
  'POST /:workspaceNumber/ai-tracker/prompts/bulk-delete': { probe: 'legacy bulk-delete: foreign promptIds survive' },
  'PUT /:workspaceNumber/ai-tracker/prompts/:promptId': { probe: 'legacy updatePrompt: foreign promptId' },
  'DELETE /:workspaceNumber/ai-tracker/prompts/:promptId': { probe: 'legacy removePrompt: foreign promptId' },
  'POST /:workspaceNumber/ai-tracker/competitors/dismiss': { exempt: 'dismiss takes a NAME (no id) and writes to the own-workspace tracker resolved by resolveTracker — verified at controller :3808-3814' },
  'POST /:workspaceNumber/ai-tracker/competitors': { exempt: 'creates under own tracker' },
  'DELETE /:workspaceNumber/ai-tracker/competitors/:competitorId': { probe: 'legacy removeCompetitor: foreign competitorId' },
  'GET /:workspaceNumber/ai-tracker/monitors': { exempt: 'lists own workspace only' },
  'POST /:workspaceNumber/ai-tracker/monitors': { exempt: 'creates in own workspace' },
  'GET /:workspaceNumber/ai-tracker/monitors/:monitorId': { probe: 'getMonitor: foreign monitorId' },
  'PUT /:workspaceNumber/ai-tracker/monitors/:monitorId': { probe: 'updateMonitor: foreign monitorId' },
  'DELETE /:workspaceNumber/ai-tracker/monitors/:monitorId': { probe: 'deleteMonitor: foreign monitorId' },
  'GET /:workspaceNumber/ai-tracker/monitors/:monitorId/scan-details': { probe: 'getScanDetails: foreign monitorId' },
  'GET /:workspaceNumber/ai-tracker/monitors/:monitorId/scan': { probe: 'getMonitorScanStatus: foreign monitorId' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/scan': { probe: 'triggerMonitorScan: foreign monitorId' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId/refresh': { probe: 'refreshPrompt: own monitor + foreign promptId' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts': { probe: 'addMonitorPrompt: foreign monitorId' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/bulk-delete': { probe: 'bulkDeleteMonitorPrompts: foreign promptIds survive' },
  'PUT /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId': { probe: 'updateMonitorPrompt: foreign promptId under own monitor' },
  'DELETE /:workspaceNumber/ai-tracker/monitors/:monitorId/prompts/:promptId': { probe: 'removeMonitorPrompt: foreign promptId survives' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/dismiss': { probe: 'dismissMonitorSuggestedCompetitor: foreign monitorId' },
  'POST /:workspaceNumber/ai-tracker/monitors/:monitorId/competitors': { probe: 'addMonitorCompetitor: foreign monitorId' },
  'DELETE /:workspaceNumber/ai-tracker/monitors/:monitorId/competitors/:competitorId': { probe: 'removeMonitorCompetitor: foreign competitorId survives' },
};

module.exports = { parseRoutes, EXPECTED_GATES, TENANCY_COVERAGE };
