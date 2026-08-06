/**
 * Phase 3 — orphan sweep (scenario 6) + reconciliation checks.
 *
 * The sweep (creditService.sweepOrphanedPendingCredits — extracted from the
 * inline index.js startup/cron blocks) must: refund only aged pending
 * groups, restore the exact balance, be idempotent, and repair the usage
 * counter. The reconciliation script must flag orphaned/stuck/negative
 * anomalies and stay silent on a healthy ledger.
 *
 * Run: node --test tests/aiTracker/credits-sweep.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const ledger = require('./helpers/ledger');
const creditService = require('../../src/services/creditService');
const tierService = require('../../src/services/tierService');
const CreditTransaction = require('../../src/models/CreditTransaction');
const UsageTracker = require('../../src/models/UsageTracker');
const { reconcile } = require('../../scripts/reconcileTrackerCredits');

before(async () => {
  await db.connect();
  await db.clear();
}, { timeout: 300_000 });

after(async () => {
  await db.disconnect();
});

describe('scenario 6 — crash between preDeduct and settle → orphan sweep recovers', () => {
  it('fresh pending txs are NOT swept (a live scan is not an orphan)', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    await creditService.grantGeneralCredits(orgId, 50, 'sweep seed');
    await creditService.preDeduct(orgId, null, 10, 'aiTrackerScan', { feature: 'aiTrackerScan' });

    const result = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.equal(result.refundedGroups, 0, 'a seconds-old pending group must survive the sweep');
    assert.equal((await creditService.getBalance(orgId)).total, 40, 'still deducted');

    // Cleanup for later tests: age it and let the idempotency test consume it.
    await ledger.backdateTransactions(mongoose.connection, {
      organizationId: new mongoose.Types.ObjectId(orgId), status: 'pending',
    });
    const sweep2 = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.equal(sweep2.refundedGroups, 1, 'aged orphan refunded');
    assert.equal((await creditService.getBalance(orgId)).total, 50, 'balance fully restored');
  });

  it('sweep is idempotent and repairs the usage counter (F10-03)', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    await creditService.grantGeneralCredits(orgId, 80, 'sweep seed 2');
    await creditService.preDeduct(orgId, null, 15, 'aiTrackerScan', { feature: 'aiTrackerScan' });

    const period = tierService.getPeriod('monthly');
    assert.equal(
      (await UsageTracker.findOne({ organizationId: orgId, period }).lean()).creditsUsed,
      15,
      'usage raised by the pre-deduction',
    );

    await ledger.backdateTransactions(mongoose.connection, {
      organizationId: new mongoose.Types.ObjectId(orgId), status: 'pending',
    });

    const first = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.equal(first.refundedGroups, 1);
    assert.equal((await creditService.getBalance(orgId)).total, 80);
    assert.equal(
      (await UsageTracker.findOne({ organizationId: orgId, period }).lean()).creditsUsed,
      0,
      'refund lowered the usage counter back',
    );

    const second = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.equal(second.refundedGroups, 0, 'second sweep finds nothing — no double-refund');
    assert.equal((await creditService.getBalance(orgId)).total, 80, 'balance unchanged by re-sweep');
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'S6');
  });
});

describe('three-pool split + reverse-order settle refund (review addition)', () => {
  it('deduction spans subscription→general→user_free; settle refunds user_free first, then general', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    const userId = new mongoose.Types.ObjectId().toString();
    await creditService.grantSubscriptionCredits(orgId, 4, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    await creditService.grantGeneralCredits(orgId, 3, 'pool-split seed');
    await creditService.grantFreeCredits(userId, 5, 'pool-split seed');

    // Deduct 10 → 4 subscription + 3 general + 3 user_free (deduction order).
    const { transactionId } = await creditService.preDeduct(orgId, userId, 10, 'aiTrackerScan', { feature: 'aiTrackerScan' });
    let b = await creditService.getBalance(orgId, userId);
    assert.deepEqual(
      { subscription: b.subscription, general: b.general, userFree: b.userFree },
      { subscription: 0, general: 0, userFree: 2 },
      'three-way split follows subscription → general → user_free',
    );

    // Settle actual=6 → refund 4 in REVERSE order: user_free gets its 3 back
    // first, general gets the remaining 1; subscription stays spent.
    const { refunded } = await creditService.settle(transactionId, 6);
    assert.equal(refunded, 4);
    b = await creditService.getBalance(orgId, userId);
    assert.deepEqual(
      { subscription: b.subscription, general: b.general, userFree: b.userFree },
      { subscription: 0, general: 1, userFree: 5 },
      'refund order is user_free → general → subscription',
    );
    assert.equal(b.total, 6, 'net charge is exactly the settled amount');
    await ledger.assertNoPendingTx({ organizationId: orgId }, 'pool-split');
  });
});

describe('reconciliation checks', () => {
  it('healthy ledger → clean report', async () => {
    const report = await reconcile();
    assert.equal(report.clean, true, JSON.stringify(report.anomalies));
  });

  it('flags orphaned pending groups older than the cutoff', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    await creditService.grantGeneralCredits(orgId, 30, 'reconcile seed');
    await creditService.preDeduct(orgId, null, 5, 'aiTrackerScan', { feature: 'aiTrackerScan' });
    await ledger.backdateTransactions(mongoose.connection, {
      organizationId: new mongoose.Types.ObjectId(orgId), status: 'pending',
    });

    const report = await reconcile();
    assert.equal(report.clean, false);
    const orphan = report.anomalies.find((a) => a.check === 'orphaned_pending' && a.orgId === orgId);
    assert.ok(orphan, 'orphan reported');
    assert.ok(orphan.ageMinutes >= 30);

    // Repair so later tests see a clean ledger.
    await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.equal((await reconcile()).clean, true);
  });

  it('flags stuck settling/refunding claims (process died mid-settle)', async () => {
    const orgId = new mongoose.Types.ObjectId();
    // Insert via the driver to control updatedAt — a crashed claim looks
    // exactly like this: transient status with a stale timestamp.
    const stale = new Date(Date.now() - 15 * 60 * 1000);
    const { insertedId } = await mongoose.connection.db.collection('credittransactions').insertOne({
      organizationId: orgId,
      type: 'deduction',
      amount: -7,
      pool: 'general',
      status: 'settling',
      metadata: {},
      createdAt: stale,
      updatedAt: stale,
    });

    const report = await reconcile();
    const stuck = report.anomalies.find((a) => a.check === 'stuck_claim' && a.txId === insertedId.toString());
    assert.ok(stuck, 'stuck claim reported');
    assert.equal(stuck.status, 'settling');

    await mongoose.connection.db.collection('credittransactions').deleteOne({ _id: insertedId });
  });

  it('CLI exits 0 on a clean ledger and 1 on a seeded discrepancy (review addition)', { timeout: 120_000 }, async () => {
    const { execFileSync } = require('node:child_process');
    const path = require('node:path');
    const script = path.join(__dirname, '../../scripts/reconcileTrackerCredits.js');
    const env = { ...process.env, MONGODB_URI: db.getUri() };

    // Clean ledger → exit 0 (execFileSync throws on non-zero).
    execFileSync(process.execPath, [script], { env, stdio: 'pipe' });

    // Seed an aged orphan → exit 1.
    const orgId = new mongoose.Types.ObjectId().toString();
    await creditService.grantGeneralCredits(orgId, 20, 'cli seed');
    await creditService.preDeduct(orgId, null, 5, 'aiTrackerScan', { feature: 'aiTrackerScan' });
    await ledger.backdateTransactions(mongoose.connection, {
      organizationId: new mongoose.Types.ObjectId(orgId), status: 'pending',
    });

    let exitCode = 0;
    let stdout = '';
    try {
      execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
    } catch (e) {
      exitCode = e.status;
      stdout = e.stdout?.toString() || '';
    }
    assert.equal(exitCode, 1, 'anomalies must produce a non-zero exit for the nightly job');
    assert.ok(stdout.includes('orphaned_pending'), 'report names the anomaly');

    // Repair for later tests.
    await creditService.sweepOrphanedPendingCredits({ logPrefix: '[test]' });
    assert.equal((await reconcile()).clean, true);
  });

  it('flags negative pools (double-refund / raced deduction)', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('credits').insertOne({
      organizationId: orgId,
      subscriptionCredits: 0,
      generalCredits: -12,
    });

    const report = await reconcile();
    const neg = report.anomalies.find((a) => a.check === 'negative_pool' && a.orgId === orgId.toString());
    assert.ok(neg, 'negative pool reported');
    assert.equal(neg.general, -12);

    await mongoose.connection.db.collection('credits').deleteOne({ organizationId: orgId });
    assert.equal((await reconcile()).clean, true, 'ledger clean after repairs');
  });
});
