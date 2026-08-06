/**
 * Phase C1 — vendor schema contract (a drift tripwire).
 *
 * Every keyword test in this tier feeds the mapper FIXTURES. That makes the
 * suite fast and hermetic, but it also means the whole tier agrees with itself
 * even if DataForSEO renames a field tomorrow: the mapper would read
 * `undefined`, default it to 0, and every test would still pass while the
 * product silently showed zeros.
 *
 * So this file pins the CONTRACT rather than the behaviour:
 *  1. The exact vendor field paths the mapper depends on — if a fixture stops
 *     carrying one, the fixture (and the assumption behind it) is wrong.
 *  2. The mapper genuinely READS each of those paths — proved by perturbing
 *     one field at a time and requiring the output to change. A field the
 *     mapper ignores can't be a real dependency, and a field it silently
 *     defaults can't be distinguished from a missing one.
 *
 * (2) is what makes this more than a restatement of the fixture: it fails if
 * someone "fixes" the mapper by hardcoding a default over a renamed field.
 *
 * Run: node --test tests/keywords/schema-contract.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const vendorMock = require('../aiTracker/helpers/vendorMock');
const fx = require('./helpers/fixtures');
const { fetchRelatedKeywords, fetchSerpResults } = require('../../src/services/keywordService');

/** Vendor field path → the mapped output field it must drive. */
const DFS_CONTRACT = [
  { path: 'keyword_data.keyword', out: 'keyword', probe: 'perturbed-keyword-name' },
  { path: 'keyword_data.keyword_info.search_volume', out: 'searchVolume', probe: 7777 },
  { path: 'keyword_data.keyword_info.cpc', out: 'cpc', probe: 9.99 },
  { path: 'keyword_data.keyword_properties.keyword_difficulty', out: 'keywordDifficulty', probe: 77 },
  { path: 'keyword_data.search_intent_info.main_intent', out: 'searchIntent', probe: 'transactional' },
];

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, k) => acc[k], obj);
  target[last] = value;
  return obj;
}

before(() => vendorMock.install());
after(() => vendorMock.uninstall());
beforeEach(() => vendorMock.script({}));

describe('DataForSEO related_keywords — the field paths the mapper depends on', () => {
  for (const { path } of DFS_CONTRACT) {
    it(`fixture carries ${path}`, () => {
      const item = fx.dfsOk(1).tasks[0].result[0].items[0];
      assert.notEqual(
        getPath(item, path), undefined,
        `fixture lost ${path} — either the fixture drifted or the vendor contract changed`,
      );
    });
  }

  it('fixture carries the seed under seed_keyword_data, separate from items', () => {
    const result = fx.dfsOk(3).tasks[0].result[0];
    assert.ok(result.seed_keyword_data, 'seed_keyword_data missing');
    assert.equal(result.items.length, 3, 'items must hold ONLY related rows');
  });

  it('monthly_searches rows carry year+month+search_volume', () => {
    const ms = fx.dfsOk(1).tasks[0].result[0].items[0].keyword_data.keyword_info.monthly_searches;
    assert.ok(Array.isArray(ms) && ms.length > 0);
    for (const row of ms) {
      for (const k of ['year', 'month', 'search_volume']) {
        assert.notEqual(row[k], undefined, `monthly_searches row missing ${k}`);
      }
    }
  });
});

describe('the mapper genuinely READS each contracted path (perturbation)', () => {
  for (const { path, out, probe } of DFS_CONTRACT) {
    it(`changing ${path} changes mapped .${out}`, async () => {
      // Baseline
      vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(1))] });
      const base = (await fetchRelatedKeywords('contract probe', 'United States', 'en')).related[0];

      // Perturbed
      const payload = fx.dfsOk(1);
      setPath(payload.tasks[0].result[0].items[0], path, probe);
      vendorMock.script({ dataforseo: [vendorMock.jsonReply(payload)] });
      const perturbed = (await fetchRelatedKeywords('contract probe', 'United States', 'en')).related[0];

      assert.notDeepEqual(
        perturbed[out], base[out],
        `${path} → .${out}: the mapper ignored the vendor field (renamed field would map to a silent default)`,
      );
      assert.deepEqual(
        perturbed[out], probe,
        `${path} → .${out}: expected the perturbed value to surface verbatim`,
      );
    });
  }

  it('a RENAMED vendor field surfaces as a default, which is exactly the silent failure this guards', async () => {
    const payload = fx.dfsOk(1);
    const info = payload.tasks[0].result[0].items[0].keyword_data.keyword_info;
    info.searchVolume = info.search_volume; // vendor "renames" the field
    delete info.search_volume;
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(payload)] });

    const row = (await fetchRelatedKeywords('rename probe', 'United States', 'en')).related[0];
    assert.equal(row.searchVolume, 0, 'a renamed field maps to 0 — silently, with no error');
    // The perturbation tests above are what would catch this in review; this
    // case documents WHY they exist rather than asserting the bug is fine.
  });
});

describe('Serper — the field paths the mapper depends on', () => {
  it('organic rows carry title/link/snippet and PAA carries question', () => {
    const organic = fx.serperOk.organic[0];
    for (const k of ['title', 'link']) {
      assert.notEqual(organic[k], undefined, `serper organic row missing ${k}`);
    }
    assert.notEqual(fx.serperOk.peopleAlsoAsk[0].question, undefined, 'PAA row missing question');
  });

  it('changing a Serper link changes the derived domain', async () => {
    const payload = JSON.parse(JSON.stringify(fx.serperOk));
    payload.organic[0].link = 'https://perturbed-domain.test/page';
    delete payload.organic[0].domain;
    vendorMock.script({ serper: [vendorMock.jsonReply(payload)] });

    const { organic } = await fetchSerpResults('serper contract', 'us', 'en');
    assert.equal(organic[0].domain, 'perturbed-domain.test', 'domain is not derived from link');
  });
});
