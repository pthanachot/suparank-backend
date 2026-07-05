/**
 * Unit tests for creditService.grantGeneralCreditsIdempotent — the money-safe
 * primitive behind credit-pack fulfillment.
 *
 * Guarantees under test:
 *   - grant + session-keyed marker happen inside ONE transaction,
 *   - a redelivery (marker already present) grants nothing (fast path),
 *   - a concurrent duplicate (unique-index 11000 on the marker insert) is
 *     reported as alreadyFulfilled, NOT thrown,
 *   - a transient DB error propagates (so the caller lets Stripe retry),
 *   - a missing idempotencyKey is a programmer error (throws).
 *
 * The Mongo session is stubbed so withTransaction just runs its callback; no DB.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const creditService = require('../src/services/creditService');
const Credit = require('../src/models/Credit');
const CreditTransaction = require('../src/models/CreditTransaction');

const real = {
  startSession: mongoose.startSession,
  creditUpdate: Credit.findOneAndUpdate,
  txFindOne: CreditTransaction.findOne,
  txCreate: CreditTransaction.create,
};

after(() => {
  mongoose.startSession = real.startSession;
  Credit.findOneAndUpdate = real.creditUpdate;
  CreditTransaction.findOne = real.txFindOne;
  CreditTransaction.create = real.txCreate;
});

let markerStore; // simulated committed purchase markers, keyed by stripeSessionId
let creditUpdateCalls;
let sessionEnded;

beforeEach(() => {
  markerStore = new Map();
  creditUpdateCalls = [];
  sessionEnded = false;

  mongoose.startSession = async () => ({
    withTransaction: async (fn) => {
      await fn();
    },
    endSession: () => {
      sessionEnded = true;
    },
  });

  CreditTransaction.findOne = (query) => ({
    lean: async () => {
      const sid = query['metadata.stripeSessionId'];
      return markerStore.get(sid) || null;
    },
  });

  Credit.findOneAndUpdate = async (filter, update, opts) => {
    creditUpdateCalls.push({ filter, update, opts });
    // Simulate the $inc returning the new balance.
    return { generalCredits: update.$inc.generalCredits };
  };

  // Unique partial index emulation: second insert with the same
  // stripeSessionId throws a duplicate-key error (11000).
  CreditTransaction.create = async (docs) => {
    const doc = Array.isArray(docs) ? docs[0] : docs;
    const sid = doc.metadata?.stripeSessionId;
    if (sid && markerStore.has(sid)) {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    if (sid) markerStore.set(sid, doc);
    return [doc];
  };
});

describe('grantGeneralCreditsIdempotent — first grant', () => {
  it('grants inside a transaction and writes a session-keyed purchase marker', async () => {
    const res = await creditService.grantGeneralCreditsIdempotent('org-1', 5000, 'Credit pack: 5,000 credits', {
      idempotencyKey: 'cs_1',
      userId: 'user-1',
      meta: { creditPackId: 'credits-5k', credits: 5000 },
    });

    assert.equal(res.granted, true);
    assert.equal(res.alreadyFulfilled, false);
    assert.equal(res.balanceAfter, 5000);

    // Credit balance incremented with a session (transactional) + notify re-armed.
    assert.equal(creditUpdateCalls.length, 1);
    assert.equal(creditUpdateCalls[0].update.$inc.generalCredits, 5000);
    assert.equal(creditUpdateCalls[0].update.$set.lowBalanceNotifiedAt, null);
    assert.ok(creditUpdateCalls[0].opts.session, 'grant runs in the transaction session');

    // Marker persisted with the idempotency key.
    const marker = markerStore.get('cs_1');
    assert.ok(marker);
    assert.equal(marker.type, 'purchase');
    assert.equal(marker.amount, 5000);
    assert.equal(marker.metadata.creditPackId, 'credits-5k');
    assert.equal(sessionEnded, true, 'session always ended');
  });
});

describe('grantGeneralCreditsIdempotent — idempotency', () => {
  it('fast path: an already-fulfilled key grants nothing', async () => {
    markerStore.set('cs_dup', { type: 'purchase', metadata: { stripeSessionId: 'cs_dup' } });
    const res = await creditService.grantGeneralCreditsIdempotent('org-1', 5000, 'x', { idempotencyKey: 'cs_dup' });
    assert.deepEqual(res, { granted: false, alreadyFulfilled: true, balanceAfter: 0 });
    assert.equal(creditUpdateCalls.length, 0, 'no grant on redelivery');
  });

  it('concurrent race: a duplicate-key on the marker insert reports alreadyFulfilled, not an error', async () => {
    // Simulate the racing winner having committed AFTER our fast-path read but
    // BEFORE our insert: fast path sees nothing, insert hits 11000.
    CreditTransaction.findOne = () => ({ lean: async () => null }); // fast path misses
    let firstInsert = true;
    CreditTransaction.create = async () => {
      if (firstInsert) {
        firstInsert = false;
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      return [{}];
    };

    const res = await creditService.grantGeneralCreditsIdempotent('org-1', 5000, 'x', { idempotencyKey: 'cs_race' });
    assert.equal(res.alreadyFulfilled, true);
    assert.equal(res.granted, false);
    assert.equal(sessionEnded, true);
  });
});

describe('grantGeneralCreditsIdempotent — error + guard paths', () => {
  it('propagates a transient DB error so the caller can let Stripe retry', async () => {
    Credit.findOneAndUpdate = async () => {
      throw new Error('connection reset');
    };
    await assert.rejects(
      creditService.grantGeneralCreditsIdempotent('org-1', 5000, 'x', { idempotencyKey: 'cs_err' }),
      /connection reset/
    );
    assert.equal(sessionEnded, true, 'session ended even on throw');
  });

  it('throws when no idempotencyKey is supplied (programmer error)', async () => {
    await assert.rejects(
      creditService.grantGeneralCreditsIdempotent('org-1', 5000, 'x', {}),
      /requires an idempotencyKey/
    );
  });

  it('is a no-op for non-positive amounts', async () => {
    const res = await creditService.grantGeneralCreditsIdempotent('org-1', 0, 'x', { idempotencyKey: 'cs_zero' });
    assert.equal(res.granted, false);
    assert.equal(creditUpdateCalls.length, 0);
  });
});
