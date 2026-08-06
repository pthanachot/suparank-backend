/**
 * CHAOS 2 — vendor brownout (429/5xx/timeout storm).
 *
 * Runs three real scans against a misbehaving vendor stub and asserts the
 * degradation contract holds in each mode:
 *   429 storm     → retries exhaust → platform error:true, scan still ready
 *   5xx storm     → same, and the answer/analyzer split stays sane
 *   timeout storm → aborts surface as errors, no hang past the budget
 * In every mode: the scan must COMPLETE (never hang), the tracker must reach
 * a terminal state, and money must be conserved (nothing settled for work
 * that produced no results is the refresh-single contract; refresh-all bills
 * per prompt scanned — asserted as "balance moved by at most the estimate").
 *
 * Usage: node scripts/chaos/vendorBrownout.js
 */

const path = require('path');
const { createRequire } = require('module');

const BACKEND = path.resolve(__dirname, '../..');
const req = createRequire(path.join(BACKEND, 'package.json'));
const mongoose = req('mongoose');
const { MongoMemoryReplSet } = req('mongodb-memory-server');

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

const MODES = {
  '429 storm': () => ({ ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '1' : null) }, json: async () => ({}), text: async () => 'rate limited' }),
  '5xx storm': () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => 'unavailable' }),
  'timeout storm': () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; },
};

async function main() {
  console.log('CHAOS 2 — vendor brownout\n');
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replset.getUri(), { dbName: 'chaos' });

  const Workspace = require(path.join(BACKEND, 'src/models/Workspace'));
  const AiTracker = require(path.join(BACKEND, 'src/models/AiTracker'));
  const AiTrackerPrompt = require(path.join(BACKEND, 'src/models/AiTrackerPrompt'));
  const AiTrackerScan = require(path.join(BACKEND, 'src/models/AiTrackerScan'));
  const creditService = require(path.join(BACKEND, 'src/services/creditService'));
  const aiTrackerController = require(path.join(BACKEND, 'src/controllers/aiTrackerController'));

  let wsNum = 961001;
  for (const [mode, responder] of Object.entries(MODES)) {
    console.log(`\n[${mode}]`);
    const orgId = new mongoose.Types.ObjectId();
    const ws = await Workspace.create({
      workspaceNumber: wsNum++, userId: new mongoose.Types.ObjectId(), organizationId: orgId, name: `Brownout ${mode}`,
    });
    const tracker = await AiTracker.create({
      workspaceId: ws._id, domain: 'brownout.com', name: `Brownout ${mode}`,
      defaultModels: ['chatgpt'], scanStatus: 'pending',
    });
    await AiTrackerPrompt.create({
      trackerId: tracker._id, prompt: `brownout prompt ${mode}`, models: ['chatgpt'], frequency: 'Weekly', active: true,
    });
    await creditService.grantGeneralCredits(orgId.toString(), 100, 'brownout seed');
    const before = await creditService.getBalance(orgId.toString());

    global.fetch = async () => responder();

    const t0 = Date.now();
    await aiTrackerController.executeScan(tracker._id, null, { force: true, costAction: 'trackerRefreshAll', bill: true });
    const elapsed = Date.now() - t0;

    const after = await AiTracker.findById(tracker._id).lean();
    check(`${mode}: scan completed without hanging`, elapsed < 120_000, `${elapsed}ms`);
    check(`${mode}: tracker reached a terminal state`, ['ready', 'failed'].includes(after.scanStatus), after.scanStatus);

    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    if (scan) {
      const platform = scan.results?.[0]?.platforms?.[0];
      check(`${mode}: platform marked error:true`, platform ? platform.error === true : false);
      check(`${mode}: scan doc terminal`, ['ready', 'failed'].includes(scan.status), scan.status);
    } else {
      // Phase 9 review (F8): this was `check(..., true)` — a literal pass, so a
      // regression where scans STOP creating scan docs scored a PASS. If no
      // scan doc exists the run must at least have refunded cleanly, which the
      // conservation check below asserts; here we require the tracker itself to
      // record the failure rather than silently showing nothing happened.
      check(
        `${mode}: no scan doc — tracker must still record the failure`,
        after.scanStatus === 'failed',
        `scanStatus=${after.scanStatus}`,
      );
    }

    const balAfter = await creditService.getBalance(orgId.toString());
    const moved = before.total - balAfter.total;
    // F8: `moved >= 0 && moved <= 5` accepted BOTH 0 and the full estimate, so
    // it could not tell a correct refund from being billed for nothing
    // delivered. A brownout delivers no usable result, so the customer must
    // end up paying nothing.
    check(`${mode}: brownout delivered nothing, so nothing was charged`, moved === 0, `${moved} credits`);

    const stuck = await mongoose.connection.db.collection('credittransactions')
      .countDocuments({ organizationId: orgId, status: { $in: ['pending', 'settling', 'refunding'] } });
    check(`${mode}: no transactions left non-terminal`, stuck === 0, `${stuck} stuck`);
  }

  await mongoose.disconnect();
  await replset.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[chaos] harness error:', e.message);
  process.exit(2);
});
