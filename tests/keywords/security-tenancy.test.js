/**
 * Phase C3 — keyword cross-tenant probes, driven over REAL HTTP.
 *
 * Two fully-seeded tenants. Every probe issues tenant B's credentials against
 * tenant A's resources through the actual Express chain, then asserts: a
 * refusal (404 — never 403, which would confirm existence), ZERO leaked
 * A-data in the body, and A's documents untouched.
 *
 * The headline case is the K1 REGRESSION. The KeywordSearch cache is global
 * by design — rows are licensed from DataForSEO once and replayed across
 * tenants so nobody pays twice. Before the fix, GET /keywords/cached served
 * those rows on keyword+country alone, so any workspace could read data
 * another tenant paid for, unmetered and unlogged. The fix requires an
 * own-workspace history entry. Probe names here must match TENANCY_COVERAGE
 * in helpers/securityCoverage.js — security-rbac.test.js cross-checks.
 *
 * Run: node --test tests/keywords/security-tenancy.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const db = require('../aiTracker/helpers/db');
const vendorMock = require('../aiTracker/helpers/vendorMock');
const { seedTierConfigs } = require('./helpers/world');
const { seedHttpTenant, seedGrid, startServer, request } = require('./helpers/httpWorld');

const KeywordSearch = require('../../src/models/KeywordSearch');
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');

const SECRET_KEYWORD = 'tenant-a-confidential-seed';
const SECRET_ROW = 'tenant-a-licensed-row';

let server;
let A;
let B;

/** Assert a response carries no fingerprint of tenant A's paid data. */
function assertNoLeak(res, label) {
  const body = JSON.stringify(res.body ?? {});
  for (const fp of [SECRET_ROW, 'tenant-a']) {
    assert.ok(!body.includes(fp), `${label}: tenant-A data leaked — "${fp}" in ${body.slice(0, 300)}`);
  }
}

before(async () => {
  await db.connect();
  await db.clear();
  await seedTierConfigs();
  await seedGrid();
  vendorMock.install();
  server = await startServer();
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  if (server) await new Promise((r) => server.close(r));
  await db.disconnect();
});

beforeEach(async () => {
  vendorMock.script({});
  await KeywordSearch.deleteMany({});
  await KeywordResearchHistory.deleteMany({});

  A = await seedHttpTenant('A');
  B = await seedHttpTenant('B');

  // Tenant A ran (and paid for) this search: a global cache row + A's history.
  await KeywordSearch.create({
    seedKeyword: SECRET_KEYWORD,
    country: 'US',
    seedMetrics: { keyword: SECRET_KEYWORD, searchVolume: 5000 },
    relatedKeywords: [{ keyword: SECRET_ROW, searchVolume: 900, keywordDifficulty: 10, cpc: 1.5 }],
    totalCount: 1,
    fetchedAt: new Date(),
  });
  await KeywordResearchHistory.create({
    workspaceId: A.ws._id,
    seedKeyword: SECRET_KEYWORD,
    country: 'US',
    searchedAt: new Date(),
    createdOnPlan: 'paid',
  });
});

describe('K1 regression: foreign-workspace cached rows are not replayable', () => {
  const url = (ws, kw) => `/api/workspace/${ws.workspaceNumber}/keywords/cached?kw=${encodeURIComponent(kw)}&country=US`;

  it('tenant A CAN replay its own paid search (the control)', { timeout: 60_000 }, async () => {
    const res = await request(server, 'GET', url(A.ws, SECRET_KEYWORD), { token: A.token });
    assert.equal(res.status, 200, `A should replay its own search, got ${res.status} ${res.raw}`);
    assert.equal(res.body.relatedKeywords[0].keyword, SECRET_ROW);
  });

  it('tenant B CANNOT replay it — 404, no leak, over real HTTP', { timeout: 60_000 }, async () => {
    const res = await request(server, 'GET', url(B.ws, SECRET_KEYWORD), { token: B.token });
    assert.equal(res.status, 404, `expected 404, got ${res.status} ${res.raw}`);
    assertNoLeak(res, 'K1 cross-tenant replay');
  });

  it('the refusal is 404, not 403 — it must not confirm the row exists', { timeout: 60_000 }, async () => {
    const real = await request(server, 'GET', url(B.ws, SECRET_KEYWORD), { token: B.token });
    const fake = await request(server, 'GET', url(B.ws, 'a-keyword-nobody-ever-searched'), { token: B.token });
    assert.equal(real.status, fake.status, 'existing and non-existing keywords must be indistinguishable');
    assert.deepEqual(real.body, fake.body, 'response bodies must be identical for both');
  });

  it('B cannot reach A by passing A\'s workspaceNumber (the workspace gate holds)', { timeout: 60_000 }, async () => {
    const res = await request(server, 'GET', url(A.ws, SECRET_KEYWORD), { token: B.token });
    assert.ok(res.status === 403 || res.status === 404, `expected refusal, got ${res.status} ${res.raw}`);
    assertNoLeak(res, 'K1 foreign workspaceNumber');
  });

  it('a LOCKED history entry is refused with 403 LOCKED even for the owner', { timeout: 60_000 }, async () => {
    await KeywordResearchHistory.updateOne({ workspaceId: A.ws._id }, { $set: { locked: true } });
    const res = await request(server, 'GET', url(A.ws, SECRET_KEYWORD), { token: A.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'LOCKED');
  });

  it('an unauthenticated request never reaches the cache at all', { timeout: 60_000 }, async () => {
    const res = await request(server, 'GET', url(A.ws, SECRET_KEYWORD), {});
    assert.equal(res.status, 401);
    assertNoLeak(res, 'K1 unauthenticated');
  });
});

describe('getSearchHistory: B sees only its own history', () => {
  it('B\'s history is empty while A has an entry', { timeout: 60_000 }, async () => {
    const res = await request(server, 'GET', `/api/workspace/${B.ws.workspaceNumber}/keywords/history`, { token: B.token });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.body.searches, [], 'B must not inherit A\'s history');
    assertNoLeak(res, 'history listing');
  });

  it('A sees exactly its own entry', { timeout: 60_000 }, async () => {
    const res = await request(server, 'GET', `/api/workspace/${A.ws.workspaceNumber}/keywords/history`, { token: A.token });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.searches.length, 1);
    assert.equal(res.body.searches[0].seedKeyword, SECRET_KEYWORD);
  });
});

describe('deleteSearchHistory: foreign historyId survives', () => {
  it('B deleting A\'s history entry is refused and A\'s row remains', { timeout: 60_000 }, async () => {
    const entry = await KeywordResearchHistory.findOne({ workspaceId: A.ws._id });
    const res = await request(
      server, 'DELETE',
      `/api/workspace/${B.ws.workspaceNumber}/keywords/history/${entry._id}`,
      { token: B.token },
    );
    assert.equal(res.status, 404, `expected 404, got ${res.status} ${res.raw}`);
    const still = await KeywordResearchHistory.findById(entry._id);
    assert.ok(still, 'tenant A\'s history entry was deleted by tenant B');
  });

  it('a malformed historyId is rejected as 400, not surfaced as a 500', { timeout: 60_000 }, async () => {
    const res = await request(
      server, 'DELETE',
      `/api/workspace/${B.ws.workspaceNumber}/keywords/history/not-an-objectid`,
      { token: B.token },
    );
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.raw}`);
  });
});
