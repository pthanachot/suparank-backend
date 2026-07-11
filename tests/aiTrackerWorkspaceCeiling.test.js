/**
 * Fix #1 — the AI Tracker BULK create paths (setup / createMonitor) now enforce
 * the client-billed workspace's OWN plan cap on prompts, not just the agency
 * org's wholesale cap. Before this, a client could blow past the prompt
 * allocation the agency sold them by submitting a big prompt array in one call
 * (the single-prompt routes were capped via rq(); the bulk paths were not).
 *
 * Drives the real controllers with the tier/quota deps stubbed. The over-limit
 * path returns 429 BEFORE any tracker creation, so no AiTracker/prompt/scan
 * mocking is needed. Verifies the workspace counter is incremented then rolled
 * back (net zero) on the reject.
 *
 * (The unbilled/dark no-op is a trivial `if (wsLimits)` guard over
 * resolveWorkspacePlanLimits — which returns null off-flag — and is covered in
 * workspaceQuota.test.js, so it is not re-driven through the full handler here.)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiTrackerController = require('../src/controllers/aiTrackerController');
const tierService = require('../src/services/tierService');
const workspaceQuotaService = require('../src/services/workspaceQuotaService');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');

const real = {
  getCfg: tierService.getOrgTierConfig,
  resolve: workspaceQuotaService.resolveWorkspacePlanLimits,
  wutInc: WorkspaceUsageTracker.increment,
};

let wsIncs;

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function makeReq() {
  return {
    workspace: { _id: 'ws1', organizationId: 'org1' },
    body: { domain: 'example.com', name: 'Client site', prompts: ['a', 'b', 'c', 'd', 'e'], platforms: [] },
    user: { userId: 'u1' },
  };
}

beforeEach(() => {
  wsIncs = [];
  // Org tier imposes NO prompt/monitor cap → isolates the workspace ceiling.
  tierService.getOrgTierConfig = async () => ({
    config: { maxAiTrackerMonitors: null, maxAiTrackerPromptsPerMonth: null },
    tier: 'agency',
  });
  // Client plan allows only 2 prompts/month; the call submits 5.
  workspaceQuotaService.resolveWorkspacePlanLimits = async () => ({ maxAiTrackerPromptsPerMonth: 2 });
  WorkspaceUsageTracker.increment = async (w, k, p, amt) => {
    wsIncs.push(amt);
    // After the +5 provisional bump the running total is 5 (over the cap of 2).
    return { aiTrackerPromptsCreated: 5 };
  };
});

afterEach(() => {
  tierService.getOrgTierConfig = real.getCfg;
  workspaceQuotaService.resolveWorkspacePlanLimits = real.resolve;
  WorkspaceUsageTracker.increment = real.wutInc;
});

for (const handler of ['setup', 'createMonitor']) {
  describe(`${handler}() — workspace prompt ceiling (Fix #1)`, () => {
    it('rejects a bulk create that exceeds the client plan cap with 429 scope:workspace', async () => {
      const req = makeReq();
      const res = mockRes();
      await aiTrackerController[handler](req, res);

      assert.equal(res.statusCode, 429, 'bulk create over the workspace cap must 429');
      assert.equal(res.body.code, 'QUOTA_EXCEEDED');
      assert.equal(res.body.quota.scope, 'workspace', 'attributed to the workspace, not the org');
      assert.equal(res.body.quota.limit, 2);
      assert.equal(res.body.quota.limitKey, 'maxAiTrackerPromptsPerMonth');
      assert.equal(res.body.quota.used, 0, 'used = newTotal(5) − requested(5) = 0 prior usage');
    });

    it('rolls the workspace counter back to net-zero on the reject', async () => {
      const req = makeReq();
      const res = mockRes();
      await aiTrackerController[handler](req, res);
      // +5 provisional bump, then −5 rollback when the ceiling check trips.
      assert.deepEqual(wsIncs, [5, -5]);
    });
  });
}
