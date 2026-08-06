/**
 * Phase C4 — keyword chaos + reconciliation.
 *
 * The failure matrix (Phase B4) covers clean single failures. Chaos covers the
 * ugly ones: a vendor that is slow rather than down, a vendor that half-works,
 * a Mongo blip in the middle of a search, and a partial outage where one
 * vendor is fine and the other is not.
 *
 * The invariant is the same in every case and it is the only one that matters:
 * WE NEVER KEEP MONEY FOR WORK WE DID NOT DELIVER, and we never poison the
 * shared cache with a degraded result.
 *
 * Also exercises the new reconciliation check (D) that flags keyword
 * overcharges no request path can see.
 *
 * Run: node --test tests/keywords/chaos.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const db = require('../aiTracker/helpers/db');
const vendorMock = require('../aiTracker/helpers/vendorMock');
const ledger = require('../aiTracker/helpers/ledger');
const fx = require('./helpers/fixtures');
const { seedWorld, seedTierConfigs, buildReq, makeRes } = require('./helpers/world');

const KeywordSearch = require('../../src/models/KeywordSearch');
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');
const CreditTransaction = require('../../src/models/CreditTransaction');
const keywordController = require('../../src/controllers/keywordController');
const { reconcile } = require('../../scripts/reconcileTrackerCredits');

before(async () => {
  await db.connect();
  await db.clear();
  await seedTierConfigs();
  vendorMock.install();
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

beforeEach(async () => {
  vendorMock.script({});
  await KeywordSearch.deleteMany({});
  await KeywordResearchHistory.deleteMany({});
});

describe('chaos — degraded vendors never produce a charge without delivery', () => {
  it('DataForSEO brownout (500 then 500) — no charge, no cache, no quota', { timeout: 90_000 }, async () => {
    const world = await seedWorld();
    const before = await ledger.snapshot(world.orgId);
    vendorMock.script({
      dataforseo: [
        { status: 500, text: 'upstream is having a bad day' },
        { status: 500, text: 'upstream is having a bad day' },
      ],
    });

    const req = await buildReq(world, { body: { keyword: 'brownout probe' } });
    const res = makeRes();
    await keywordController.searchKeywords(req, res);

    assert.equal(res.statusCode, 500);
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'brownout' });
    assert.equal(await KeywordSearch.countDocuments({}), 0, 'a brownout poisoned the shared cache');
  });

  it('a vendor timeout is treated as a failure, not as an empty result', { timeout: 90_000 }, async () => {
    const world = await seedWorld();
    const before = await ledger.snapshot(world.orgId);
    vendorMock.script({ dataforseo: [{ error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) }] });

    const req = await buildReq(world, { body: { keyword: 'timeout probe' } });
    const res = makeRes();
    await keywordController.searchKeywords(req, res);

    assert.equal(res.statusCode, 500, 'a timeout must not masquerade as a successful empty search');
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'timeout' });
    // Critically: an empty CACHE ROW here would serve "no results" for a real
    // keyword for the whole negative-TTL window.
    assert.equal(await KeywordSearch.countDocuments({}), 0, 'a timeout was cached as an empty result');
  });

  it('malformed JSON from the vendor fails cleanly', { timeout: 90_000 }, async () => {
    const world = await seedWorld();
    const before = await ledger.snapshot(world.orgId);
    vendorMock.script({ dataforseo: [{ status: 200, text: '{"tasks": [ THIS IS NOT JSON' }] });

    const req = await buildReq(world, { body: { keyword: 'malformed probe' } });
    const res = makeRes();
    await keywordController.searchKeywords(req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Failed to search keywords', 'parser detail leaked');
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'malformed' });
  });

  it('a Mongo blip while writing the cache does not leave a charge behind', { timeout: 90_000 }, async () => {
    const world = await seedWorld();
    const before = await ledger.snapshot(world.orgId);
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(5))] });

    const original = KeywordSearch.findOneAndUpdate;
    KeywordSearch.findOneAndUpdate = () => { throw new Error('connection reset by peer'); };
    const req = await buildReq(world, { body: { keyword: 'mongo blip probe' } });
    const res = makeRes();
    try {
      await keywordController.searchKeywords(req, res);
    } finally {
      KeywordSearch.findOneAndUpdate = original;
    }

    // The cache write happens BEFORE the charge (keywordController: the
    // KeywordSearch upsert precedes chargeKeywordRows), so a blip there must
    // abort the request with nothing billed. Asserted exactly rather than as
    // "200-or-500": if someone reorders the charge ahead of the durable write,
    // this test should fail — that ordering is what prevents billing for a
    // result we then failed to persist.
    const after = await ledger.snapshot(world.orgId);
    const charged = before.total - after.total;
    assert.equal(res.statusCode, 500, 'a failed cache write should abort the request');
    assert.equal(charged, 0, 'a failed search kept the customer\'s credits');
    await ledger.assertNoPendingTx({ organizationId: world.orgId }, 'mongo blip');
  });

  it('partial outage: Serper down does not break or bill the DataForSEO search', { timeout: 90_000 }, async () => {
    const world = await seedWorld();
    const before = await ledger.snapshot(world.orgId);
    vendorMock.script({
      dataforseo: [vendorMock.jsonReply(fx.dfsOk(6))],
      serper: [{ status: 503, text: 'serper unavailable' }],
    });

    const req = await buildReq(world, { body: { keyword: 'partial outage probe' } });
    const res = makeRes();
    await keywordController.searchKeywords(req, res);

    assert.equal(res.statusCode, 200, 'the keyword search depends only on DataForSEO');
    assert.equal(res.body.totalCount, 6);
    const charged = before.total - (await ledger.snapshot(world.orgId)).total;
    assert.equal(charged, 6, 'billed something other than the rows delivered');
  });

  it('recovery: a failed search leaves nothing that blocks the retry', { timeout: 90_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [{ status: 500, text: 'boom' }] });
    const req1 = await buildReq(world, { body: { keyword: 'recovery probe' } });
    await keywordController.searchKeywords(req1, makeRes());

    // Retry succeeds and bills normally — no stuck single-flight entry, no
    // poisoned negative-cache row standing in the way.
    const before = await ledger.snapshot(world.orgId);
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(4))] });
    const req2 = await buildReq(world, { body: { keyword: 'recovery probe' } });
    const res2 = makeRes();
    await keywordController.searchKeywords(req2, res2);

    assert.equal(res2.statusCode, 200, 'the retry was blocked by residue from the failure');
    assert.equal(res2.body.totalCount, 4);
    const charged = before.total - (await ledger.snapshot(world.orgId)).total;
    assert.equal(charged, 4);
  });
});

describe('reconciliation check D — keyword overcharges', () => {
  it('a clean ledger reports no keyword anomalies', { timeout: 90_000 }, async () => {
    await CreditTransaction.deleteMany({});
    const { anomalies } = await reconcile({ now: Date.now() });
    assert.deepEqual(anomalies.filter((a) => a.check.startsWith('keyword_')), []);
  });

  it('flags a charge above the 50-row cap', { timeout: 90_000 }, async () => {
    await CreditTransaction.deleteMany({});
    await CreditTransaction.create({
      organizationId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      type: 'deduction', pool: 'general',
      amount: -105,
      status: 'settled',
      description: 'cap regression', metadata: { feature: 'keywordLookup' },
    });
    const { anomalies } = await reconcile({ now: Date.now() });
    const hit = anomalies.find((a) => a.check === 'keyword_overcharge_cap');
    assert.ok(hit, 'a 105-credit keyword charge was not flagged');
    assert.equal(hit.charged, 105);
    assert.equal(hit.cap, 50);
  });

  it('flags a charge greater than the rows delivered', { timeout: 90_000 }, async () => {
    await CreditTransaction.deleteMany({});
    await CreditTransaction.create({
      organizationId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      type: 'deduction', pool: 'general',
      amount: -20,
      status: 'settled',
      description: 'settle drift',
      metadata: { feature: 'keywordLookup', rows: 7 },
    });
    const { anomalies } = await reconcile({ now: Date.now() });
    const hit = anomalies.find((a) => a.check === 'keyword_overcharge_rows');
    assert.ok(hit, 'billing 20 for 7 delivered rows was not flagged');
    assert.equal(hit.charged, 20);
    assert.equal(hit.rowsDelivered, 7);
  });

  it('reads the field the CONTROLLER actually writes (metadata.rows)', { timeout: 90_000 }, async () => {
    // Guards the failure this check was nearly shipped with: it originally
    // looked for `rowsDelivered`, which production never writes, so it would
    // have reported "clean" forever. This drives a REAL search and then
    // reconciles the transaction it produced.
    await CreditTransaction.deleteMany({});
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(9))] });
    const req = await buildReq(world, { body: { keyword: 'reconcile end to end' } });
    const res = makeRes();
    await keywordController.searchKeywords(req, res);
    assert.equal(res.statusCode, 200);

    const tx = await CreditTransaction.findOne({ 'metadata.feature': 'keywordLookup' }).lean();
    assert.ok(tx, 'the search produced no keywordLookup transaction to reconcile');
    assert.equal(tx.metadata.rows, 9, 'the controller no longer stamps metadata.rows — check D just went blind');

    const { anomalies } = await reconcile({ now: Date.now() });
    assert.deepEqual(
      anomalies.filter((a) => a.check.startsWith('keyword_')), [],
      'a legitimate 9-row charge was flagged as an overcharge',
    );
  });

  it('does NOT flag a correct charge, nor one with no rows recorded', { timeout: 90_000 }, async () => {
    await CreditTransaction.deleteMany({});
    const orgId = new mongoose.Types.ObjectId();
    await CreditTransaction.create({
      organizationId: orgId, userId: new mongoose.Types.ObjectId(),
      type: 'deduction', pool: 'general', amount: -7, status: 'settled',
      description: 'correct', metadata: { feature: 'keywordLookup', rows: 7 },
    });
    await CreditTransaction.create({
      organizationId: orgId, userId: new mongoose.Types.ObjectId(),
      type: 'deduction', pool: 'general', amount: -12, status: 'settled',
      description: 'legacy row with no rowsDelivered', metadata: { feature: 'keywordLookup' },
    });
    const { anomalies } = await reconcile({ now: Date.now() });
    assert.deepEqual(
      anomalies.filter((a) => a.check.startsWith('keyword_')), [],
      'a correct charge (or a legacy row) was flagged — this check must not cry wolf',
    );
  });
});
