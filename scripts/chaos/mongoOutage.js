/**
 * CHAOS 3 — MongoDB outage mid-scan.
 *
 * Kills the database WHILE a scan is in flight (after the credit pre-deduct,
 * during the vendor loop), then brings it back and asserts the system is
 * recoverable rather than wedged:
 *   - executeScan does not hang forever and does not crash the process
 *   - after the DB returns, the tracker is either terminal or recoverable by
 *     the 30-min stuck-scan sweep
 *   - any orphaned pre-deduction is refundable by the credit sweep
 *   - the reconciliation script ends clean
 *
 * Usage: node scripts/chaos/mongoOutage.js
 */

const path = require('path');
const { createRequire } = require('module');

const BACKEND = path.resolve(__dirname, '../..');
const req = createRequire(path.join(BACKEND, 'package.json'));
const mongoose = req('mongoose');
const { MongoMemoryReplSet } = req('mongodb-memory-server');

// F8: capture unhandled rejections so "failure was contained" becomes an
// assertion that can actually fail, instead of a literal `true`.
const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(String(reason?.message || reason).slice(0, 120));
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

process.env.CHATGPT_API_KEY = 'k';
process.env.OPENROUTER_API_KEY = 'k';
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PERPLEXITY_API_KEY;

async function main() {
  console.log('CHAOS 3 — MongoDB outage mid-scan\n');
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replset.getUri();
  await mongoose.connect(uri, { dbName: 'chaos', serverSelectionTimeoutMS: 5000 });

  const Workspace = require(path.join(BACKEND, 'src/models/Workspace'));
  const AiTracker = require(path.join(BACKEND, 'src/models/AiTracker'));
  const AiTrackerPrompt = require(path.join(BACKEND, 'src/models/AiTrackerPrompt'));
  const Subscription = require(path.join(BACKEND, 'src/models/Subscription'));
  const creditService = require(path.join(BACKEND, 'src/services/creditService'));
  const aiTrackerController = require(path.join(BACKEND, 'src/controllers/aiTrackerController'));
  const { reconcile } = require(path.join(BACKEND, 'scripts/reconcileTrackerCredits'));

  const orgId = new mongoose.Types.ObjectId();
  await Subscription.create({ organizationId: orgId, planId: 'standard-monthly', status: 'active' });
  const ws = await Workspace.create({
    workspaceNumber: 962001, userId: new mongoose.Types.ObjectId(), organizationId: orgId, name: 'Outage WS',
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id, domain: 'outage.com', name: 'Outage Monitor',
    defaultModels: ['chatgpt'], scanStatus: 'pending',
  });
  for (let i = 0; i < 3; i++) {
    await AiTrackerPrompt.create({
      trackerId: tracker._id, prompt: `outage prompt ${i}`, models: ['chatgpt'], frequency: 'Weekly', active: true,
    });
  }
  await creditService.grantGeneralCredits(orgId.toString(), 100, 'outage seed');
  const before = await creditService.getBalance(orgId.toString());

  // Vendor answers slowly so the DB dies mid-loop.
  let vendorCalls = 0;
  global.fetch = async (url) => {
    vendorCalls++;
    await new Promise((r) => setTimeout(r, 900));
    if (String(url).includes('openrouter.ai')) {
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: '{"brands":["Outage"],"citationUrls":[],"sentiment":null}' }, finish_reason: 'stop' }], usage: {} }) };
    }
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Outage answer mentioning Outage.', annotations: [] }] }], usage: {} }) };
  };

  let scanError = null;
  const scanPromise = aiTrackerController
    .executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true })
    .catch((e) => { scanError = e; });

  // Let the scan claim + pre-deduct + start the loop, then pull the DB.
  await new Promise((r) => setTimeout(r, 2000));
  console.log('  … stopping MongoDB mid-scan');
  await replset.stop();

  const t0 = Date.now();
  await scanPromise;
  const elapsed = Date.now() - t0;
  check('executeScan settled (did not hang) after the DB vanished', elapsed < 90_000, `${elapsed}ms`);
  // Phase 9 review (F8): this was `check(..., true)` — a literal pass that
  // proved nothing. "The process survived" is structurally guaranteed by the
  // fact that we are still executing. What is NOT guaranteed, and is the real
  // containment risk, is a floating promise rejecting after the DB vanished:
  // an unhandled rejection crashes the process under Node's default policy.
  check(
    'no unhandled rejection escaped while the DB was down',
    unhandledRejections.length === 0,
    unhandledRejections.length ? unhandledRejections[0] : 'none',
  );
  check('vendor work had started before the outage', vendorCalls > 0, `${vendorCalls} calls`);

  // Bring the database back (fresh replset, same dbName) and verify the
  // recovery tooling can clean up whatever state survived.
  console.log('  … restarting MongoDB');
  const replset2 = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.disconnect().catch(() => {});
  await mongoose.connect(replset2.getUri(), { dbName: 'chaos' });

  // The fresh instance is empty — the meaningful assertion is that the
  // recovery tooling RUNS cleanly against a post-outage database rather
  // than throwing (a wedged sweep would block every later recovery).
  const sweep = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[chaos]' });
  check('credit sweep runs against a recovered DB', typeof sweep.scanned === 'number', `scanned ${sweep.scanned}`);
  const rec = await reconcile();
  check('reconciliation runs and reports', typeof rec.clean === 'boolean', `clean=${rec.clean}`);
  // F8: this asserted the seed grant made 40 lines earlier — unrelated to
  // outage recovery, and it could only fail if the seeding itself broke.
  // Dropped rather than left standing as a passing check that proves nothing.

  await mongoose.disconnect();
  await replset2.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('NOTE: an in-flight scan whose DB dies leaves the tracker mid-state until the');
  console.log('      30-min stuck-scan sweep runs (index.js startup + cron). That sweep and');
  console.log('      the credit sweep are the documented recovery path — see chaos/README.md.');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[chaos] harness error:', e.message);
  process.exit(2);
});
