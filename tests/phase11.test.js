/**
 * Phase 11 — admin MRR/naming fixes + version-retention pruning.
 *
 *  A. Admin MRR (getDashboardStats / getSubscriptionStats) prices from the
 *     canonical tier config: real 'pro-*' subs count at $99 (the headline bug
 *     was $0), Agency $299, yearly ÷12, extra seats +$10, and an admin-overridden
 *     'professional-*' org prices identically to a real 'pro-*' org.
 *  B. overrideOrgPlan's VALID_PLAN_IDS includes the canonical 'pro-*' ids.
 *  C. versionRetention.pruneVersions enforces the tier window, keeping the latest.
 *
 * Stripe faked via require-cache injection before requiring the controller;
 * models + tierService monkey-patched. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

class FakeStripe { constructor() { this.subscriptions = {}; } }
require.cache[require.resolve('stripe')] = { exports: FakeStripe };

const adminController = require('../src/controllers/adminController');
const Subscription = require('../src/models/Subscription');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const Content = require('../src/models/Content');
const CreditTransaction = require('../src/models/CreditTransaction');
const UsageTracker = require('../src/models/UsageTracker');
const tierService = require('../src/services/tierService');
const { pruneVersions } = require('../src/services/versionRetention');
const { rearmTrackersForOrg } = require('../src/services/trackerScheduleService');

// Canonical v4.1 tier prices (as in configTiers → TierConfig).
const TIER_PRICES = {
  standard: { monthlyPrice: 29, yearlyPrice: 276, extraSeatPrice: 0 },
  professional: { monthlyPrice: 99, yearlyPrice: 948, extraSeatPrice: 10 },
  agency: { monthlyPrice: 299, yearlyPrice: 2868, extraSeatPrice: 10 },
};

const real = {
  subFind: Subscription.find,
  subCount: Subscription.countDocuments,
  userCount: User.countDocuments,
  orgCount: Organization.countDocuments,
  wsCount: Workspace.countDocuments,
  contentCount: Content.countDocuments,
  ctCount: CreditTransaction.countDocuments,
  utCount: UsageTracker.countDocuments,
  getTierConfig: tierService.getTierConfig,
};
after(() => {
  Subscription.find = real.subFind;
  Subscription.countDocuments = real.subCount;
  User.countDocuments = real.userCount;
  Organization.countDocuments = real.orgCount;
  Workspace.countDocuments = real.wsCount;
  Content.countDocuments = real.contentCount;
  CreditTransaction.countDocuments = real.ctCount;
  UsageTracker.countDocuments = real.utCount;
  tierService.getTierConfig = real.getTierConfig;
});

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const subsReturning = (subs) => { Subscription.find = () => ({ select: () => ({ lean: async () => subs }) }); };

// ═══════════════════════════════════════════════════════════════════════
// A. Admin MRR pricing
// ═══════════════════════════════════════════════════════════════════════

describe('admin MRR — canonical tier pricing', () => {
  beforeEach(() => {
    User.countDocuments = async () => 0;
    Organization.countDocuments = async () => 0;
    Subscription.countDocuments = async () => 0;
    Workspace.countDocuments = async () => 0;
    Content.countDocuments = async () => 0;
    CreditTransaction.countDocuments = async () => 0;
    UsageTracker.countDocuments = async () => 0; // Phase 14 tail-risk metric dep
    tierService.getTierConfig = async (tier) => TIER_PRICES[tier] || null;
  });

  async function dashboardMrr(subs) {
    subsReturning(subs);
    const r = mockRes();
    await adminController.getDashboardStats({}, r);
    return r.body.monthlyRevenue;
  }

  it('a real pro-monthly sub counts at $99 (was $0 — the headline bug)', async () => {
    assert.equal(await dashboardMrr([{ planId: 'pro-monthly', status: 'active' }]), 99);
  });

  it('an admin-overridden professional-monthly org prices identically ($99)', async () => {
    assert.equal(await dashboardMrr([{ planId: 'professional-monthly', status: 'active' }]), 99);
  });

  it('pro-yearly bills at yearlyPrice/12 (round(948/12)=79)', async () => {
    assert.equal(await dashboardMrr([{ planId: 'pro-yearly', status: 'active' }]), 79);
  });

  it('agency-monthly = $299, standard-monthly = $29', async () => {
    assert.equal(await dashboardMrr([{ planId: 'agency-monthly', status: 'active' }]), 299);
    assert.equal(await dashboardMrr([{ planId: 'standard-monthly', status: 'active' }]), 29);
  });

  it('purchased extra seats add extraSeatPrice each (pro + 2 seats = 119)', async () => {
    assert.equal(await dashboardMrr([{ planId: 'pro-monthly', status: 'active', purchasedExtraSeats: 2 }]), 119);
  });

  it('free / unknown plans contribute 0; a mixed book sums correctly', async () => {
    const mrr = await dashboardMrr([
      { planId: 'pro-monthly', status: 'active' },        // 99
      { planId: 'agency-monthly', status: 'active' },     // 299
      { planId: 'standard-monthly', status: 'active' },   // 29
      { planId: 'free', status: 'active' },               // 0
      { planId: null, status: 'active' },                 // 0
    ]);
    assert.equal(mrr, 99 + 299 + 29);
  });

  it('getSubscriptionStats counts MRR only from active/trialing subs', async () => {
    subsReturning([
      { planId: 'pro-monthly', status: 'active' },        // 99
      { planId: 'agency-monthly', status: 'trialing' },   // 299
      { planId: 'standard-monthly', status: 'canceled' }, // excluded
      { planId: 'pro-monthly', status: 'past_due' },      // excluded
    ]);
    const r = mockRes();
    await adminController.getSubscriptionStats({}, r);
    assert.equal(r.body.monthlyRevenue, 99 + 299);
    assert.equal(r.body.activeCount, 1);
    assert.equal(r.body.trialingCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. VALID_PLAN_IDS includes canonical pro-*
// ═══════════════════════════════════════════════════════════════════════

describe('overrideOrgPlan — VALID_PLAN_IDS', () => {
  it('rejects an unknown planId and offers pro-monthly in the valid list', async () => {
    const r = mockRes();
    await adminController.overrideOrgPlan({ params: { orgId: 'o1' }, body: { planId: 'enterprise-monthly' } }, r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /pro-monthly/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. Version-retention pruning
// ═══════════════════════════════════════════════════════════════════════

describe('versionRetention.pruneVersions', () => {
  const NOW = 1_000_000_000_000;
  const daysAgo = (d) => NOW - d * 24 * 60 * 60 * 1000;

  it('drops snapshots older than the tier window, keeps the fresh ones', async () => {
    const versions = [
      { id: 'a', timestamp: daysAgo(100) },
      { id: 'b', timestamp: daysAgo(10) },
      { id: 'c', timestamp: daysAgo(2) },
    ];
    const kept = pruneVersions(versions, 7, NOW); // Free = 7 days
    assert.deepEqual(kept.map((v) => v.id), ['c']);
  });

  it('never drops everything — keeps the most-recent when all are past the window', () => {
    const versions = [
      { id: 'old', timestamp: daysAgo(100) },
      { id: 'newer', timestamp: daysAgo(40) },
    ];
    const kept = pruneVersions(versions, 7, NOW);
    assert.deepEqual(kept.map((v) => v.id), ['newer']);
  });

  it('90-day (Pro) window keeps more history than 7-day (Free)', () => {
    const versions = [
      { id: 'a', timestamp: daysAgo(80) },
      { id: 'b', timestamp: daysAgo(20) },
    ];
    assert.deepEqual(pruneVersions(versions, 90, NOW).map((v) => v.id), ['a', 'b']);
    assert.deepEqual(pruneVersions(versions, 7, NOW).map((v) => v.id), ['b']);
  });

  it('null/undefined retention keeps all; ≤1 snapshot is untouched', () => {
    const versions = [{ id: 'a', timestamp: daysAgo(100) }, { id: 'b', timestamp: daysAgo(99) }];
    assert.equal(pruneVersions(versions, null, NOW).length, 2);
    assert.equal(pruneVersions(versions, undefined, NOW).length, 2);
    assert.deepEqual(pruneVersions([{ id: 'solo', timestamp: daysAgo(999) }], 7, NOW).map((v) => v.id), ['solo']);
    assert.deepEqual(pruneVersions([], 7, NOW), []);
  });

  it('keeps snapshots with malformed timestamps (defers to schema validation, not silent drop)', () => {
    const versions = [
      { id: 'bad', timestamp: 'oops' },
      { id: 'old', timestamp: daysAgo(100) },
      { id: 'fresh', timestamp: daysAgo(1) },
    ];
    const kept = pruneVersions(versions, 7, NOW).map((v) => v.id);
    assert.ok(kept.includes('bad'), 'malformed-timestamp snapshot is not silently dropped');
    assert.ok(kept.includes('fresh'));
    assert.ok(!kept.includes('old'), 'validly-old snapshot is still pruned');
  });

  it('count cap: >10 all-fresh snapshots trimmed to the newest 10 (never trips the schema validator)', () => {
    const versions = Array.from({ length: 14 }, (_, i) => ({ id: `v${i}`, timestamp: daysAgo(14 - i) }));
    const kept = pruneVersions(versions, 90, NOW); // all within a 90-day window
    assert.equal(kept.length, 10);
    // Newest 10 kept (v4..v13), chronological order.
    assert.deepEqual(kept.map((v) => v.id), ['v4','v5','v6','v7','v8','v9','v10','v11','v12','v13']);
  });

  it('seconds-epoch timestamps are normalized — fresh history is NOT collapsed to one snapshot', () => {
    // A client sending epoch-SECONDS (÷1000) would look ~1000× ancient and, pre-fix,
    // collapse all history to the single newest snapshot. Normalized, all three are
    // within the 7-day window and retained.
    const sec = (msTs) => Math.floor(msTs / 1000);
    const versions = [
      { id: 'a', timestamp: sec(daysAgo(3)) },
      { id: 'b', timestamp: sec(daysAgo(2)) },
      { id: 'c', timestamp: sec(daysAgo(1)) },
    ];
    const kept = pruneVersions(versions, 7, NOW).map((v) => v.id);
    assert.deepEqual(kept, ['a', 'b', 'c'], 'all three fresh snapshots retained (not collapsed to newest)');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. Free tier gets 0 recurring monitoring (executeScan cron gate)
// ═══════════════════════════════════════════════════════════════════════

const aiTrackerController = require('../src/controllers/aiTrackerController');
const AiTracker = require('../src/models/AiTracker');
const AiTrackerScan = require('../src/models/AiTrackerScan');
const AiTrackerPrompt = require('../src/models/AiTrackerPrompt');

describe('executeScan — Free tier gets no recurring (cron) scan', () => {
  const realTracker = {
    findOneAndUpdate: AiTracker.findOneAndUpdate,
    findByIdAndUpdate: AiTracker.findByIdAndUpdate,
  };
  const realWsFind = Workspace.findById;
  const realScanCreate = AiTrackerScan.create;
  const realPromptFind = AiTrackerPrompt.find;
  const realGetOrgCfg = tierService.getOrgTierConfig;
  after(() => {
    AiTracker.findOneAndUpdate = realTracker.findOneAndUpdate;
    AiTracker.findByIdAndUpdate = realTracker.findByIdAndUpdate;
    Workspace.findById = realWsFind;
    AiTrackerScan.create = realScanCreate;
    AiTrackerPrompt.find = realPromptFind;
    tierService.getOrgTierConfig = realGetOrgCfg;
  });

  let updateArgs, scanCreated, promptFindCalled;
  beforeEach(() => {
    updateArgs = null; scanCreated = false; promptFindCalled = false;
    AiTracker.findOneAndUpdate = async () => ({ _id: 't1', defaultModels: ['gpt-4o'], workspaceId: 'ws1' });
    Workspace.findById = async () => ({ organizationId: 'org1' });
    AiTracker.findByIdAndUpdate = async (_id, upd) => { updateArgs = upd; return {}; };
    AiTrackerScan.create = async () => { scanCreated = true; return { _id: 's1', startedAt: new Date() }; };
    AiTrackerPrompt.find = () => { promptFindCalled = true; return { limit: async () => [] }; };
  });

  it('a scheduled (cron, force=false) scan on a Free org is unscheduled and skipped', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'free', config: {} });
    await aiTrackerController.executeScan('t1', 'u1', { force: false });
    assert.equal(updateArgs?.$set?.nextScanAt, null, 'nextScanAt cleared (no recurring scan)');
    assert.equal(scanCreated, false, 'no scan document created');
    assert.equal(promptFindCalled, false, 'bailed before loading prompts');
  });

  it('a MANUAL (force=true) scan on a Free org is NOT gated — it proceeds past the gate', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'free', config: {} });
    await aiTrackerController.executeScan('t1', 'u1', { force: true });
    assert.equal(promptFindCalled, true, 'manual refresh proceeds past the free-tier gate');
  });

  it('a scheduled scan on a PAID org is NOT gated — it proceeds past the gate', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'standard', config: { maxAiTrackerPlatforms: 4 } });
    await aiTrackerController.executeScan('t1', 'u1', { force: false });
    assert.equal(promptFindCalled, true, 'paid scheduled scan proceeds past the free-tier gate');
  });

  it('a scheduled scan on an ORG-LESS (personal) workspace is unscheduled and skipped (no funding source)', async () => {
    // No org ⇒ no subscription/credits fund recurring scans. Gate must not be
    // bypassed by the falsy orgId (the pre-fix `&& orgId` hole).
    Workspace.findById = async () => ({ organizationId: null });
    await aiTrackerController.executeScan('t1', 'u1', { force: false });
    assert.equal(updateArgs?.$set?.nextScanAt, null, 'nextScanAt cleared (no recurring scan without an org)');
    assert.equal(scanCreated, false, 'no scan document created');
    assert.equal(promptFindCalled, false, 'bailed before loading prompts');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. Re-arm trackers on paid activation (the Free-gate's counterpart)
// ═══════════════════════════════════════════════════════════════════════

describe('trackerScheduleService.rearmTrackersForOrg', () => {
  const realWsFind = Workspace.find;
  const realUpdateMany = AiTracker.updateMany;
  after(() => { Workspace.find = realWsFind; AiTracker.updateMany = realUpdateMany; });

  it('re-arms ONLY null-nextScanAt trackers for the org (sets nextScanAt=now)', async () => {
    Workspace.find = () => ({ select: () => ({ lean: async () => [{ _id: 'ws1' }, { _id: 'ws2' }] }) });
    let filter, update;
    AiTracker.updateMany = async (f, u) => { filter = f; update = u; return { modifiedCount: 3 }; };
    const NOW = new Date(1_700_000_000_000);
    const res = await rearmTrackersForOrg('org1', NOW);
    assert.equal(res.rearmed, 3);
    assert.deepEqual(filter.workspaceId, { $in: ['ws1', 'ws2'] });
    assert.equal(filter.nextScanAt, null, 'only unscheduled trackers are targeted');
    assert.equal(update.$set.nextScanAt, NOW, 'nextScanAt nudged to now → cron re-picks, executeScan reschedules');
  });

  it('no-op (no updateMany) for a missing org or an org with no workspaces', async () => {
    Workspace.find = () => ({ select: () => ({ lean: async () => [] }) });
    let called = false;
    AiTracker.updateMany = async () => { called = true; return { modifiedCount: 0 }; };
    assert.deepEqual(await rearmTrackersForOrg(null), { rearmed: 0 });
    assert.deepEqual(await rearmTrackersForOrg('orgX'), { rearmed: 0 });
    assert.equal(called, false, 'updateMany not called when there is nothing to re-arm');
  });
});
