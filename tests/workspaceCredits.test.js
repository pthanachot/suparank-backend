/**
 * Phase 17 Part B — per-workspace credit sub-pools (ships DARK behind saasMode).
 *
 * Guarantees under test:
 *   - DARK / non-billed ⇒ preDeduct's pool overflow is byte-identical to pre-P17
 *     (subscription → general → user_free), and the workspace counter is untouched,
 *   - B1: a client-billed workspace NEVER draws a member's personal user_free
 *     credits — it funds only from the agency's org pool (→ 'Insufficient' if the
 *     org pool can't cover),
 *   - B2: a client-billed workspace is HARD-CAPPED at the plan's creditsPerMonth
 *     (throws when the cap would be exceeded) and its usage is mirrored onto
 *     WorkspaceUsageTracker inside the same transaction,
 *   - creditGate returns an early 402 (scope:'workspace') when the cap is hit.
 *
 * Mongo session + models/services monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const creditService = require('../src/services/creditService');
const workspaceQuotaService = require('../src/services/workspaceQuotaService');
const tierService = require('../src/services/tierService');
const Credit = require('../src/models/Credit');
const UserCredit = require('../src/models/UserCredit');
const UsageTracker = require('../src/models/UsageTracker');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');
const CreditTransaction = require('../src/models/CreditTransaction');
const { requireCredits } = require('../src/middleware/creditGate');

const real = {
  startSession: mongoose.startSession,
  resolveLimits: workspaceQuotaService.resolveWorkspacePlanLimits,
  getCfg: tierService.getOrgTierConfig,
  creditFindOne: Credit.findOne,
  creditFOU: Credit.findOneAndUpdate,
  ucFindOne: UserCredit.findOne,
  ucFOU: UserCredit.findOneAndUpdate,
  utFOU: UsageTracker.findOneAndUpdate,
  wutFindOne: WorkspaceUsageTracker.findOne,
  wutFOU: WorkspaceUsageTracker.findOneAndUpdate,
  wutGet: WorkspaceUsageTracker.getCount,
  txLog: CreditTransaction.logTransaction,
  isFeat: creditService.isFeatureEnabled,
  getBal: creditService.getBalance,
};
after(() => {
  mongoose.startSession = real.startSession;
  workspaceQuotaService.resolveWorkspacePlanLimits = real.resolveLimits;
  tierService.getOrgTierConfig = real.getCfg;
  Credit.findOne = real.creditFindOne;
  Credit.findOneAndUpdate = real.creditFOU;
  UserCredit.findOne = real.ucFindOne;
  UserCredit.findOneAndUpdate = real.ucFOU;
  UsageTracker.findOneAndUpdate = real.utFOU;
  WorkspaceUsageTracker.findOne = real.wutFindOne;
  WorkspaceUsageTracker.findOneAndUpdate = real.wutFOU;
  WorkspaceUsageTracker.getCount = real.wutGet;
  CreditTransaction.logTransaction = real.txLog;
  creditService.isFeatureEnabled = real.isFeat;
  creditService.getBalance = real.getBal;
});

// ── shared state ──
let billedLimits, creditDoc, userCreditDoc, wsRow;
let userFreeDec, wsInc;

beforeEach(() => {
  billedLimits = null; // resolveWorkspacePlanLimits result (null = dark/not-billed)
  creditDoc = { subscriptionCredits: 0, generalCredits: 100 };
  userCreditDoc = { freeCredits: 100 };
  wsRow = null; // WorkspaceUsageTracker row for the ceiling read
  userFreeDec = [];
  wsInc = [];

  mongoose.startSession = async () => ({
    startTransaction: () => {},
    commitTransaction: async () => {},
    abortTransaction: async () => {},
    endSession: () => {},
  });
  workspaceQuotaService.resolveWorkspacePlanLimits = async () => billedLimits;
  tierService.getOrgTierConfig = async () => ({ config: { creditLimitType: 'monthly' } });
  Credit.findOne = () => ({ session: () => Promise.resolve(creditDoc) });
  Credit.findOneAndUpdate = async () => ({});
  UserCredit.findOne = () => ({ session: () => Promise.resolve(userCreditDoc) });
  UserCredit.findOneAndUpdate = async (f, u) => { userFreeDec.push(u.$inc.freeCredits); return {}; };
  UsageTracker.findOneAndUpdate = async () => ({});
  WorkspaceUsageTracker.findOne = () => ({ session: () => Promise.resolve(wsRow) });
  WorkspaceUsageTracker.findOneAndUpdate = async (f, u) => { wsInc.push(u.$inc.creditsUsed); return {}; };
  CreditTransaction.logTransaction = async (p) => ({ _id: `tx_${p.pool}` });
});

// ── preDeduct: DARK / non-billed = byte-identical ──
describe('preDeduct — dark / non-billed (byte-identical to pre-P17)', () => {
  it('uses the user_free pool normally when no workspaceId is present', async () => {
    creditDoc = { subscriptionCredits: 0, generalCredits: 0 }; // force overflow into user_free
    const r = await creditService.preDeduct('org1', 'u1', 10, 'aiChat', {});
    assert.equal(r.deducted, 10);
    assert.deepEqual(userFreeDec, [-10], 'user_free drawn as before');
    assert.equal(wsInc.length, 0, 'no workspace counter touched');
  });

  it('uses user_free when workspaceId is present but saasMode is dark (limits null)', async () => {
    creditDoc = { subscriptionCredits: 0, generalCredits: 0 };
    billedLimits = null; // dark
    await creditService.preDeduct('org1', 'u1', 10, 'aiChat', { workspaceId: 'ws1' });
    assert.deepEqual(userFreeDec, [-10]);
    assert.equal(wsInc.length, 0);
  });
});

// ── preDeduct: client-billed (Part B) ──
describe('preDeduct — client-billed workspace', () => {
  it('B1: excludes user_free — funds only from the org pool', async () => {
    billedLimits = { creditsPerMonth: 1000 };
    creditDoc = { subscriptionCredits: 0, generalCredits: 100 };
    userCreditDoc = { freeCredits: 100 };
    const r = await creditService.preDeduct('org1', 'u1', 10, 'aiChat', { workspaceId: 'ws1' });
    assert.equal(r.deducted, 10);
    assert.equal(userFreeDec.length, 0, 'personal free credits never touched');
    assert.deepEqual(wsInc, [10], 'workspace counter mirrored the consumption');
  });

  it('B1: throws Insufficient when the org pool cannot cover (no user_free fallback)', async () => {
    billedLimits = { creditsPerMonth: 1000 };
    creditDoc = { subscriptionCredits: 0, generalCredits: 0 };
    userCreditDoc = { freeCredits: 100 }; // would have covered it pre-P17 — must NOT now
    await assert.rejects(
      creditService.preDeduct('org1', 'u1', 10, 'aiChat', { workspaceId: 'ws1' }),
      /Insufficient credits/
    );
    assert.equal(userFreeDec.length, 0);
  });

  it('B2: hard-blocks when the monthly cap would be exceeded', async () => {
    billedLimits = { creditsPerMonth: 50 };
    wsRow = { creditsUsed: 45 };
    await assert.rejects(
      creditService.preDeduct('org1', 'u1', 10, 'aiChat', { workspaceId: 'ws1' }), // 45+10 > 50
      /client plan monthly limit reached/
    );
    assert.equal(wsInc.length, 0, 'nothing consumed when blocked');
  });

  it('B2: allows and mirrors usage when under the cap', async () => {
    billedLimits = { creditsPerMonth: 1000 };
    wsRow = { creditsUsed: 200 };
    creditDoc = { subscriptionCredits: 0, generalCredits: 100 };
    await creditService.preDeduct('org1', 'u1', 10, 'aiChat', { workspaceId: 'ws1' });
    assert.deepEqual(wsInc, [10]);
  });

  it('unlimited plan credits (creditsPerMonth null) still excludes user_free but never caps', async () => {
    billedLimits = { creditsPerMonth: null };
    creditDoc = { subscriptionCredits: 0, generalCredits: 100 };
    await creditService.preDeduct('org1', 'u1', 10, 'aiChat', { workspaceId: 'ws1' });
    assert.equal(userFreeDec.length, 0, 'still B1-excluded');
    assert.deepEqual(wsInc, [10], 'still tracked');
  });
});

// ── creditGate early ceiling ──
describe('creditGate — workspace credit ceiling', () => {
  const mw = requireCredits('aiChat', 10);
  function res() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  }
  const reqFor = () => ({ workspace: { _id: 'ws1', organizationId: 'org1' }, user: { userId: 'u1' } });

  beforeEach(() => {
    tierService.getOrgTierConfig = async () => ({ tier: 'agency', config: {} });
    creditService.isFeatureEnabled = () => true;
    creditService.getBalance = async () => ({ total: 100000 });
    WorkspaceUsageTracker.getCount = async () => (wsRow?.creditsUsed || 0);
  });

  it('passes (and sets workspaceId in creditContext) when dark', async () => {
    billedLimits = null;
    const req = reqFor(); const r = res(); let nexted = false;
    await mw(req, r, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.creditContext.workspaceId, 'ws1');
  });

  it('passes when the workspace is under its cap', async () => {
    billedLimits = { creditsPerMonth: 1000 }; wsRow = { creditsUsed: 100 };
    const req = reqFor(); const r = res(); let nexted = false;
    await mw(req, r, () => { nexted = true; });
    assert.equal(nexted, true);
  });

  it('402s (scope:workspace) when the cap would be exceeded', async () => {
    billedLimits = { creditsPerMonth: 105 }; wsRow = { creditsUsed: 100 }; // 100+10 > 105
    const req = reqFor(); const r = res();
    await mw(req, r, () => {});
    assert.equal(r.statusCode, 402);
    assert.equal(r.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(r.body.scope, 'workspace');
  });
});
