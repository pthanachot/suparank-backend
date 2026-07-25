/**
 * Phase 7 — Subscriptions + Credits + Quotas (money paths).
 *
 * bulkManageCredits: per-target partial-failure reporting + the amount
 * type-coercion fix. exportCreditTransactions: CSV formula-injection is
 * neutralized. Models monkey-patched — no database.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminController = require('../src/controllers/adminController');
const User = require('../src/models/User');
const UserCredit = require('../src/models/UserCredit');
const Credit = require('../src/models/Credit');
const CreditTransaction = require('../src/models/CreditTransaction');
const Organization = require('../src/models/Organization');

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

// ── bulkManageCredits ──────────────────────────────────────────
describe('bulkManageCredits — partial failure + type safety', () => {
  const real = { findOne: User.findOne, goc: UserCredit.getOrCreateForUser, log: CreditTransaction.logTransaction };
  let credits;

  beforeEach(() => {
    credits = {};
    User.findOne = async (q) => ([1, 2].includes(q.userId) ? { _id: 'u' + q.userId } : null);
    UserCredit.getOrCreateForUser = async (id) => (credits[id] ||= { freeCredits: 100, save: async () => {} });
    CreditTransaction.logTransaction = async () => {};
  });
  afterEach(() => {
    User.findOne = real.findOne;
    UserCredit.getOrCreateForUser = real.goc;
    CreditTransaction.logTransaction = real.log;
  });

  const call = async (body) => {
    const res = mockRes();
    await adminController.bulkManageCredits({ body, user: { email: 'a@b.c' } }, res);
    return res;
  };

  it('reports per-target success/failure without aborting on a bad target', async () => {
    const res = await call({ targetType: 'user', targets: ['1', '2', '999'], operation: 'add', amount: 10 });
    assert.equal(res.statusCode, 200);
    assert.strictEqual(res.body.processed, 3);
    assert.strictEqual(res.body.succeeded, 2);
    assert.strictEqual(res.body.failed, 1);
    assert.strictEqual(res.body.results.find((r) => r.targetId === '999').error, 'User not found');
    // the two good targets were still applied
    assert.strictEqual(credits['u1'].freeCredits, 110);
    assert.strictEqual(credits['u2'].freeCredits, 110);
  });

  it('add with a STRING amount stays numeric (regression)', async () => {
    await call({ targetType: 'user', targets: ['1'], operation: 'add', amount: '50' });
    assert.strictEqual(credits['u1'].freeCredits, 150);
  });

  it('rejects a missing amount and a negative amount, but allows 0', async () => {
    assert.equal((await call({ targetType: 'user', targets: ['1'], operation: 'add' })).statusCode, 400);
    assert.equal((await call({ targetType: 'user', targets: ['1'], operation: 'add', amount: -5 })).statusCode, 400);
    assert.equal((await call({ targetType: 'user', targets: ['1'], operation: 'set', amount: 0 })).statusCode, 200);
  });

  it('caps at 200 targets', async () => {
    const many = Array.from({ length: 201 }, (_, i) => String(i));
    assert.equal((await call({ targetType: 'user', targets: many, operation: 'add', amount: 1 })).statusCode, 400);
  });
});

// ── exportCreditTransactions — CSV injection ───────────────────
describe('exportCreditTransactions — CSV formula-injection safe', () => {
  const real = { find: CreditTransaction.find, orgFind: Organization.find, userFind: User.find };

  beforeEach(() => {
    CreditTransaction.find = () => ({
      sort: () => ({ limit: () => ({ lean: async () => [
        { _id: 't1', createdAt: new Date('2026-07-01T00:00:00Z'), organizationId: 'o1', userId: null,
          type: 'general_grant', amount: 10, pool: 'general', balanceAfter: 10, description: '=cmd|calc', status: 'completed' },
      ] }) }),
    });
    Organization.find = () => ({ select: () => ({ lean: async () => [{ _id: { toString: () => 'o1' }, name: '=1+1' }] }) });
    User.find = () => ({ select: () => ({ lean: async () => [] }) });
  });
  afterEach(() => {
    CreditTransaction.find = real.find;
    Organization.find = real.orgFind;
    User.find = real.userFind;
  });

  it("prefixes a formula-triggering org name and description with '", async () => {
    const res = mockRes();
    await adminController.exportCreditTransactions({ query: {} }, res);
    const csv = res.body;
    assert.ok(csv.includes("'=1+1"), 'org name must be neutralized');
    assert.ok(csv.includes("'=cmd|calc"), 'description must be neutralized');
    assert.ok(!/,=1\+1,/.test(csv), 'a raw =1+1 cell must not appear');
  });
});
