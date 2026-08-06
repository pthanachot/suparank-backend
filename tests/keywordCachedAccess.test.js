/**
 * K1 regression — GET /keywords/cached tenant-isolation and metering guard.
 *
 * The KeywordSearch cache is GLOBAL (licensed DataForSEO rows, keyed
 * {seedKeyword, country} with no workspaceId). Pre-fix, getCachedResults
 * served it on keyword+country alone: any authenticated user in ANY
 * workspace could read rows another tenant paid for — free, unmetered,
 * with no freshness filter. The fix requires an own-workspace
 * KeywordResearchHistory entry (the record that this workspace ran and was
 * quota-charged for the search), refuses downgrade-locked entries, and
 * applies the same 14-day freshness window as /search.
 *
 * House style: models monkey-patched, no DB, no network.
 * Run: node --test tests/keywordCachedAccess.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const KeywordSearch = require('../src/models/KeywordSearch');
const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');
const keywordController = require('../src/controllers/keywordController');

const WS_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const WS_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const CACHE_ROW = {
  seedMetrics: { keyword: 'ai quiz generator', searchVolume: 9900 },
  relatedKeywords: [{ keyword: 'free ai quiz generator', searchVolume: 4400 }],
  totalCount: 1,
  fetchedAt: new Date(), // fresh
};

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function makeReq(workspaceId, query) {
  return { workspace: { _id: workspaceId }, query };
}

// Per-test state the monkey-patched statics read.
let historyRows; // array of {workspaceId, seedKeyword, country, locked}
let cacheRow; // the global KeywordSearch row (or null)
let cacheQueries; // captured KeywordSearch.findOne filters
let historyQueries; // captured KeywordResearchHistory.findOne filters

const origSearchFindOne = KeywordSearch.findOne;
const origHistoryFindOne = KeywordResearchHistory.findOne;

beforeEach(() => {
  historyRows = [];
  cacheRow = null;
  cacheQueries = [];
  historyQueries = [];

  KeywordResearchHistory.findOne = async (filter) => {
    historyQueries.push(filter);
    return historyRows.find(
      (r) =>
        String(r.workspaceId) === String(filter.workspaceId) &&
        r.seedKeyword === filter.seedKeyword &&
        r.country === filter.country,
    ) || null;
  };

  KeywordSearch.findOne = async (filter) => {
    cacheQueries.push(filter);
    if (!cacheRow) return null;
    if (filter.seedKeyword !== 'ai quiz generator' || filter.country !== 'US') return null;
    // Honour the freshness filter the way Mongo would.
    const gte = filter.fetchedAt?.$gte;
    if (gte && cacheRow.fetchedAt < gte) return null;
    return cacheRow;
  };
});

// Restore after the suite so other test files sharing the process are unaffected.
process.on('exit', () => {
  KeywordSearch.findOne = origSearchFindOne;
  KeywordResearchHistory.findOne = origHistoryFindOne;
});

describe('getCachedResults — K1 tenant isolation', () => {
  it('400 when kw is missing', async () => {
    const res = makeRes();
    await keywordController.getCachedResults(makeReq(WS_A, {}), res);
    assert.equal(res.statusCode, 400);
  });

  it('404 for a workspace with NO history entry, even though a global cache row exists — and the licensed row is never read', async () => {
    cacheRow = { ...CACHE_ROW };
    // Tenant A searched (has history); tenant B did not.
    historyRows = [{ workspaceId: WS_A, seedKeyword: 'ai quiz generator', country: 'US', locked: false }];

    const res = makeRes();
    await keywordController.getCachedResults(
      makeReq(WS_B, { kw: 'AI Quiz Generator', country: 'US' }),
      res,
    );

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'No cached results found');
    assert.equal(cacheQueries.length, 0, 'KeywordSearch must not be queried without an ownership match');
  });

  it('200 with rows for the workspace that owns the history entry', async () => {
    cacheRow = { ...CACHE_ROW };
    historyRows = [{ workspaceId: WS_A, seedKeyword: 'ai quiz generator', country: 'US', locked: false }];

    const res = makeRes();
    await keywordController.getCachedResults(
      makeReq(WS_A, { kw: 'ai quiz generator', country: 'US' }),
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 1);
    assert.equal(res.body.relatedKeywords[0].keyword, 'free ai quiz generator');
    // Ownership was checked with the workspace-scoped compound key.
    assert.deepEqual(historyQueries[0], {
      workspaceId: WS_A,
      seedKeyword: 'ai quiz generator',
      country: 'US',
    });
  });

  it('403 LOCKED for a downgrade-locked history entry', async () => {
    cacheRow = { ...CACHE_ROW };
    historyRows = [{ workspaceId: WS_A, seedKeyword: 'ai quiz generator', country: 'US', locked: true }];

    const res = makeRes();
    await keywordController.getCachedResults(
      makeReq(WS_A, { kw: 'ai quiz generator', country: 'US' }),
      res,
    );

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'LOCKED');
    assert.equal(cacheQueries.length, 0, 'locked entries must not read the licensed row');
  });

  it('404 when the cache row is older than the 14-day freshness window', async () => {
    cacheRow = { ...CACHE_ROW, fetchedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) };
    historyRows = [{ workspaceId: WS_A, seedKeyword: 'ai quiz generator', country: 'US', locked: false }];

    const res = makeRes();
    await keywordController.getCachedResults(
      makeReq(WS_A, { kw: 'ai quiz generator', country: 'US' }),
      res,
    );

    assert.equal(res.statusCode, 404);
    const gte = cacheQueries[0]?.fetchedAt?.$gte;
    assert.ok(gte instanceof Date, 'cache lookup must carry the freshness filter');
  });

  it('country defaults to US and kw is normalized (trim + lowercase) before the ownership check', async () => {
    historyRows = []; // no ownership anywhere
    const res = makeRes();
    await keywordController.getCachedResults(makeReq(WS_A, { kw: '  AI Quiz Generator  ' }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(historyQueries[0], {
      workspaceId: WS_A,
      seedKeyword: 'ai quiz generator',
      country: 'US',
    });
  });
});
