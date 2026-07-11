/**
 * Fix #3 — settle()/refund() reverse the usage counters by the AUTHORITATIVE
 * deducted amount (metadata.estimatedTotal, captured in-txn at preDeduct time),
 * NOT the sum of the persisted pool txs. Pool tx logging is best-effort; a dropped
 * log would otherwise make the reversal short (or skip it entirely when the dropped
 * tx was the excess), permanently over-counting creditsUsed against both the org
 * tier and the Phase-17 workspace cap.
 *
 * Verifies BOTH the org UsageTracker and the workspace WorkspaceUsageTracker
 * reversals, and that the normal (nothing-dropped) case is unchanged.
 *
 * Models/services monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const creditService = require('../src/services/creditService');
const tierService = require('../src/services/tierService');
const CreditTransaction = require('../src/models/CreditTransaction');
const Credit = require('../src/models/Credit');
const UserCredit = require('../src/models/UserCredit');
const UsageTracker = require('../src/models/UsageTracker');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');
const systemSettingsService = require('../src/services/systemSettingsService');

const real = {
  txFOU: CreditTransaction.findOneAndUpdate,
  txUpdateMany: CreditTransaction.updateMany,
  txFind: CreditTransaction.find,
  txLog: CreditTransaction.logTransaction,
  creditFOU: Credit.findOneAndUpdate,
  ucFOU: UserCredit.findOneAndUpdate,
  getCfg: tierService.getOrgTierConfig,
  utInc: UsageTracker.increment,
  wutInc: WorkspaceUsageTracker.increment,
  getSettings: systemSettingsService.getSettings,
};
after(() => {
  CreditTransaction.findOneAndUpdate = real.txFOU;
  CreditTransaction.updateMany = real.txUpdateMany;
  CreditTransaction.find = real.txFind;
  CreditTransaction.logTransaction = real.txLog;
  Credit.findOneAndUpdate = real.creditFOU;
  UserCredit.findOneAndUpdate = real.ucFOU;
  tierService.getOrgTierConfig = real.getCfg;
  UsageTracker.increment = real.utInc;
  WorkspaceUsageTracker.increment = real.wutInc;
  systemSettingsService.getSettings = real.getSettings;
});

let primaryTx, relatedTxs, orgIncs, wsIncs;

beforeEach(() => {
  orgIncs = [];
  wsIncs = [];
  // Primary tx carries the authoritative estimate + P17 workspace tags.
  primaryTx = {
    _id: 'tx1',
    organizationId: 'org1',
    metadata: { estimatedTotal: 20, groupId: 'g1', workspaceId: 'ws1', wsBilledPeriod: '2026-07' },
  };
  relatedTxs = [{ _id: 'tx1', amount: -20, pool: 'subscription' }]; // fully logged by default

  CreditTransaction.findOneAndUpdate = async () => primaryTx;
  CreditTransaction.updateMany = async () => ({});
  CreditTransaction.find = async () => relatedTxs;
  CreditTransaction.logTransaction = async () => ({ _id: 'log' });
  Credit.findOneAndUpdate = async () => ({});
  UserCredit.findOneAndUpdate = async () => ({});
  tierService.getOrgTierConfig = async () => ({ config: { creditLimitType: 'monthly' } });
  UsageTracker.increment = async (o, k, p, amt) => { orgIncs.push(amt); };
  WorkspaceUsageTracker.increment = async (w, k, p, amt) => { wsIncs.push(amt); };
  systemSettingsService.getSettings = () => ({ emailNotificationsEnabled: false });
});

describe('settle() — counter reversal by authoritative amount', () => {
  it('normal case (nothing dropped): decrements by estimate − actual', async () => {
    // relatedTxs sum = 20 = estimatedTotal. actual = 8 → refund 12.
    await creditService.settle('tx1', 8);
    assert.deepEqual(orgIncs, [-12]);
    assert.deepEqual(wsIncs, [-12]);
  });

  it('a pool tx log was DROPPED (persisted sum < estimate): still corrects by estimate − actual', async () => {
    // The general-pool tx for 12 was never persisted; only the 8 sub tx survives.
    relatedTxs = [{ _id: 'tx1', amount: -8, pool: 'subscription' }];
    // OLD (persisted-based): refundRemaining = 8-8 = 0 → counter never decremented → stuck at +20.
    // NEW (estimate-based): decrement by 20-8 = 12 → nets to actual (8).
    await creditService.settle('tx1', 8);
    assert.deepEqual(orgIncs, [-12], 'org counter corrected to actual despite dropped tx');
    assert.deepEqual(wsIncs, [-12], 'workspace cap counter corrected to actual');
  });

  it('no over-charge (actual == estimate): no counter change', async () => {
    await creditService.settle('tx1', 20);
    assert.equal(orgIncs.length, 0);
    assert.equal(wsIncs.length, 0);
  });
});

describe('refund() — full reversal by authoritative amount', () => {
  it('normal case: fully reverses by estimatedTotal', async () => {
    await creditService.refund('tx1');
    assert.deepEqual(orgIncs, [-20]);
    assert.deepEqual(wsIncs, [-20]);
  });

  it('a pool tx log was DROPPED: still fully reverses the counter by estimatedTotal', async () => {
    relatedTxs = [{ _id: 'tx1', amount: -8, pool: 'subscription' }]; // 12 dropped
    // OLD: would decrement by 8 → counter stuck at +12. NEW: decrement by 20 → nets to 0.
    await creditService.refund('tx1');
    assert.deepEqual(orgIncs, [-20], 'org counter fully reversed');
    assert.deepEqual(wsIncs, [-20], 'workspace cap counter fully reversed');
  });

  it('non-billed group (no workspace tags): only the org counter is reversed', async () => {
    primaryTx.metadata = { estimatedTotal: 20, groupId: 'g1' }; // no workspaceId / wsBilledPeriod
    await creditService.refund('tx1');
    assert.deepEqual(orgIncs, [-20]);
    assert.equal(wsIncs.length, 0, 'no workspace counter touched when not client-billed');
  });
});
