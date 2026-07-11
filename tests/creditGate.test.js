/**
 * Fix (Phase 17 review pass 2, Finding A) — the credit pre-flight gate funds a
 * CLIENT-BILLED workspace from the agency ORG pool only (subscription + general),
 * never the triggering member's personal user_free credits. This mirrors
 * preDeduct's B1 exclusion. Using balance.total (which includes user_free) would
 * let the gate pass on credits preDeduct then refuses to spend — starting an
 * expensive generation that fails (or silently no-ops) mid-way.
 *
 * Also asserts the non-billed path is unchanged (funds from total).
 *
 * Deps monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { requireCredits } = require('../src/middleware/creditGate');
const creditService = require('../src/services/creditService');
const tierService = require('../src/services/tierService');
const workspaceQuotaService = require('../src/services/workspaceQuotaService');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');

const real = {
  getBalance: creditService.getBalance,
  isFeatureEnabled: creditService.isFeatureEnabled,
  getCfg: tierService.getOrgTierConfig,
  resolve: workspaceQuotaService.resolveWorkspacePlanLimits,
  wutGet: WorkspaceUsageTracker.getCount,
};

let balance, wsLimits, wsUsed;

function mockRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqFor = () => ({ workspace: { _id: 'ws1', organizationId: 'org1' }, user: { userId: 'u1' } });

beforeEach(() => {
  // Agency org pool is nearly empty; the triggering member has fat personal credits.
  balance = { subscription: 2, general: 3, userFree: 20, total: 25 };
  wsLimits = null; // default: not client-billed
  wsUsed = 0;

  creditService.getBalance = async () => balance;
  creditService.isFeatureEnabled = () => true;
  tierService.getOrgTierConfig = async () => ({ tier: 'agency', config: { creditDeductionFlags: {} } });
  workspaceQuotaService.resolveWorkspacePlanLimits = async () => wsLimits;
  WorkspaceUsageTracker.getCount = async () => wsUsed;
});

afterEach(() => {
  creditService.getBalance = real.getBalance;
  creditService.isFeatureEnabled = real.isFeatureEnabled;
  tierService.getOrgTierConfig = real.getCfg;
  workspaceQuotaService.resolveWorkspacePlanLimits = real.resolve;
  WorkspaceUsageTracker.getCount = real.wutGet;
});

describe('requireCredits — client-billed workspace funds from org pool only (Finding A)', () => {
  it('402s a client-billed workspace when the ORG pool alone cannot afford it, even though user_free could', async () => {
    wsLimits = { creditsPerMonth: 1000 }; // client-billed, plenty of monthly cap headroom
    const req = reqFor();
    const res = mockRes();
    let nexted = false;
    await requireCredits('aiChat', 10)(req, res, () => { nexted = true; });

    assert.equal(nexted, false, 'must not pass the gate');
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(res.body.balance, 5, 'affordability = subscription(2)+general(3), NOT total(25)');
  });

  it('passes a client-billed workspace when the ORG pool alone can afford it', async () => {
    balance = { subscription: 8, general: 5, userFree: 0, total: 13 };
    wsLimits = { creditsPerMonth: 1000 };
    const req = reqFor();
    const res = mockRes();
    let nexted = false;
    await requireCredits('aiChat', 10)(req, res, () => { nexted = true; });

    assert.equal(nexted, true, 'org pool (13) covers the estimate (10)');
    assert.equal(req.creditContext.deductionEnabled, true);
  });

  it('non-billed workspace is UNCHANGED: still funds from total (incl. user_free)', async () => {
    wsLimits = null; // not client-billed
    const req = reqFor();
    const res = mockRes();
    let nexted = false;
    // org pool is only 5 but total (incl. 20 user_free) = 25 ≥ 10 → passes as before.
    await requireCredits('aiChat', 10)(req, res, () => { nexted = true; });

    assert.equal(nexted, true, 'personal user_free still counts for non-billed workspaces');
    assert.equal(req.creditContext.deductionEnabled, true);
  });

  it('client-billed workspace over its monthly credit cap still 402s scope:workspace', async () => {
    balance = { subscription: 500, general: 500, userFree: 0, total: 1000 }; // org pool fine
    wsLimits = { creditsPerMonth: 100 };
    wsUsed = 95; // 95 + 10 > 100
    const req = reqFor();
    const res = mockRes();
    let nexted = false;
    await requireCredits('aiChat', 10)(req, res, () => { nexted = true; });

    assert.equal(nexted, false);
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.scope, 'workspace');
  });
});
