/**
 * Phase C3 — keyword input abuse + RBAC enforced over REAL HTTP.
 *
 * security-rbac.test.js proves the POLICY TABLE says the right thing and the
 * ROUTE declares the right gate. It cannot prove the gate actually refuses a
 * request — that needs the middleware chain. This drives both.
 *
 * Also covers the hostile-input surface: oversized keywords, prototype keys,
 * unknown countries, and type-confused query params. None may 500, none may
 * reach a vendor, none may pollute the shared cache.
 *
 * Run: node --test tests/keywords/security-inputs.test.js
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
const fx = require('./helpers/fixtures');

const KeywordSearch = require('../../src/models/KeywordSearch');
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');

let server;

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
});

describe('RBAC enforced at the HTTP layer (not just declared)', () => {
  it('a VIEWER cannot spend credits on /search — refused before any vendor call', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('V', { role: 'viewer' });
    const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
      token: t.token,
      body: { keyword: 'viewer should not spend', country: 'United States' },
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${res.raw}`);
    assert.equal(vendorMock.calls.length, 0, 'a refused request still reached a vendor');
  });

  it('an EDITOR cannot delete licensed history (Table 3: Admin+ only)', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('E', { role: 'editor' });
    const entry = await KeywordResearchHistory.create({
      workspaceId: t.ws._id, seedKeyword: 'editor delete probe', country: 'US', searchedAt: new Date(),
    });
    const res = await request(
      server, 'DELETE',
      `/api/workspace/${t.ws.workspaceNumber}/keywords/history/${entry._id}`,
      { token: t.token },
    );
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${res.raw}`);
    assert.ok(await KeywordResearchHistory.findById(entry._id), 'the Editor deleted licensed history');
  });

  it('an ADMIN CAN delete history (the positive control — the gate is not just "deny all")', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('AD', { role: 'admin' });
    const entry = await KeywordResearchHistory.create({
      workspaceId: t.ws._id, seedKeyword: 'admin delete probe', country: 'US', searchedAt: new Date(),
    });
    const res = await request(
      server, 'DELETE',
      `/api/workspace/${t.ws.workspaceNumber}/keywords/history/${entry._id}`,
      { token: t.token },
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.raw}`);
    assert.equal(await KeywordResearchHistory.findById(entry._id), null, 'the Admin\'s delete did not take effect');
  });

  it('a VIEWER can still READ history and countries', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('V2', { role: 'viewer' });
    const hist = await request(server, 'GET', `/api/workspace/${t.ws.workspaceNumber}/keywords/history`, { token: t.token });
    assert.equal(hist.status, 200, `history: ${hist.raw}`);
    const countries = await request(server, 'GET', `/api/workspace/${t.ws.workspaceNumber}/keywords/countries`, { token: t.token });
    assert.equal(countries.status, 200, `countries: ${countries.raw}`);
    assert.ok(Array.isArray(countries.body.countries));
  });

  it('an unauthenticated caller is refused on every keyword route', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('U');
    const n = t.ws.workspaceNumber;
    const probes = [
      ['POST', `/api/workspace/${n}/keywords/search`],
      ['GET', `/api/workspace/${n}/keywords/detail?keyword=x&country=United%20States`],
      ['GET', `/api/workspace/${n}/keywords/history`],
      ['DELETE', `/api/workspace/${n}/keywords/history/507f1f77bcf86cd799439011`],
      ['GET', `/api/workspace/${n}/keywords/cached?kw=x&country=US`],
      ['GET', `/api/workspace/${n}/keywords/countries`],
    ];
    for (const [method, path] of probes) {
      const res = await request(server, method, path, {});
      assert.equal(res.status, 401, `${method} ${path}: expected 401, got ${res.status}`);
    }
    assert.equal(vendorMock.calls.length, 0, 'an unauthenticated request reached a vendor');
  });
});

describe('hostile input — no 500s, no vendor calls, no cache pollution', () => {
  it('an absurdly long keyword is rejected, not forwarded to DataForSEO', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('L');
    const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
      token: t.token,
      body: { keyword: 'a'.repeat(5000), country: 'United States' },
    });
    assert.ok(res.status === 400 || res.status === 422, `expected a 4xx, got ${res.status} ${res.raw}`);
    assert.equal(vendorMock.calls.length, 0, 'an over-long keyword was forwarded to the vendor');
    assert.equal(await KeywordSearch.countDocuments({}), 0, 'the shared cache was polluted');
  });

  it('an empty/whitespace keyword is a 400, never a vendor call', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('W');
    for (const keyword of ['', '   ', '\t\n']) {
      const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
        token: t.token, body: { keyword, country: 'United States' },
      });
      assert.equal(res.status, 400, `keyword ${JSON.stringify(keyword)}: got ${res.status} ${res.raw}`);
    }
    assert.equal(vendorMock.calls.length, 0);
  });

  it('a prototype-polluting key in the body does not corrupt Object.prototype', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('P');
    // This request is otherwise VALID, so it legitimately reaches the vendor.
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(2))] });
    const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
      token: t.token,
      body: JSON.parse('{"keyword":"proto probe","country":"United States","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}'),
    });
    assert.ok(res.status < 500, `prototype key caused a ${res.status}`);
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
    assert.equal({}.polluted2, undefined, 'Object.prototype was polluted via constructor');
  });

  it('a type-confused country (array/object/number) falls back rather than throwing', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('T');
    // Each probe uses a distinct keyword, so each is a fresh vendor call.
    vendorMock.script({ dataforseo: Array.from({ length: 4 }, () => vendorMock.jsonReply(fx.dfsOk(1))) });
    for (const country of [['United States'], { name: 'x' }, 42, null]) {
      const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
        token: t.token, body: { keyword: `type probe ${JSON.stringify(country)}`, country },
      });
      assert.ok(res.status < 500, `country ${JSON.stringify(country)} caused a ${res.status}: ${res.raw}`);
    }
  });

  it('a DataForSEO-unsupported country is refused BEFORE the vendor call', { timeout: 90_000 }, async () => {
    // Filtering China out of GET /keywords/countries was not enough: the UI
    // ships its own hardcoded list and any direct caller can send anything.
    // The request path itself must refuse it, or we spend a round trip to be
    // told "location not found" and surface an opaque 500.
    const t = await seedHttpTenant('CN');
    const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
      token: t.token, body: { keyword: 'china probe', country: 'China' },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.raw}`);
    assert.equal(res.body.code, 'COUNTRY_UNSUPPORTED');
    assert.equal(vendorMock.calls.length, 0, 'an unsupported country still reached DataForSEO');
  });

  it('an unknown country resolves to the US fallback instead of erroring', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('X');
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(2))] });
    const res = await request(server, 'POST', `/api/workspace/${t.ws.workspaceNumber}/keywords/search`, {
      token: t.token, body: { keyword: 'atlantis probe', country: 'Atlantis' },
    });
    assert.ok(res.status < 500, `unknown country caused a ${res.status}: ${res.raw}`);
  });

  it('a malformed historyId never reaches Mongo as a raw cast', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('M');
    for (const bad of ['not-an-id', '../../etc/passwd', '%00', '{"$ne":null}']) {
      const res = await request(
        server, 'DELETE',
        `/api/workspace/${t.ws.workspaceNumber}/keywords/history/${encodeURIComponent(bad)}`,
        { token: t.token },
      );
      assert.ok(res.status === 400 || res.status === 404, `historyId ${bad}: got ${res.status} ${res.raw}`);
      assert.ok(res.status !== 500, `historyId ${bad} produced a 500`);
    }
  });

  it('a NoSQL operator in the cached-lookup query is treated as a literal', { timeout: 90_000 }, async () => {
    const t = await seedHttpTenant('N');
    await KeywordSearch.create({
      seedKeyword: 'nosql probe', country: 'US',
      seedMetrics: { keyword: 'nosql probe', searchVolume: 10 },
      relatedKeywords: [{ keyword: 'nosql row', searchVolume: 1, keywordDifficulty: 1, cpc: 0 }],
      totalCount: 1, fetchedAt: new Date(),
    });
    const res = await request(
      server, 'GET',
      `/api/workspace/${t.ws.workspaceNumber}/keywords/cached?kw[$ne]=null&country=US`,
      { token: t.token },
    );
    assert.ok(res.status === 400 || res.status === 404, `operator injection returned ${res.status} ${res.raw}`);
    assert.ok(!JSON.stringify(res.body ?? {}).includes('nosql row'), 'operator injection returned cached rows');
  });
});
