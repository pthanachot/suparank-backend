/**
 * Phase 7 — credit economy: monthly grant with one-month rollover, idempotent
 * per calendar month (this is what makes a YEARLY plan grant every month), plus
 * the Free 200-credit sample seed at org bootstrap.
 *
 * grantMonthlyCreditsIfDue's rollover math is computed in-DB by an aggregation
 * pipeline; here we mock Credit.findOneAndUpdate to model {new:false} (returns
 * the pre-update doc, or null when the month was already granted) and assert the
 * function's idempotency + the JS-mirrored rollover it reports. Advancing a test
 * clock month-by-month exercises the yearly-plan path. No DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const creditService = require('../src/services/creditService');
const orgBootstrap = require('../src/services/orgBootstrapService');
const tierService = require('../src/services/tierService');
const Credit = require('../src/models/Credit');
const CreditTransaction = require('../src/models/CreditTransaction');
const { FREE_SAMPLE_POOL_CREDITS } = require('../src/config/creditRules');

const real = {
  getOrCreate: Credit.getOrCreateForOrg,
  cFOU: Credit.findOneAndUpdate,
  txLog: CreditTransaction.logTransaction,
  getCfg: tierService.getOrgTierConfig,
  grantIfNew: creditService.grantFreeCreditsIfNew,
};
after(() => {
  Credit.getOrCreateForOrg = real.getOrCreate;
  Credit.findOneAndUpdate = real.cFOU;
  CreditTransaction.logTransaction = real.txLog;
  tierService.getOrgTierConfig = real.getCfg;
  creditService.grantFreeCreditsIfNew = real.grantIfNew;
});

// ── stateful fake Credit doc that emulates the per-month idempotency filter ──
let fake, logs;
function armCreditDoc(initial = {}) {
  fake = {
    organizationId: 'org1',
    subscriptionCredits: 0,
    subscriptionCreditsExpireAt: null,
    creditPeriodKey: null,
    ...initial,
  };
  logs = [];
  Credit.getOrCreateForOrg = async () => fake;
  CreditTransaction.logTransaction = async (p) => { logs.push(p); return { _id: 'tx1' }; };
  // Model {new:false}: null when this month already granted (filter misses),
  // else return the PRE-update snapshot and advance the stored period key so the
  // next same-month call is a no-op (real idempotency).
  Credit.findOneAndUpdate = async (filter) => {
    const targetKey = filter.creditPeriodKey.$ne;
    if (fake.creditPeriodKey === targetKey) return null;
    const pre = { ...fake };
    fake.creditPeriodKey = targetKey; // the atomic update sets it
    return pre;
  };
}

const AMOUNT = 3000;

describe('grantMonthlyCreditsIfDue — idempotency + rollover', () => {
  beforeEach(() => armCreditDoc());

  it('first grant: full amount, no rollover', async () => {
    const r = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: new Date('2026-07-05T04:00:00Z') });
    assert.equal(r.granted, true);
    assert.equal(r.amount, AMOUNT);
    assert.equal(r.rolledOver, 0);
    assert.equal(r.balanceAfter, AMOUNT);
    assert.equal(r.period, '2026-07');
    assert.equal(logs.length, 1, 'ledger entry written');
  });

  it('same month again → NOT granted (idempotent — webhook + cron cannot double)', async () => {
    const now = new Date('2026-07-05T04:00:00Z');
    await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now });
    const r2 = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: new Date('2026-07-20T04:00:00Z') });
    assert.equal(r2.granted, false);
    assert.equal(r2.reason, 'already_granted');
    assert.equal(logs.length, 1, 'no second ledger entry');
  });

  it('rollover carries EXACTLY one month (full unused month → 2× after next grant)', async () => {
    // Prior month fully unused: 3000 left, not expired, granted last month.
    armCreditDoc({ subscriptionCredits: AMOUNT, subscriptionCreditsExpireAt: new Date('2026-09-01T00:00:00Z'), creditPeriodKey: '2026-07' });
    const r = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: new Date('2026-08-01T04:00:00Z') });
    assert.equal(r.granted, true);
    assert.equal(r.rolledOver, AMOUNT, 'one full month rolls over');
    assert.equal(r.balanceAfter, 2 * AMOUNT, 'capped at 2× (this month + one rollover month)');
  });

  it('rollover is CAPPED at one month (never more than 2× even if prior > amount)', async () => {
    armCreditDoc({ subscriptionCredits: 5000, subscriptionCreditsExpireAt: new Date('2026-09-01T00:00:00Z'), creditPeriodKey: '2026-07' });
    const r = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: new Date('2026-08-01T04:00:00Z') });
    assert.equal(r.rolledOver, AMOUNT, 'carry-over capped at one month');
    assert.equal(r.balanceAfter, 2 * AMOUNT);
  });

  it('partial unused rolls over partially', async () => {
    armCreditDoc({ subscriptionCredits: 1200, subscriptionCreditsExpireAt: new Date('2026-09-01T00:00:00Z'), creditPeriodKey: '2026-07' });
    const r = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: new Date('2026-08-01T04:00:00Z') });
    assert.equal(r.rolledOver, 1200);
    assert.equal(r.balanceAfter, AMOUNT + 1200);
  });

  it('EXPIRED prior credits do NOT roll over', async () => {
    armCreditDoc({ subscriptionCredits: AMOUNT, subscriptionCreditsExpireAt: new Date('2026-07-15T00:00:00Z'), creditPeriodKey: '2026-07' });
    const r = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: new Date('2026-08-01T04:00:00Z') });
    assert.equal(r.rolledOver, 0, 'expired credits are gone, not rolled');
    assert.equal(r.balanceAfter, AMOUNT);
  });

  it('YEARLY plan grants every calendar month on a test clock (12 grants/year)', async () => {
    armCreditDoc();
    let grants = 0;
    // Simulate a daily cron: tick every day for a year; only calendar-month
    // boundaries should grant. Spend nothing → rollover accumulates but is capped.
    for (let m = 0; m < 12; m++) {
      // one "cron tick" on the 1st and another mid-month (must not double-grant)
      const first = new Date(Date.UTC(2026, m, 1, 4));
      const mid = new Date(Date.UTC(2026, m, 15, 4));
      const r1 = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: first });
      const r2 = await creditService.grantMonthlyCreditsIfDue('org1', AMOUNT, { now: mid });
      if (r1.granted) grants++;
      assert.equal(r2.granted, false, `mid-month tick must not re-grant (month ${m})`);
      // emulate the rolled-over balance persisting into next month (unspent)
      fake.subscriptionCredits = r1.balanceAfter;
      fake.subscriptionCreditsExpireAt = new Date(Date.UTC(2026, m + 2, 1));
    }
    assert.equal(grants, 12, 'exactly one grant per calendar month across the year');
  });

  it('zero amount (Free plan) never grants', async () => {
    const r = await creditService.grantMonthlyCreditsIfDue('org1', 0, { now: new Date('2026-07-05T04:00:00Z') });
    assert.equal(r.granted, false);
    assert.equal(r.reason, 'zero_amount');
  });
});

describe('org bootstrap — Free 200 sample seed', () => {
  let grantCalls;
  beforeEach(() => {
    grantCalls = [];
    creditService.grantFreeCreditsIfNew = async (userId, amount) => { grantCalls.push({ userId, amount }); };
  });

  it('Free tier org seeds the 200-credit lifetime sample', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'free', config: {} });
    await orgBootstrap.grantOrgFreeCredits('u1', 'org1');
    assert.equal(grantCalls.length, 1);
    assert.equal(grantCalls[0].amount, FREE_SAMPLE_POOL_CREDITS);
    assert.equal(FREE_SAMPLE_POOL_CREDITS, 200, 'sample pool is 200');
  });

  it('paid tier does NOT seed the sample (credits come via the subscription webhook)', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'professional', config: { creditsPerMonth: 10000 } });
    await orgBootstrap.grantOrgFreeCredits('u1', 'org1');
    assert.equal(grantCalls.length, 0);
  });
});
