/**
 * Credit-ledger reconciliation (test plan Phase 3).
 *
 * Detects the money anomalies no request path ever reports:
 *   A) ORPHANED PENDING — pre-deductions older than 30 min never settled or
 *      refunded (crash between preDeduct and settle that both sweeps missed,
 *      or a sweep that keeps failing).
 *   B) STUCK CLAIMS — transactions in the transient 'settling'/'refunding'
 *      states (F10-02 atomic claims) older than 10 min: a process died
 *      mid-settle and that group will never terminate on its own.
 *   C) NEGATIVE POOLS — any Credit/UserCredit pool below zero: a refund
 *      applied twice or a deduction raced past its guard.
 *
 * Usage:
 *   node scripts/reconcileTrackerCredits.js          # uses MONGODB_URI/MONGO_URI
 *   MONGODB_URI=... node scripts/reconcileTrackerCredits.js
 *
 * Exits 0 when clean, 1 when any anomaly is found, 2 on connection failure.
 * Intended for a nightly run against the dev DB (plan Phases 3/9/18);
 * `reconcile()` is exported for the test suite.
 */

const mongoose = require('mongoose');
const CreditTransaction = require('../src/models/CreditTransaction');
const Credit = require('../src/models/Credit');
const UserCredit = require('../src/models/UserCredit');

const ORPHAN_CUTOFF_MS = 30 * 60 * 1000;
const STUCK_CLAIM_CUTOFF_MS = 10 * 60 * 1000;
// Mirrors creditRules' keywordLookup cap. Deliberately duplicated: if someone
// raises the cap in one place only, this reconciliation should notice.
const KEYWORD_ROW_CAP = 50;

async function reconcile({ now = Date.now() } = {}) {
  const anomalies = [];

  // A) Orphaned pending pre-deductions
  const orphanCutoff = new Date(now - ORPHAN_CUTOFF_MS);
  const orphans = await CreditTransaction.find({
    status: 'pending',
    createdAt: { $lt: orphanCutoff },
  }).lean();
  for (const tx of orphans) {
    anomalies.push({
      check: 'orphaned_pending',
      txId: tx._id.toString(),
      orgId: tx.organizationId?.toString() || null,
      amount: tx.amount,
      ageMinutes: Math.round((now - new Date(tx.createdAt).getTime()) / 60000),
    });
  }

  // B) Stuck settling/refunding claims
  const stuckCutoff = new Date(now - STUCK_CLAIM_CUTOFF_MS);
  const stuck = await CreditTransaction.find({
    status: { $in: ['settling', 'refunding'] },
    updatedAt: { $lt: stuckCutoff },
  }).lean();
  for (const tx of stuck) {
    anomalies.push({
      check: 'stuck_claim',
      txId: tx._id.toString(),
      status: tx.status,
      orgId: tx.organizationId?.toString() || null,
      amount: tx.amount,
    });
  }

  // C) Negative pools
  const negativeOrgs = await Credit.find({
    $or: [{ subscriptionCredits: { $lt: 0 } }, { generalCredits: { $lt: 0 } }],
  }).lean();
  for (const c of negativeOrgs) {
    anomalies.push({
      check: 'negative_pool',
      orgId: c.organizationId?.toString() || null,
      subscription: c.subscriptionCredits,
      general: c.generalCredits,
    });
  }
  const negativeUsers = await UserCredit.find({ freeCredits: { $lt: 0 } }).lean();
  for (const u of negativeUsers) {
    anomalies.push({
      check: 'negative_pool',
      userId: u.userId?.toString() || null,
      userFree: u.freeCredits,
    });
  }

  // D) KEYWORD OVERCHARGE (Phase C4). keywordLookup bills 1 credit per row
  // DELIVERED, capped at 50. Two failures are invisible to every request path
  // because each individual charge looks reasonable in isolation:
  //   - charge > 50: the cap in creditRules regressed (the Phase-B M1 mutation).
  //   - charge > rows delivered: settle-to-delivered drifted, so we billed for
  //     rows the customer never received — the exact shape of a silent
  //     overcharge, and the one a customer would eventually find for us.
  // 'settled' is the deductForRequest path (pre-deduct + immediate settle);
  // 'confirmed' covers a direct single-shot deduction. Both are terminal
  // charges the customer actually paid.
  // The feature lives in metadata.feature (preDeduct stamps it there) — there
  // is no top-level featureKey column. Deductions only: a refund is a positive
  // amount and would otherwise look like a giant "charge".
  const keywordCharges = await CreditTransaction.find({
    'metadata.feature': 'keywordLookup',
    type: 'deduction',
    status: { $in: ['settled', 'confirmed'] },
  }).lean();
  for (const tx of keywordCharges) {
    const charged = Math.abs(tx.amount ?? 0);
    if (charged > KEYWORD_ROW_CAP) {
      anomalies.push({
        check: 'keyword_overcharge_cap',
        txId: tx._id.toString(),
        orgId: tx.organizationId?.toString() || null,
        charged,
        cap: KEYWORD_ROW_CAP,
      });
    }
    // keywordController stamps `metadata.rows` (chargeKeywordRows →
    // deductForRequest). `rowsDelivered` is accepted as an alias so a future
    // rename does not silently disable this check. An ABSENT value means the
    // row count was never recorded — not evidence of an overcharge.
    const rows = tx.metadata?.rows ?? tx.metadata?.rowsDelivered;
    if (typeof rows === 'number' && charged > rows) {
      anomalies.push({
        check: 'keyword_overcharge_rows',
        txId: tx._id.toString(),
        orgId: tx.organizationId?.toString() || null,
        charged,
        rowsDelivered: rows,
      });
    }
  }

  return { anomalies, clean: anomalies.length === 0 };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('[reconcile] no MONGODB_URI / MONGO_URI set');
    process.exit(2);
  }
  try {
    await mongoose.connect(uri);
  } catch (e) {
    console.error('[reconcile] connection failed:', e.message);
    process.exit(2);
  }

  const report = await reconcile();
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
  process.exit(report.clean ? 0 : 1);
}

if (require.main === module) main();

module.exports = { reconcile, ORPHAN_CUTOFF_MS, STUCK_CLAIM_CUTOFF_MS };
