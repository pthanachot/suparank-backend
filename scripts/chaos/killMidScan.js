/**
 * CHAOS 1 — SIGKILL mid-scan (the F4-13 credit-leak scenario).
 *
 * Boots a hermetic memory-replset, seeds a paid org + tracker, launches a
 * scan in a CHILD process against a vendor stub that stalls, then `kill -9`s
 * the child between preDeduct and settle. Asserts the real recovery story:
 *   - credits are stuck in `pending` (money is out of the user's balance)
 *   - the reconciliation script FLAGS it once aged past the cutoff
 *   - the startup/cron sweep REFUNDS it and restores the exact balance
 *   - a second sweep is a no-op (no double refund)
 *
 * Prints PASS/FAIL per assertion; exits non-zero on any failure.
 * Usage: node scripts/chaos/killMidScan.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const BACKEND = path.resolve(__dirname, '../..');
const req = createRequire(path.join(BACKEND, 'package.json'));
const mongoose = req('mongoose');
const { MongoMemoryReplSet } = req('mongodb-memory-server');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const CHILD = path.join(__dirname, '_scanChild.js');

async function main() {
  console.log('CHAOS 1 — SIGKILL mid-scan\n');
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replset.getUri();

  await mongoose.connect(uri, { dbName: 'chaos' });
  const Workspace = require(path.join(BACKEND, 'src/models/Workspace'));
  const AiTracker = require(path.join(BACKEND, 'src/models/AiTracker'));
  const AiTrackerPrompt = require(path.join(BACKEND, 'src/models/AiTrackerPrompt'));
  const Subscription = require(path.join(BACKEND, 'src/models/Subscription'));
  const creditService = require(path.join(BACKEND, 'src/services/creditService'));
  const { reconcile } = require(path.join(BACKEND, 'scripts/reconcileTrackerCredits'));

  const orgId = new mongoose.Types.ObjectId();
  await Subscription.create({ organizationId: orgId, planId: 'standard-monthly', status: 'active' });
  const ws = await Workspace.create({
    workspaceNumber: 960001, userId: new mongoose.Types.ObjectId(), organizationId: orgId, name: 'Chaos WS',
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id, domain: 'chaos.com', name: 'Chaos Monitor',
    defaultModels: ['chatgpt'], scanStatus: 'pending',
  });
  await AiTrackerPrompt.create({
    trackerId: tracker._id, prompt: 'chaos prompt', models: ['chatgpt'], frequency: 'Weekly', active: true,
  });
  await creditService.grantGeneralCredits(orgId.toString(), 100, 'chaos seed');
  const before = await creditService.getBalance(orgId.toString());

  // Child scans with a vendor stub that hangs → guarantees the kill lands
  // between preDeduct and settle.
  const child = spawn(process.execPath, [CHILD, uri, tracker._id.toString()], {
    cwd: BACKEND,
    env: { ...process.env, MONGODB_URI: uri, CHATGPT_API_KEY: 'k', OPENROUTER_API_KEY: 'k', CHAOS_STALL_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childSaidReady = false;
  child.stdout.on('data', (d) => { if (d.toString().includes('SCAN_STARTED')) childSaidReady = true; });

  const deadline = Date.now() + 30_000;
  while (!childSaidReady && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  check('child reached the in-flight scan state', childSaidReady);

  // Give preDeduct time to commit, then SIGKILL.
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  const afterKill = await creditService.getBalance(orgId.toString());
  check('credits were pre-deducted and are now stuck', afterKill.total < before.total,
    `${before.total} → ${afterKill.total}`);

  const trackerAfterKill = await AiTracker.findById(tracker._id).lean();
  check('tracker left mid-flight (scanning/pending)', ['scanning', 'pending'].includes(trackerAfterKill.scanStatus),
    trackerAfterKill.scanStatus);

  // Age the orphan past the sweep cutoff, exactly like a real crash would.
  await mongoose.connection.db.collection('credittransactions').updateMany(
    { status: 'pending' }, { $set: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } },
  );

  const report = await reconcile();
  const flagged = report.anomalies.some((a) => a.check === 'orphaned_pending');
  check('reconciliation FLAGS the orphaned pre-deduction', flagged,
    `${report.anomalies.length} anomaly(ies)`);

  const sweep = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[chaos]' });
  const afterSweep = await creditService.getBalance(orgId.toString());
  check('sweep refunded the orphan', sweep.refundedGroups >= 1, `${sweep.refundedGroups} group(s)`);
  check('balance fully restored', afterSweep.total === before.total, `${afterSweep.total} vs ${before.total}`);

  const sweep2 = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[chaos]' });
  const afterSweep2 = await creditService.getBalance(orgId.toString());
  check('second sweep is a no-op (no double refund)', sweep2.refundedGroups === 0 && afterSweep2.total === before.total);

  check('ledger clean after recovery', (await reconcile()).clean);

  await mongoose.disconnect();
  await replset.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (!fs.existsSync(CHILD)) {
  console.error(`[chaos] missing child runner: ${CHILD}`);
  process.exit(2);
}

main().catch((e) => {
  console.error('[chaos] harness error:', e.message);
  process.exit(2);
});
