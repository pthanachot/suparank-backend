/**
 * Phase A — regression pins for the keyword fixes K2/K3/K5/K6.
 *
 * Models and vendor clients monkey-patched; no DB, no network (house style).
 * Run: node --test tests/keywordPhaseAFixes.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const KeywordSearch = require('../src/models/KeywordSearch');
const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');

// The controller DESTRUCTURES its service imports at module load, so patching
// keywordService afterwards would never be seen. Swap the module in
// require.cache BEFORE the controller loads, keeping the real resolveCountry
// (K2 depends on its country table) and making the vendor calls swappable.
const svcPath = require.resolve(path.join(__dirname, '../src/services/keywordService.js'));
const realService = require(svcPath);
const vendor = {
  fetchRelatedKeywords: async () => ({ seed: null, related: [] }),
  fetchSerpResults: async () => ({ organic: [], peopleAlsoAsk: [] }),
};
require.cache[svcPath] = {
  id: svcPath,
  filename: svcPath,
  loaded: true,
  exports: {
    ...realService,
    fetchRelatedKeywords: (...a) => vendor.fetchRelatedKeywords(...a),
    fetchSerpResults: (...a) => vendor.fetchSerpResults(...a),
  },
};

const keywordController = require('../src/controllers/keywordController');

const { normalizeCountryCode, singleFlightSearch } = keywordController.__test;

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const baseReq = (over = {}) => ({
  workspace: { _id: 'ws1', organizationId: null },
  body: {},
  query: {},
  params: {},
  ...over,
});

describe('K2 — one canonical country representation', () => {
  it('gl values, ISO aliases and display names all collapse to the same code', () => {
    assert.equal(normalizeCountryCode('uk'), 'UK');
    assert.equal(normalizeCountryCode('GB'), 'UK', 'ISO GB must map onto the stored gl value');
    assert.equal(normalizeCountryCode('United Kingdom'), 'UK', 'display name resolves too');
    assert.equal(normalizeCountryCode('us'), 'US');
    assert.equal(normalizeCountryCode('United States'), 'US');
    assert.equal(normalizeCountryCode(''), 'US', 'empty defaults to US');
    assert.equal(normalizeCountryCode(undefined), 'US');
  });

  it('the /cached read key matches what /search would have written for the UK', async () => {
    const seen = [];
    const origFind = KeywordSearch.findOne;
    const origHist = KeywordResearchHistory.findOne;
    KeywordResearchHistory.findOne = async () => ({ locked: false });
    KeywordSearch.findOne = async (filter) => {
      seen.push(filter.country);
      return { seedMetrics: {}, relatedKeywords: [], totalCount: 0 };
    };
    try {
      // A client that says "GB" (ISO) must hit the row /search stored as "UK".
      await keywordController.getCachedResults(
        baseReq({ query: { kw: 'seo tools', country: 'GB' } }),
        makeRes(),
      );
      assert.equal(seen[0], 'UK');
    } finally {
      KeywordSearch.findOne = origFind;
      KeywordResearchHistory.findOne = origHist;
    }
  });
});

describe('K3 — empty vendor results are never cached', () => {
  let upserts;
  let origFindOne;
  let origUpdate;
  let origHistUpdate;

  beforeEach(() => {
    upserts = [];
    origFindOne = KeywordSearch.findOne;
    origUpdate = KeywordSearch.findOneAndUpdate;
    origHistUpdate = KeywordResearchHistory.findOneAndUpdate;
    KeywordSearch.findOne = async () => null; // always a cache miss
    KeywordSearch.findOneAndUpdate = async (filter, doc) => { upserts.push({ filter, doc }); return doc; };
    KeywordResearchHistory.findOneAndUpdate = () => ({ catch: () => {} });
  });

  afterEach(() => {
    KeywordSearch.findOne = origFindOne;
    KeywordSearch.findOneAndUpdate = origUpdate;
    KeywordResearchHistory.findOneAndUpdate = origHistUpdate;
  });

  it('zero rows → cached only briefly (a bad vendor response cannot poison 14 days)', async () => {
    vendor.fetchRelatedKeywords = async () => ({ seed: null, related: [] });
    const res = makeRes();
    await keywordController.searchKeywords(baseReq({ body: { keyword: 'ghost keyword' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 0);
    assert.equal(upserts.length, 1, 'still written — otherwise every lookup re-bills the vendor');
    // Back-dated so it expires within the hour instead of lasting 14 days.
    const age = Date.now() - upserts[0].doc.fetchedAt.getTime();
    const { CACHE_TTL_MS } = keywordController.__test;
    assert.ok(age > CACHE_TTL_MS - 61 * 60 * 1000, 'empty row must be back-dated (short negative TTL)');
    assert.ok(age < CACHE_TTL_MS, 'but not already expired');
  });

  it('non-empty rows still cache normally', async () => {
    vendor.fetchRelatedKeywords = async () => ({ seed: { keyword: 'x' }, related: [{ keyword: 'a' }] });
    const res = makeRes();
    await keywordController.searchKeywords(baseReq({ body: { keyword: 'real keyword' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].doc.totalCount, 1);
  });
});

describe('K5 — vendor error text never reaches the client', () => {
  it('a DataForSEO error body is logged, not returned', async () => {
    const origFindOne = KeywordSearch.findOne;
    KeywordSearch.findOne = async () => null;
    vendor.fetchRelatedKeywords = async () => {
      throw new Error('DataForSEO returned status 402: {"account":"acme-corp","balance":"-12.44","endpoint":"/v3/..."}');
    };
    const res = makeRes();
    try {
      await keywordController.searchKeywords(baseReq({ body: { keyword: 'boom' } }), res);
    } finally {
      KeywordSearch.findOne = origFindOne;
    }
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Failed to search keywords');
    const serialized = JSON.stringify(res.body);
    for (const leak of ['DataForSEO', 'acme-corp', 'balance', '/v3/']) {
      assert.ok(!serialized.includes(leak), `response leaked vendor detail: ${leak}`);
    }
  });
});

describe('K6 — single-flight dedup for identical in-flight lookups', () => {
  it('concurrent identical keys share ONE underlying call', async () => {
    let calls = 0;
    const work = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { rows: 1 }; };
    const [a, b, c] = await Promise.all([
      singleFlightSearch('seo tools|US', work),
      singleFlightSearch('seo tools|US', work),
      singleFlightSearch('seo tools|US', work),
    ]);
    assert.equal(calls, 1, 'three concurrent callers, one vendor call');
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it('different keys do NOT share (country is part of the key)', async () => {
    let calls = 0;
    const work = async () => { calls++; return { rows: 1 }; };
    await Promise.all([
      singleFlightSearch('seo tools|US', work),
      singleFlightSearch('seo tools|UK', work),
    ]);
    assert.equal(calls, 2);
  });

  it('the entry is released after settle, so a later search re-fetches', async () => {
    let calls = 0;
    const work = async () => { calls++; return { rows: 1 }; };
    await singleFlightSearch('k|US', work);
    await singleFlightSearch('k|US', work);
    assert.equal(calls, 2, 'sequential calls must not be served by a stale promise');
  });

  it('a rejected flight is released (no poisoned key) and propagates to all waiters', async () => {
    let calls = 0;
    const boom = async () => { calls++; throw new Error('vendor down'); };
    const results = await Promise.allSettled([
      singleFlightSearch('bad|US', boom),
      singleFlightSearch('bad|US', boom),
    ]);
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r.status === 'rejected'));
    await singleFlightSearch('bad|US', async () => { calls++; return {}; });
    assert.equal(calls, 2, 'key released after rejection');
  });
});
