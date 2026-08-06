/**
 * Ledger conservation helper (test plan Phase 3) — reused by Phases 4-5
 * after every scan scenario.
 *
 * The invariant: for any scan outcome whatsoever,
 *     before.total − after.total === credits actually settled
 * and every pre-deduction CreditTransaction reaches a terminal state
 * (settled / refunded). Anything else is money being created or destroyed
 * off the books.
 */

const assert = require('node:assert/strict');
const creditService = require('../../../src/services/creditService');
const CreditTransaction = require('../../../src/models/CreditTransaction');

/** Balance snapshot { subscription, general, userFree, total, expiresAt }. */
async function snapshot(orgId, userId = null) {
  return creditService.getBalance(orgId, userId);
}

/**
 * Assert the org's balance moved by EXACTLY `settled` since `before`.
 * Returns the fresh snapshot for chaining.
 */
async function assertConservation(before, orgId, { settled = 0, userId = null, label = 'scenario' } = {}) {
  const after = await creditService.getBalance(orgId, userId);
  assert.equal(
    before.total - after.total,
    settled,
    `${label}: ledger conservation violated — balance moved ${before.total - after.total}, expected exactly ${settled} settled`,
  );
  return after;
}

/**
 * Assert no credit transaction is stuck in a non-terminal state.
 * 'settling'/'refunding' are transient atomic-claim states (F10-02) that
 * must never survive a completed operation; 'pending' surviving means an
 * un-swept orphan.
 */
async function assertNoPendingTx(filter = {}, label = 'scenario') {
  const stuck = await CreditTransaction.find({
    status: { $in: ['pending', 'settling', 'refunding'] },
    ...filter,
  }).lean();
  assert.equal(
    stuck.length,
    0,
    `${label}: non-terminal credit transactions remain — ${stuck.map((t) => `${t._id}:${t.status}`).join(', ')}`,
  );
}

/**
 * Backdate matching credit transactions past the orphan-sweep cutoff.
 * createdAt is immutable through Mongoose (timestamps) — go through the
 * driver, exactly like a real crash-aged document would look.
 */
async function backdateTransactions(mongooseConn, filter, ageMs = 31 * 60 * 1000) {
  const res = await mongooseConn.db
    .collection('credittransactions')
    .updateMany(filter, { $set: { createdAt: new Date(Date.now() - ageMs) } });
  return res.modifiedCount;
}

module.exports = { snapshot, assertConservation, assertNoPendingTx, backdateTransactions };
