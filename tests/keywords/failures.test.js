/**
 * Phase B4 — keyword failure matrix.
 *
 * Every vendor/DB failure mode must end the same way: a clean 500 (or a
 * degraded-but-honest 200), NO charge, NO quota consumed, NO poisoned cache,
 * and NO vendor detail leaked to the client (K5).
 *
 * Run: node --test tests/keywords/failures.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

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
const keywordController = require('../../src/controllers/keywordController');

/** Assert the universal "failed cleanly" contract. */
async function assertCleanFailure(world, before, res, label) {
  assert.equal(res.statusCode, 500, `${label}: expected 500`);
  assert.equal(res.body.error, 'Failed to search keywords', `${label}: generic message only`);
  const serialized = JSON.stringify(res.body);
  for (const leak of ['DataForSEO', 'dataforseo', 'balance', 'account', '/v3/', 'Task error']) {
    assert.ok(!serialized.includes(leak), `${label}: leaked vendor detail "${leak}"`);
  }
  await ledger.assertConservation(before, world.orgId, { settled: 0, label });
  await ledger.assertNoPendingTx({ organizationId: world.orgId }, label);
  assert.equal(await UsageTracker.countDocuments({ organizationId: world.orgId }), 0, `${label}: quota consumed`);
  assert.equal(await KeywordSearch.countDocuments({}), 0, `${label}: cache written`);
}

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
  await KeywordDetail.deleteMany({});
  await KeywordResearchHistory.deleteMany({});
  await UsageTracker.deleteMany({});
});

describe('DataForSEO failure modes', () => {
  const cases = [
    ['HTTP 500', { status: 500, text: 'upstream exploded' }],
    ['HTTP 402 with account detail', { status: 402, json: { status_message: 'balance exhausted for account acme' } }],
    ['top-level status_code != 20000', vendorMock.jsonReply(fx.dfsApiError)],
    ['task-level error', vendorMock.jsonReply(fx.dfsTaskError)],
    ['network error', { error: new Error('ECONNRESET') }],
    ['malformed body', { status: 200, text: '<html>gateway timeout</html>' }],
  ];

  for (const [label, step] of cases) {
    it(`${label} → clean 500, no charge, no quota, no cache, no leak`, { timeout: 60_000 }, async () => {
      const world = await seedWorld();
      vendorMock.script({ dataforseo: [step] });
      const before = await ledger.snapshot(world.orgId);

      const res = makeRes();
      await keywordController.searchKeywords(
        await buildReq(world, { body: { keyword: `fail ${label}` } }), res,
      );

      await assertCleanFailure(world, before, res, label);
    });
  }

  it('empty-but-valid result: 200 with zero rows, zero charge, quota consumed, SHORT negative TTL (K3)', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsEmpty)] });
    const before = await ledger.snapshot(world.orgId);

    const res = makeRes();
    await keywordController.searchKeywords(
      await buildReq(world, { body: { keyword: 'genuinely empty' } }), res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 0);
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'empty (0 rows → 0 credits)' });
    const cached = await KeywordSearch.findOne({}).lean();
    assert.ok(cached, 'written, so a hot empty keyword does not re-bill the vendor every time');
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    assert.ok(ageMs > 13 * 24 * 60 * 60 * 1000, 'back-dated → expires within the hour, not in 14 days');
  });

  it('a response with no tasks degrades to zero rows rather than throwing', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsNoTasks)] });
    const res = makeRes();
    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'no tasks' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 0);
  });

  it('rows missing optional metric objects still map (no crash on sparse data)', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsSparse)] });
    const res = makeRes();
    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'sparse seed' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 1);
    const row = res.body.relatedKeywords[0];
    assert.equal(row.keyword, 'bare keyword');
    assert.equal(row.searchVolume, 0, 'missing volume defaults, never NaN/undefined');
    assert.ok(Array.isArray(row.monthlySearches));
  });
});

describe('Serper failure modes (/detail)', () => {
  it('Serper 500 → clean 500, no detail cached, quota untouched', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ serper: [{ status: 500, text: 'serper down' }] });

    const res = makeRes();
    await keywordController.getKeywordDetail(
      await buildReq(world, { query: { kw: 'serper fail', country: 'United States' } }), res,
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Failed to get keyword detail', 'generic message (K5)');
    assert.ok(!JSON.stringify(res.body).includes('serper'), 'no vendor text leaked');
    assert.equal(await KeywordDetail.countDocuments({}), 0);
    assert.equal(await UsageTracker.countDocuments({ organizationId: world.orgId }), 0);
  });

  it('missing peopleAlsoAsk degrades to an empty PAA list', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ serper: [vendorMock.jsonReply(fx.serperNoPaa)] });
    const res = makeRes();
    await keywordController.getKeywordDetail(
      await buildReq(world, { query: { kw: 'no paa', country: 'United States' } }), res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.paaQuestions, []);
    assert.equal(res.body.serpResults.length, 2);
  });
});

describe('DB failure modes', () => {
  it('a failed history write does not fail the request (fire-and-forget by design)', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(3))] });

    const orig = KeywordResearchHistory.findOneAndUpdate;
    KeywordResearchHistory.findOneAndUpdate = () => ({
      catch: (cb) => { cb(new Error('injected history outage')); },
    });
    const res = makeRes();
    try {
      await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'history fails' } }), res);
    } finally {
      KeywordResearchHistory.findOneAndUpdate = orig;
    }

    assert.equal(res.statusCode, 200, 'the user still gets their rows');
    assert.equal(res.body.totalCount, 3);
  });

  it('a cache-write failure surfaces as a clean 500 without charging', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(3))] });
    const before = await ledger.snapshot(world.orgId);

    const orig = KeywordSearch.findOneAndUpdate;
    KeywordSearch.findOneAndUpdate = async () => { throw new Error('injected cache-write outage'); };
    const res = makeRes();
    try {
      await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'cache write fails' } }), res);
    } finally {
      KeywordSearch.findOneAndUpdate = orig;
    }

    assert.equal(res.statusCode, 500);
    // The charge happens AFTER the cache write, so a failure here must not bill.
    await ledger.assertConservation(before, world.orgId, { settled: 0, label: 'cache-write failure' });
  });
});

describe('input validation', () => {
  it('missing / blank keyword → 400 before any vendor call', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    for (const body of [{}, { keyword: '' }, { keyword: '   ' }, { keyword: 42 }]) {
      const res = makeRes();
      await keywordController.searchKeywords(await buildReq(world, { body }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal(vendorMock.calls.length, 0, 'no vendor spend on invalid input');
  });

  it('/cached requires kw', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    const res = makeRes();
    await keywordController.getCachedResults(await buildReq(world, { query: {} }), res);
    assert.equal(res.statusCode, 400);
  });
});
