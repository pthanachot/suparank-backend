/**
 * Phase B2 — pure-logic tests for the DataForSEO/Serper → internal mapping.
 *
 * These transformations decide every number the keyword UI shows. No DB, no
 * network: the vendor clients are exercised through a stubbed global fetch.
 *
 * Run: node --test tests/keywords/unit-mappers.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const vendorMock = require('../aiTracker/helpers/vendorMock');
const fx = require('./helpers/fixtures');
const {
  fetchRelatedKeywords, fetchSerpResults, resolveCountry, SUPPORTED_COUNTRIES,
} = require('../../src/services/keywordService');

before(() => vendorMock.install());
after(() => vendorMock.uninstall());
beforeEach(() => vendorMock.script({}));

describe('mapDataForSEOKeyword (via fetchRelatedKeywords)', () => {
  it('extracts every field the UI renders', async () => {
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(1, 'seo tools'))] });
    const { seed, related } = await fetchRelatedKeywords('seo tools', 'United States', 'en');

    assert.equal(seed.keyword, 'seo tools', 'seed comes from seed_keyword_data');
    const row = related[0];
    assert.equal(row.searchVolume, 1200);
    assert.equal(row.keywordDifficulty, 42);
    assert.equal(row.cpc, 2.4);
    assert.equal(row.searchIntent, 'commercial');
    assert.equal(typeof row.isQuestion, 'boolean');
  });

  it('monthly searches are returned in CHRONOLOGICAL order (fixture supplies them shuffled)', async () => {
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(1))] });
    const { related } = await fetchRelatedKeywords('seo tools', 'United States', 'en');
    assert.deepEqual(related[0].monthlySearches, [900, 1100, 1400], 'Jan, Feb, Mar — sorted, not source order');
  });

  it('SERP features are filtered to the known allowlist', async () => {
    vendorMock.script({
      dataforseo: [vendorMock.jsonReply({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ items: [fx.dfsKeyword('x', { serpFeatures: ['organic', 'people_also_ask', 'totally_made_up_feature'] })] }] }],
      })],
    });
    const { related } = await fetchRelatedKeywords('seed', 'United States', 'en');
    assert.ok(!related[0].serpFeatures.includes('totally_made_up_feature'), 'unknown keys dropped');
    assert.ok(related[0].serpFeatures.length >= 1);
  });

  it('question detection flags interrogative keywords', async () => {
    vendorMock.script({
      dataforseo: [vendorMock.jsonReply({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ items: [fx.dfsKeyword('how to do seo'), fx.dfsKeyword('seo agency')] }] }],
      })],
    });
    const { related } = await fetchRelatedKeywords('seed', 'United States', 'en');
    const byKw = Object.fromEntries(related.map((r) => [r.keyword, r.isQuestion]));
    assert.equal(byKw['how to do seo'], true);
    assert.equal(byKw['seo agency'], false);
  });

  it('sparse rows default rather than emitting undefined/NaN', async () => {
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsSparse)] });
    const { related } = await fetchRelatedKeywords('seed', 'United States', 'en');
    const row = related[0];
    assert.equal(row.searchVolume, 0);
    assert.equal(row.keywordDifficulty, 0);
    assert.equal(row.cpc, 0);
    assert.ok(Array.isArray(row.monthlySearches));
    assert.ok(Array.isArray(row.serpFeatures));
  });

  it('sends Basic auth and the documented payload shape', async () => {
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(1))] });
    await fetchRelatedKeywords('payload check', 'United States', 'en');
    const call = vendorMock.calls.find((c) => c.vendor === 'dataforseo');
    assert.ok(call.url.includes('/dataforseo_labs/google/related_keywords/live'));
    const body = JSON.parse(call.body)[0];
    assert.equal(body.keyword, 'payload check');
    assert.equal(body.include_seed_keyword, true);
    assert.equal(body.language_code, 'en');
  });
});

describe('Serper mapping (via fetchSerpResults)', () => {
  it('maps organic rows and derives a missing domain from the link', async () => {
    vendorMock.script({ serper: [vendorMock.jsonReply(fx.serperOk)] });
    const { organic, peopleAlsoAsk } = await fetchSerpResults('seo tools', 'us', 'en');

    assert.equal(organic.length, 2);
    assert.equal(organic[0].domain, 'example.com');
    assert.equal(organic[1].domain, 'other.com', 'derived from the link when absent');
    assert.equal(peopleAlsoAsk.length, 1);
    assert.equal(peopleAlsoAsk[0].question, 'What is the best SEO tool?');
  });

  it('threads gl/hl so results are localised (the A7 locale work)', async () => {
    vendorMock.script({ serper: [vendorMock.jsonReply(fx.serperOk)] });
    await fetchSerpResults('locale check', 'uk', 'en');
    const call = vendorMock.calls.find((c) => c.vendor === 'serper');
    const body = JSON.parse(call.body);
    assert.equal(body.gl, 'uk');
    assert.equal(body.hl, 'en');
  });
});

describe('country resolution', () => {
  it('every supported country resolves to a usable locale triple', () => {
    const bad = [];
    for (const name of SUPPORTED_COUNTRIES) {
      const c = resolveCountry(name);
      if (!c?.gl || !c?.languageCode || !c?.locationName) bad.push(name);
    }
    assert.deepEqual(bad, [], 'each country needs gl + languageCode + locationName');
  });

  it('an unknown country falls back to the US rather than throwing', () => {
    const c = resolveCountry('Atlantis');
    assert.equal(c.gl, 'us');
  });
});
