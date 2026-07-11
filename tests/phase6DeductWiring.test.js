/**
 * Phase 6 — deduction-wiring helpers (creditService.deductForRequest + chargeAction).
 *
 * These are the shared post-success charge primitives the newly-metered actions
 * (image, import, re-score, brief/outline, internal-links, keyword, prompt-
 * research, brand-voice test previews, avatar preview regen) route through.
 *
 * The money-critical property: a finalized charge does preDeduct THEN settle —
 * a bare preDeduct leaves a 'pending' tx the 30-min orphan-sweep refunds,
 * silently making the action free. Every happy-path test below asserts settle
 * claimed the tx (status:'pending' → 'settling'); if it didn't, the charge would
 * be swept.
 *
 * Models/services monkey-patched; no DB/network (mirrors workspaceCredits.test.js).
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const mongoose = require('mongoose');
const creditService = require('../src/services/creditService');
const tierService = require('../src/services/tierService');
const workspaceQuotaService = require('../src/services/workspaceQuotaService');
const Credit = require('../src/models/Credit');
const UserCredit = require('../src/models/UserCredit');
const CreditTransaction = require('../src/models/CreditTransaction');
const UsageTracker = require('../src/models/UsageTracker');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');

const real = {
  startSession: mongoose.startSession,
  getCfg: tierService.getOrgTierConfig,
  wsLimits: workspaceQuotaService.resolveWorkspacePlanLimits,
  getOrCreate: Credit.getOrCreateForOrg,
  cFindOne: Credit.findOne,
  cFOU: Credit.findOneAndUpdate,
  ucFindOne: UserCredit.findOne,
  ucFOU: UserCredit.findOneAndUpdate,
  txLog: CreditTransaction.logTransaction,
  txFOU: CreditTransaction.findOneAndUpdate,
  txUpdateMany: CreditTransaction.updateMany,
  txFind: CreditTransaction.find,
  utFOU: UsageTracker.findOneAndUpdate,
  utInc: UsageTracker.increment,
  wutFOU: WorkspaceUsageTracker.findOneAndUpdate,
};
after(() => {
  mongoose.startSession = real.startSession;
  tierService.getOrgTierConfig = real.getCfg;
  workspaceQuotaService.resolveWorkspacePlanLimits = real.wsLimits;
  Credit.getOrCreateForOrg = real.getOrCreate;
  Credit.findOne = real.cFindOne;
  Credit.findOneAndUpdate = real.cFOU;
  UserCredit.findOne = real.ucFindOne;
  UserCredit.findOneAndUpdate = real.ucFOU;
  CreditTransaction.logTransaction = real.txLog;
  CreditTransaction.findOneAndUpdate = real.txFOU;
  CreditTransaction.updateMany = real.txUpdateMany;
  CreditTransaction.find = real.txFind;
  UsageTracker.findOneAndUpdate = real.utFOU;
  UsageTracker.increment = real.utInc;
  WorkspaceUsageTracker.findOneAndUpdate = real.wutFOU;
});

// ── shared mock state ──
let creditDoc;        // org pools for preDeduct's in-txn read
let balanceDoc;       // org pools for getBalance's getOrCreateCredit read
let userCreditDoc;    // personal free credits
let preDeductLogged;  // a 'pending' pool tx was written (preDeduct ran)
let settleClaimed;    // settle transitioned the tx pending→settling (finalized)

function armWorkingPipeline() {
  preDeductLogged = false;
  settleClaimed = false;
  creditDoc = { subscriptionCredits: 0, generalCredits: 1000, subscriptionCreditsExpireAt: null };
  balanceDoc = { subscriptionCredits: 0, generalCredits: 1000, subscriptionCreditsExpireAt: null, save: async () => {} };
  userCreditDoc = { freeCredits: 0 };

  mongoose.startSession = async () => ({
    startTransaction: () => {}, commitTransaction: async () => {},
    abortTransaction: async () => {}, endSession: () => {},
  });
  workspaceQuotaService.resolveWorkspacePlanLimits = async () => null; // dark
  tierService.getOrgTierConfig = async () => ({ tier: 'professional', config: { creditLimitType: 'monthly' } });
  tierService.getPeriod = tierService.getPeriod || (() => '2026-07');

  // getBalance path
  Credit.getOrCreateForOrg = async () => balanceDoc;
  UserCredit.findOne = () => ({ lean: async () => userCreditDoc, session: async () => userCreditDoc });

  // preDeduct path
  Credit.findOne = () => ({ session: async () => creditDoc });
  Credit.findOneAndUpdate = async () => ({});
  UserCredit.findOneAndUpdate = async () => ({});
  UsageTracker.findOneAndUpdate = async () => ({});
  CreditTransaction.logTransaction = async (p) => {
    preDeductLogged = true;
    return { _id: `tx_${p.pool}` };
  };

  // settle path — claim primary (pending→settling) then mark settled
  CreditTransaction.findOneAndUpdate = async (filter) => {
    if (filter && filter.status === 'pending') {
      settleClaimed = true;
      return {
        _id: filter._id, amount: -10, pool: 'general', organizationId: 'org1',
        metadata: { groupId: 'g1', estimatedTotal: 10 },
      };
    }
    return null;
  };
  CreditTransaction.updateMany = async () => ({ modifiedCount: 0 });
  CreditTransaction.find = async () => ([
    { _id: 'tx_general', amount: -10, pool: 'general', organizationId: 'org1', metadata: { groupId: 'g1', estimatedTotal: 10 } },
  ]);
  UsageTracker.increment = async () => ({});
  WorkspaceUsageTracker.findOneAndUpdate = async () => ({});
}

function landmine() {
  // Any credit-pipeline touch after this throws — proves a "no-op" branch never
  // reached the ledger.
  const boom = () => { throw new Error('credit pipeline must NOT be touched'); };
  Credit.getOrCreateForOrg = boom;
  Credit.findOne = boom;
  CreditTransaction.logTransaction = boom;
  CreditTransaction.findOneAndUpdate = boom;
  mongoose.startSession = boom;
}

// ═══════════════════════════════════════════════════════════════════════
// deductForRequest
// ═══════════════════════════════════════════════════════════════════════
describe('creditService.deductForRequest', () => {
  beforeEach(armWorkingPipeline);

  it('no-ops (touches no ledger) when deduction is disabled', async () => {
    landmine();
    const r = await creditService.deductForRequest({ creditContext: { deductionEnabled: false } });
    assert.deepEqual(r, { deducted: 0 });
  });

  it('no-ops when the resolved amount is 0 (Free fixed-bundle action)', async () => {
    landmine();
    const r = await creditService.deductForRequest({
      creditContext: { deductionEnabled: true, orgId: 'org1', userId: 'u1', estimatedCredits: 0, featureKey: 'contentAudit' },
    });
    assert.deepEqual(r, { deducted: 0 });
  });

  it('FINALIZES the charge: preDeduct THEN settle (orphan-sweep can never refund it)', async () => {
    const req = {
      creditContext: { deductionEnabled: true, orgId: 'org1', userId: 'u1', workspaceId: 'ws1', estimatedCredits: 10, featureKey: 'imageGenerate' },
    };
    const r = await creditService.deductForRequest(req);
    assert.equal(r.deducted, 10);
    assert.equal(preDeductLogged, true, 'preDeduct ran');
    assert.equal(settleClaimed, true, 'settle claimed the pending tx — NOT left for the sweep');
  });

  it('honors an explicit credits override (variable per-row keyword lookup)', async () => {
    const req = {
      creditContext: { deductionEnabled: true, orgId: 'org1', userId: 'u1', workspaceId: 'ws1', estimatedCredits: 50, featureKey: 'keywordLookup' },
    };
    const r = await creditService.deductForRequest(req, { credits: 30 });
    assert.equal(r.deducted, 30, 'deducts the actual row count, not the conservative estimate');
    assert.equal(settleClaimed, true);
  });

  it('is best-effort — a pipeline error never throws into the response path', async () => {
    CreditTransaction.logTransaction = async () => { throw new Error('db down'); };
    Credit.findOne = () => ({ session: async () => ({ subscriptionCredits: 0, generalCredits: 0 }) }); // force insufficient → throw
    const r = await creditService.deductForRequest({
      creditContext: { deductionEnabled: true, orgId: 'org1', userId: 'u1', estimatedCredits: 10, featureKey: 'imageGenerate' },
    });
    assert.equal(r.deducted, 0);
    assert.ok(r.error, 'surfaces the error in the return, does not throw');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// chargeAction (post-hoc, affordability-aware — used by avatar preview regen)
// ═══════════════════════════════════════════════════════════════════════
describe('creditService.chargeAction', () => {
  beforeEach(armWorkingPipeline);

  it('no org → charged:true (never blocks work for legacy/no-org)', async () => {
    landmine();
    const r = await creditService.chargeAction('avatarCreate', { orgId: null, userId: 'u1' });
    assert.equal(r.charged, true);
    assert.equal(r.reason, 'no_org');
  });

  it('deduction flag disabled → charged:true, deducts nothing', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'professional', config: { custom: { creditDeductionFlags: { avatarCreate: false } } } });
    const r = await creditService.chargeAction('avatarCreate', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.charged, true);
    assert.equal(r.reason, 'disabled');
    assert.equal(r.deducted, 0);
  });

  it('inactive action → charged:true (fails OPEN — never bills a phantom action)', async () => {
    const r = await creditService.chargeAction('voiceExtraction', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.charged, true);
    assert.equal(r.reason, 'resolve_failed');
  });

  it('zero cost (Free fixed-bundle) → charged:true, no deduction', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'free', config: {} });
    const r = await creditService.chargeAction('keywordLookup', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.charged, true);
    assert.equal(r.reason, 'zero');
  });

  it('insufficient balance → charged:FALSE (caller skips the AI work — no free run)', async () => {
    balanceDoc = { subscriptionCredits: 0, generalCredits: 3, subscriptionCreditsExpireAt: null, save: async () => {} };
    // avatarCreate costs 10; only 3 available.
    let preDeductAttempted = false;
    CreditTransaction.logTransaction = async () => { preDeductAttempted = true; return { _id: 'x' }; };
    const r = await creditService.chargeAction('avatarCreate', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.charged, false);
    assert.equal(r.reason, 'insufficient');
    assert.equal(preDeductAttempted, false, 'never even attempts to deduct when unaffordable');
  });

  it('sufficient balance → charged:true, deducts 10 and FINALIZES (settle ran)', async () => {
    const r = await creditService.chargeAction('avatarCreate', { orgId: 'org1', userId: 'u1', workspaceId: 'ws1' });
    assert.equal(r.charged, true);
    assert.equal(r.reason, 'ok');
    assert.equal(r.deducted, 10);
    assert.equal(settleClaimed, true, 'finalized — not left pending for the sweep');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// canAffordAction (pre-check WITHOUT deducting — gates avatar preview regen
// so paid AI never runs free, while the charge itself waits for success)
// ═══════════════════════════════════════════════════════════════════════
describe('creditService.canAffordAction', () => {
  beforeEach(armWorkingPipeline);

  it('no org → ok:true (never blocks work), touches no ledger', async () => {
    landmine();
    const r = await creditService.canAffordAction('avatarCreate', { orgId: null, userId: 'u1' });
    assert.deepEqual(r, { ok: true, reason: 'no_org' });
  });

  it('deduction flag disabled → ok:true (proceed; charge will be a no-op)', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'professional', config: { custom: { creditDeductionFlags: { avatarCreate: false } } } });
    const r = await creditService.canAffordAction('avatarCreate', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'disabled');
  });

  it('zero cost (Free fixed-bundle) → ok:true', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'free', config: {} });
    const r = await creditService.canAffordAction('keywordLookup', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'zero');
  });

  it('affordable → ok:true, and does NOT deduct (no preDeduct)', async () => {
    let touched = false;
    CreditTransaction.logTransaction = async () => { touched = true; return { _id: 'x' }; };
    const r = await creditService.canAffordAction('avatarCreate', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'affordable');
    assert.equal(touched, false, 'pre-check must NOT spend — only chargeAction deducts');
  });

  it('insufficient balance → ok:false (caller skips the AI work)', async () => {
    balanceDoc = { subscriptionCredits: 0, generalCredits: 3, subscriptionCreditsExpireAt: null, save: async () => {} };
    const r = await creditService.canAffordAction('avatarCreate', { orgId: 'org1', userId: 'u1' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'insufficient');
  });
});
