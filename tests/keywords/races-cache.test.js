/**
 * Phase B5 — keyword concurrency & cache correctness.
 *
 * The keyword caches are GLOBAL (cross-tenant, keyed {keyword,country}) and
 * the vendor is billed per call, so cache-key correctness and in-flight
 * dedup are money-and-privacy concerns, not tidiness.
 *
 * Run: node --test tests/keywords/races-cache.test.js
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
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');
const UsageTracker = require('../../src/models/UsageTracker');
const keywordController = require('../../src/controllers/keywordController');
const { SUPPORTED_COUNTRIES, resolveCountry } = require('../../src/services/keywordService');
const { normalizeCountryCode } = keywordController.__test;

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
  await UsageTracker.deleteMany({});
});

describe('K6 — concurrent identical lookups share ONE vendor call', () => {
  it('three simultaneous searches → one DataForSEO request, all three answered', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    // A slow reply guarantees the three calls overlap.
    vendorMock.script({
      dataforseo: [{ ...vendorMock.jsonReply(fx.dfsOk(4)), delayMs: 300, repeat: true }],
    });
    const before = await ledger.snapshot(world.orgId);

    const runs = await Promise.all([1, 2, 3].map(async () => {
      const res = makeRes();
      await keywordController.searchKeywords(
        await buildReq(world, { body: { keyword: 'shared keyword' } }), res,
      );
      return res;
    }));

    for (const res of runs) {
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.totalCount, 4, 'every caller gets the full result');
    }
    assert.equal(
      vendorMock.calls.filter((c) => c.vendor === 'dataforseo').length, 1,
      'K6: exactly one billed vendor request for three concurrent callers',
    );
    // Each REQUEST is still charged for the rows it received — that is the
    // pricing contract; what dedup removes is duplicate vendor spend.
    await ledger.assertConservation(before, world.orgId, { settled: 12, label: 'K6 (3 × 4 rows)' });
    await ledger.assertNoPendingTx({ organizationId: world.orgId }, 'K6');
  });

  it('different countries are NOT shared (country is part of the key)', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({
      dataforseo: [{ ...vendorMock.jsonReply(fx.dfsOk(2)), delayMs: 200, repeat: true }],
    });

    await Promise.all([
      keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'split kw', country: 'United States' } }), makeRes()),
      keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'split kw', country: 'United Kingdom' } }), makeRes()),
    ]);

    assert.equal(vendorMock.calls.filter((c) => c.vendor === 'dataforseo').length, 2);
    assert.equal(await KeywordSearch.countDocuments({}), 2, 'one cache row per country');
  });
});

describe('K2 — country round-trip: what /search writes, /cached can read', () => {
  it('every supported country survives write → read (the UK/GB bug class)', { timeout: 120_000 }, async () => {
    const world = await seedWorld();
    const mismatches = [];

    for (const displayName of SUPPORTED_COUNTRIES) {
      const writeKey = normalizeCountryCode(resolveCountry(displayName).gl);
      // Every way a client might name the country must resolve identically.
      for (const variant of [displayName, writeKey, writeKey.toLowerCase()]) {
        if (normalizeCountryCode(variant) !== writeKey) {
          mismatches.push(`${displayName}: "${variant}" → ${normalizeCountryCode(variant)} ≠ ${writeKey}`);
        }
      }
    }
    assert.deepEqual(mismatches, [], 'read and write keys must agree for all 53 countries');
  });

  it('end-to-end: a UK search is replayable via /cached using ISO "GB"', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(3))] });

    await keywordController.searchKeywords(
      await buildReq(world, { body: { keyword: 'uk keyword', country: 'United Kingdom' } }), makeRes(),
    );

    // The frontend sends back the stored code; ISO-minded clients send "GB".
    for (const country of ['UK', 'GB', 'United Kingdom']) {
      const res = makeRes();
      await keywordController.getCachedResults(
        await buildReq(world, { query: { kw: 'uk keyword', country } }), res,
      );
      assert.equal(res.statusCode, 200, `replay failed for "${country}"`);
      assert.equal(res.body.totalCount, 3);
    }
  });
});

describe('cache correctness', () => {
  it('concurrent upserts on the unique {seedKeyword,country} key never surface E11000', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({
      dataforseo: [{ ...vendorMock.jsonReply(fx.dfsOk(2)), repeat: true }],
    });

    // Distinct keywords in parallel → parallel upserts on the same collection.
    const results = await Promise.all(['a kw', 'b kw', 'c kw'].map(async (kw) => {
      const res = makeRes();
      await keywordController.searchKeywords(await buildReq(world, { body: { keyword: kw } }), res);
      return res;
    }));
    for (const res of results) assert.equal(res.statusCode, 200);
    assert.equal(await KeywordSearch.countDocuments({}), 3);
  });

  it('a stale cache row (older than the TTL) is ignored and refetched', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [{ ...vendorMock.jsonReply(fx.dfsOk(5)), repeat: true }] });

    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'stale kw' } }), makeRes());
    const firstCalls = vendorMock.calls.length;

    // Age the row past the 14-day window.
    await KeywordSearch.updateOne({}, { $set: { fetchedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) } });

    const res = makeRes();
    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'stale kw' } }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(vendorMock.calls.length > firstCalls, 'stale row must trigger a refetch');
  });

  it('/cached refuses a stale row rather than serving 2-week-old data', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(3))] });
    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'old kw' } }), makeRes());

    await KeywordSearch.updateOne({}, { $set: { fetchedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) } });

    const res = makeRes();
    await keywordController.getCachedResults(await buildReq(world, { query: { kw: 'old kw' } }), res);
    assert.equal(res.statusCode, 404, 'K1 fix also applies the freshness window');
  });
});

describe('downgrade-lock semantics', () => {
  it('re-searching a locked history entry unlocks it (intended), quota still applies', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [{ ...vendorMock.jsonReply(fx.dfsOk(3)), repeat: true }] });

    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'lockable kw' } }), makeRes());
    await KeywordResearchHistory.updateOne({}, { $set: { locked: true } });

    // Locked entries must not be replayable for free…
    const cachedRes = makeRes();
    await keywordController.getCachedResults(await buildReq(world, { query: { kw: 'lockable kw' } }), cachedRes);
    assert.equal(cachedRes.statusCode, 403, 'locked history is not replayable (K1)');

    // …but a fresh, quota-consuming search unlocks it (commit c6c105a).
    await keywordController.searchKeywords(await buildReq(world, { body: { keyword: 'lockable kw' } }), makeRes());
    const hist = await KeywordResearchHistory.findOne({}).lean();
    assert.equal(hist.locked, false, 'the sanctioned unlock path');
    const usage = await UsageTracker.findOne({ organizationId: world.orgId }).lean();
    assert.equal(usage.keywordSearches, 2, 'unlocking costs a lookup — not free');
  });
});
