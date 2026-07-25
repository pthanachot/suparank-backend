/**
 * Phase 5 — Users + Sessions audit.
 *
 * Locks in the credit/quota math (including the type-coercion fix: a string
 * amount must not string-concatenate on the 'add' path) and proves
 * revokeAllUserSessions ends sessions AND bumps tokenVersion. Models are
 * monkey-patched — no database.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminController = require('../src/controllers/adminController');
const sessionsController = require('../src/controllers/adminSessionsController');
const User = require('../src/models/User');
const UserCredit = require('../src/models/UserCredit');
const CreditTransaction = require('../src/models/CreditTransaction');
const OrgMember = require('../src/models/OrgMember');
const UserUsageTracker = require('../src/models/UserUsageTracker');
const Session = require('../src/models/Session');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ── manageUserCredits ──────────────────────────────────────────
describe('manageUserCredits — math + type safety', () => {
  const real = { findOne: User.findOne, goc: UserCredit.getOrCreateForUser, log: CreditTransaction.logTransaction, org: OrgMember.findOne };
  let credit, loggedTx;

  beforeEach(() => {
    credit = { freeCredits: 100, save: async () => {} };
    loggedTx = null;
    User.findOne = async () => ({ _id: 'u1' });
    UserCredit.getOrCreateForUser = async () => credit;
    CreditTransaction.logTransaction = async (tx) => { loggedTx = tx; };
    OrgMember.findOne = () => ({ select: () => ({ lean: async () => null }) });
  });
  afterEach(() => {
    User.findOne = real.findOne;
    UserCredit.getOrCreateForUser = real.goc;
    CreditTransaction.logTransaction = real.log;
    OrgMember.findOne = real.org;
  });

  const call = async (body) => {
    const res = mockRes();
    await adminController.manageUserCredits({ params: { userId: '1' }, body, user: { email: 'a@b.c' } }, res);
    return res;
  };

  it('add with a STRING amount stays numeric (regression: no "10050")', async () => {
    const res = await call({ action: 'add', amount: '50' });
    assert.equal(res.statusCode, 200);
    assert.strictEqual(credit.freeCredits, 150);
    assert.strictEqual(loggedTx.amount, 50);
  });

  it('subtract floors at 0 and logs a negative amount', async () => {
    await call({ action: 'subtract', amount: 500 });
    assert.strictEqual(credit.freeCredits, 0);
    assert.strictEqual(loggedTx.amount, -500);
  });

  it('set replaces the balance', async () => {
    await call({ action: 'set', amount: 42 });
    assert.strictEqual(credit.freeCredits, 42);
  });

  it('rejects non-numeric, zero, and Infinity amounts', async () => {
    assert.equal((await call({ action: 'add', amount: 'abc' })).statusCode, 400);
    assert.equal((await call({ action: 'add', amount: 0 })).statusCode, 400);
    assert.equal((await call({ action: 'add', amount: 'Infinity' })).statusCode, 400);
  });
});

// ── manageUserQuota ────────────────────────────────────────────
describe('manageUserQuota — math + type safety', () => {
  const real = { findOne: User.findOne, get: UserUsageTracker.getCount, inc: UserUsageTracker.increment };
  let current, incCall;

  beforeEach(() => {
    current = 10;
    incCall = null;
    User.findOne = async () => ({ _id: 'u1' });
    UserUsageTracker.getCount = async () => current;
    UserUsageTracker.increment = async (id, counter, delta) => { incCall = { id, counter, delta }; };
  });
  afterEach(() => {
    User.findOne = real.findOne;
    UserUsageTracker.getCount = real.get;
    UserUsageTracker.increment = real.inc;
  });

  const call = async (body) => {
    const res = mockRes();
    await adminController.manageUserQuota({ params: { userId: '1' }, body, user: { email: 'a@b.c' } }, res);
    return res;
  };

  it('add with a STRING amount increments numerically (regression: not 105)', async () => {
    const res = await call({ counter: 'articlesCreated', action: 'add', amount: '5' });
    assert.equal(res.statusCode, 200);
    assert.strictEqual(res.body.newValue, 15);
    assert.strictEqual(incCall.delta, 5);
  });

  it('subtract floors at 0 (only removes what exists)', async () => {
    const res = await call({ counter: 'articlesCreated', action: 'subtract', amount: 100 });
    assert.strictEqual(res.body.newValue, 0);
    assert.strictEqual(incCall.delta, -10);
  });

  it('rejects an invalid counter and a non-numeric amount', async () => {
    assert.equal((await call({ counter: 'bogus', action: 'add', amount: 5 })).statusCode, 400);
    assert.equal((await call({ counter: 'articlesCreated', action: 'add', amount: 'x' })).statusCode, 400);
  });
});

// ── revokeAllUserSessions ──────────────────────────────────────
describe('revokeAllUserSessions — ends sessions and kills tokens', () => {
  const real = { findOne: User.findOne, updateMany: Session.updateMany };
  let invalidated;

  beforeEach(() => {
    invalidated = false;
    Session.updateMany = async () => ({ modifiedCount: 3 });
  });
  afterEach(() => {
    User.findOne = real.findOne;
    Session.updateMany = real.updateMany;
  });

  it('ends active sessions AND bumps tokenVersion', async () => {
    User.findOne = async () => ({ _id: { toString: () => 'u1' }, email: 'x@y.z', invalidateTokens: async () => { invalidated = true; } });
    const res = mockRes();
    await sessionsController.revokeAllUserSessions({ params: { userId: '7' }, user: { email: 'boss@x.co', userId: { toString: () => 'other' } } }, res);
    assert.equal(res.statusCode, 200);
    assert.strictEqual(res.body.sessionsEnded, 3);
    assert.strictEqual(res.body.tokenVersionBumped, true);
    assert.strictEqual(invalidated, true);
    assert.strictEqual(res.body.affectsYou, false);
  });

  it('flags affectsYou when an admin revokes their own sessions', async () => {
    User.findOne = async () => ({ _id: { toString: () => 'me' }, email: 'me@x.co', invalidateTokens: async () => {} });
    const res = mockRes();
    await sessionsController.revokeAllUserSessions({ params: { userId: '1' }, user: { email: 'me@x.co', userId: { toString: () => 'me' } } }, res);
    assert.strictEqual(res.body.affectsYou, true);
  });

  it('404s an unknown user', async () => {
    User.findOne = async () => null;
    const res = mockRes();
    await sessionsController.revokeAllUserSessions({ params: { userId: '999' }, user: { email: 'boss@x.co' } }, res);
    assert.equal(res.statusCode, 404);
  });
});
