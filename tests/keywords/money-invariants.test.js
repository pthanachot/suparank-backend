/**
 * Phase B3 — keyword money & metering invariants.
 *
 * Keyword lookup is the only path in the product that spends money PER ROW
 * on licensed data (1 credit/row, capped at 50). These scenarios drive the
 * REAL controller against the REAL creditService on a memory replset, with
 * DataForSEO/Serper mocked at global fetch, and assert ledger conservation
 * after every outcome.
 *
 * Run: node --test tests/keywords/money-invariants.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// keywordService throws before fetching when creds are absent, so the mock
// would never be reached. Values are irrelevant — global fetch is stubbed.
process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const db = require('../aiTracker/helpers/db');
const vendorMock = require('../aiTracker/helpers/vendorMock');
const ledger = require('../aiTracker/helpers/ledger');
const fx = require('./helpers/fixtures');
const { seedWorld, seedTierConfigs, buildReq, makeRes } = require('./helpers/world');

const KeywordSearch = require('../../src/models/KeywordSearch');
const KeywordDetail = require('../../src/models/KeywordDetail');
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');
const UsageTracker = require('../../src/models/UsageTracker');
const UserUsageTracker = require('../../src/models/UserUsageTracker');
const { resolveCredits } = require('../../src/config/creditRules');
const keywordController = require('../../src/controllers/keywordController');

const search = (req, res) => keywordController.searchKeywords(req, res);

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
  // Caches are GLOBAL (not workspace-scoped) — clear between scenarios so one
  // test's cached rows can't silently satisfy the next test's lookup.
  await KeywordSearch.deleteMany({});
  await KeywordDetail.deleteMany({});
  await KeywordResearchHistory.deleteMany({});
});

describe('S1 — fresh lookup bills exactly 1 credit per row delivered', () => {
  it('7 rows → 7 credits, quota +1, cached, history written', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(7))] });
    const before = await ledger.snapshot(world.orgId);

    const req = await buildReq(world, { body: { keyword: 'seo tools' } });
    const res = makeRes();
    await search(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 7);
    await ledger.assertConservation(before, world.orgId, { settled: 7, label: 'S1' });
    await ledger.assertNoPendingTx({ organizationId: world.orgId }, 'S1');

    const usage = await UsageTracker.findOne({ organizationId: world.orgId }).lean();
    assert.equal(usage.keywordSearches, 1, 'one lookup consumed, not one per row');
    assert.equal(await KeywordSearch.countDocuments({}), 1, 'result cached');
    assert.equal(await KeywordResearchHistory.countDocuments({ workspaceId: world.ws._id }), 1);
  });
});

describe('S2 — the 50-row billing cap', () => {
  it('105 rows delivered → billed 50, never 105', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(105))] });
    const before = await ledger.snapshot(world.orgId);

    const res = makeRes();
    await search(await buildReq(world, { body: { keyword: 'capped keyword' } }), res);

    assert.equal(res.body.totalCount, 105, 'the user still receives every row');
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 105 }), 50);
    await ledger.assertConservation(before, world.orgId, { settled: 50, label: 'S2 (cap)' });
  });
});

describe('S3 — cache hits bill identically (documented policy)', () => {
  it('second identical lookup costs the same, calls NO vendor, and still consumes quota', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(4))] });

    await search(await buildReq(world, { body: { keyword: 'cache me' } }), makeRes());
    const afterFirst = await ledger.snapshot(world.orgId);
    const callsAfterFirst = vendorMock.calls.length;

    const res = makeRes();
    await search(await buildReq(world, { body: { keyword: 'cache me' } }), res);

    assert.equal(res.body.totalCount, 4);
    assert.equal(vendorMock.calls.length, callsAfterFirst, 'cache hit must not call the vendor');
    await ledger.assertConservation(afterFirst, world.orgId, { settled: 4, label: 'S3 (cache hit bills)' });
    const usage = await UsageTracker.findOne({ organizationId: world.orgId }).lean();
    assert.equal(usage.keywordSearches, 2, 'both lookups consumed quota');
  });
});

describe('S4 — /detail is NOT credit-billed (serpDeepDive is inactive)', () => {
  it('fresh detail: zero credits, quota +1; cache hit: zero credits, ZERO quota', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ serper: [vendorMock.jsonReply(fx.serperOk)] });
    const before = await ledger.snapshot(world.orgId);

    const req1 = await buildReq(world, { query: { kw: 'detail kw', country: 'United States' } });
    const res1 = makeRes();
    await keywordController.getKeywordDetail(req1, res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.serpResults.length, 2);
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'S4 fresh (never billed)' });
    assert.equal((await UsageTracker.findOne({ organizationId: world.orgId }).lean()).keywordSearches, 1);

    // Cache hit: the documented asymmetry — free AND quota-free.
    const res2 = makeRes();
    await keywordController.getKeywordDetail(
      await buildReq(world, { query: { kw: 'detail kw', country: 'United States' } }), res2,
    );
    assert.equal(res2.body.fromCache, true);
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'S4 cached' });
    assert.equal(
      (await UsageTracker.findOne({ organizationId: world.orgId }).lean()).keywordSearches, 1,
      'a Serper-free cache hit must not burn quota',
    );
    // And billing an inactive action must remain impossible.
    assert.throws(() => resolveCredits('serpDeepDive', {}), /not active/);
  });
});

describe('S5 — free tier: zero credits, count-gated instead', () => {
  it('rows are delivered, ledger untouched, lifetime counter advances', { timeout: 60_000 }, async () => {
    const world = await seedWorld({ tier: 'free', credits: 100 });
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(9))] });
    const before = await ledger.snapshot(world.orgId);

    const req = await buildReq(world, { body: { keyword: 'free tier keyword' } });
    assert.equal(req.creditContext.tier, 'free');
    const res = makeRes();
    await search(req, res);

    assert.equal(res.body.totalCount, 9, 'free users still get the data');
    assert.equal(resolveCredits('keywordLookup', { tier: 'free', rows: 9 }), 0, 'Option B: fixed bundle');
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'S5 (free = 0 credits)' });

    const userUsage = await UserUsageTracker.findOne({ userId: world.userId }).lean();
    assert.equal(userUsage.keywordSearches, 1, 'lifetime counter is the real gate on free');
  });
});

describe('S6 — vendor failure charges nothing and consumes no quota', () => {
  it('a thrown lookup leaves the ledger, quota and cache untouched', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [{ status: 500, text: 'upstream boom' }] });
    const before = await ledger.snapshot(world.orgId);

    const res = makeRes();
    await search(await buildReq(world, { body: { keyword: 'doomed keyword' } }), res);

    assert.equal(res.statusCode, 500);
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'S6' });
    await ledger.assertNoPendingTx({ organizationId: world.orgId }, 'S6');
    assert.equal(await UsageTracker.countDocuments({ organizationId: world.orgId }), 0, 'no quota consumed');
    assert.equal(await KeywordSearch.countDocuments({}), 0, 'nothing cached');
  });
});

describe('S7 — the charge is settled immediately (sweep-proof)', () => {
  it('the orphan sweep cannot refund a completed keyword charge', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(6))] });

    await search(await buildReq(world, { body: { keyword: 'settled keyword' } }), makeRes());
    const afterCharge = await ledger.snapshot(world.orgId);

    // Age everything and run the sweep — a pending row would be refunded.
    await ledger.backdateTransactions(mongoose.connection, { organizationId: world.orgObjectId });
    const creditService = require('../../src/services/creditService');
    const sweep = await creditService.sweepOrphanedPendingCredits({ logPrefix: '[phaseB]' });

    assert.equal(sweep.refundedGroups, 0, 'deductForRequest settles inline — nothing to sweep');
    await ledger.assertConservation(afterCharge, world.orgId, { settled: 0, label: 'S7 (post-sweep)' });
  });
});

describe('S8 — fail-open paths run the lookup free', () => {
  it('deductionEnabled:false (unmetered/BYOK) delivers rows and bills nothing', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(5))] });
    const before = await ledger.snapshot(world.orgId);

    const res = makeRes();
    await search(await buildReq(world, { body: { keyword: 'unmetered keyword' }, deductionEnabled: false }), res);

    assert.equal(res.body.totalCount, 5);
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'S8' });
  });

  it('an org-less (legacy personal) workspace also runs free', { timeout: 60_000 }, async () => {
    const world = await seedWorld({ orgless: true, credits: 0 });
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(3))] });

    const res = makeRes();
    await search(await buildReq(world, { body: { keyword: 'legacy keyword' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 3);
  });
});

describe('S9 — inactive keyword actions can never be billed', () => {
  it('serpDeepDive / relatedIdeasReport / clusteringRun all throw', () => {
    for (const action of ['serpDeepDive', 'relatedIdeasReport', 'clusteringRun']) {
      assert.throws(() => resolveCredits(action, { rows: 10 }), /not active/, action);
    }
  });

  it('keywordLookup arithmetic: per-row, capped, NaN/negative safe', () => {
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 0 }), 0);
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 1 }), 1);
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 49 }), 49);
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 50 }), 50);
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: 51 }), 50);
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: NaN }), 0);
    assert.equal(resolveCredits('keywordLookup', { tier: 'standard', rows: -5 }), 0);
  });
});
