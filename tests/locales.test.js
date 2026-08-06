'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_CODES,
  COUNTRY_LOCALES,
  isSupportedLanguage,
  isSelectableLanguage,
  resolveLocale,
  resolveCountryByName,
} = require('../src/config/locales');
const {
  resolveCountry, SUPPORTED_COUNTRIES, DATAFORSEO_UNSUPPORTED_COUNTRIES,
} = require('../src/services/keywordService');

// ── Keyword-research byte-parity ──────────────────────────────────────────────
// The pre-refactor COUNTRY_MAP (config/locales.js is now the source of truth).
// resolveCountry MUST return byte-identical { locationName, gl, languageCode }
// for every one of these, in this exact order, so keyword research is unchanged.
const ORIGINAL_KW_MAP = {
  'United States':        { locationName: 'United States',        gl: 'us', languageCode: 'en' },
  'United Kingdom':       { locationName: 'United Kingdom',       gl: 'uk', languageCode: 'en' },
  'Canada':               { locationName: 'Canada',               gl: 'ca', languageCode: 'en' },
  'Australia':            { locationName: 'Australia',            gl: 'au', languageCode: 'en' },
  'Germany':              { locationName: 'Germany',              gl: 'de', languageCode: 'de' },
  'France':               { locationName: 'France',               gl: 'fr', languageCode: 'fr' },
  'Spain':                { locationName: 'Spain',                gl: 'es', languageCode: 'es' },
  'Italy':                { locationName: 'Italy',                gl: 'it', languageCode: 'it' },
  'Netherlands':          { locationName: 'Netherlands',          gl: 'nl', languageCode: 'nl' },
  'Belgium':              { locationName: 'Belgium',              gl: 'be', languageCode: 'nl' },
  'Switzerland':          { locationName: 'Switzerland',          gl: 'ch', languageCode: 'de' },
  'Austria':              { locationName: 'Austria',              gl: 'at', languageCode: 'de' },
  'Sweden':               { locationName: 'Sweden',               gl: 'se', languageCode: 'sv' },
  'Norway':               { locationName: 'Norway',               gl: 'no', languageCode: 'no' },
  'Denmark':              { locationName: 'Denmark',              gl: 'dk', languageCode: 'da' },
  'Finland':              { locationName: 'Finland',              gl: 'fi', languageCode: 'fi' },
  'Poland':               { locationName: 'Poland',               gl: 'pl', languageCode: 'pl' },
  'Czech Republic':       { locationName: 'Czechia',              gl: 'cz', languageCode: 'cs' },
  'Romania':              { locationName: 'Romania',              gl: 'ro', languageCode: 'ro' },
  'Hungary':              { locationName: 'Hungary',              gl: 'hu', languageCode: 'hu' },
  'Portugal':             { locationName: 'Portugal',             gl: 'pt', languageCode: 'pt' },
  'Greece':               { locationName: 'Greece',               gl: 'gr', languageCode: 'el' },
  'Ireland':              { locationName: 'Ireland',              gl: 'ie', languageCode: 'en' },
  'Turkey':               { locationName: 'Turkey',               gl: 'tr', languageCode: 'tr' },
  'Israel':               { locationName: 'Israel',               gl: 'il', languageCode: 'he' },
  'United Arab Emirates': { locationName: 'United Arab Emirates', gl: 'ae', languageCode: 'ar' },
  'Saudi Arabia':         { locationName: 'Saudi Arabia',         gl: 'sa', languageCode: 'ar' },
  'Egypt':                { locationName: 'Egypt',                gl: 'eg', languageCode: 'ar' },
  'South Africa':         { locationName: 'South Africa',         gl: 'za', languageCode: 'en' },
  'Nigeria':              { locationName: 'Nigeria',              gl: 'ng', languageCode: 'en' },
  'Kenya':                { locationName: 'Kenya',                gl: 'ke', languageCode: 'en' },
  'India':                { locationName: 'India',                gl: 'in', languageCode: 'en' },
  'Japan':                { locationName: 'Japan',                gl: 'jp', languageCode: 'ja' },
  'South Korea':          { locationName: 'South Korea',          gl: 'kr', languageCode: 'ko' },
  'China':                { locationName: 'China',                gl: 'cn', languageCode: 'zh' },
  'Taiwan':               { locationName: 'Taiwan',               gl: 'tw', languageCode: 'zh' },
  'Hong Kong':            { locationName: 'Hong Kong',            gl: 'hk', languageCode: 'zh' },
  'Singapore':            { locationName: 'Singapore',            gl: 'sg', languageCode: 'en' },
  'Malaysia':             { locationName: 'Malaysia',             gl: 'my', languageCode: 'ms' },
  'Indonesia':            { locationName: 'Indonesia',            gl: 'id', languageCode: 'id' },
  'Thailand':             { locationName: 'Thailand',             gl: 'th', languageCode: 'th' },
  'Vietnam':              { locationName: 'Vietnam',              gl: 'vn', languageCode: 'vi' },
  'Philippines':          { locationName: 'Philippines',          gl: 'ph', languageCode: 'en' },
  'Pakistan':             { locationName: 'Pakistan',             gl: 'pk', languageCode: 'en' },
  'Bangladesh':           { locationName: 'Bangladesh',           gl: 'bd', languageCode: 'bn' },
  'Brazil':               { locationName: 'Brazil',               gl: 'br', languageCode: 'pt' },
  'Mexico':               { locationName: 'Mexico',               gl: 'mx', languageCode: 'es' },
  'Argentina':            { locationName: 'Argentina',            gl: 'ar', languageCode: 'es' },
  'Colombia':             { locationName: 'Colombia',             gl: 'co', languageCode: 'es' },
  'Chile':                { locationName: 'Chile',                gl: 'cl', languageCode: 'es' },
  'Peru':                 { locationName: 'Peru',                 gl: 'pe', languageCode: 'es' },
  'New Zealand':          { locationName: 'New Zealand',          gl: 'nz', languageCode: 'en' },
  'Ukraine':              { locationName: 'Ukraine',              gl: 'ua', languageCode: 'uk' },
};

test('keyword-research: resolveCountry byte-parity for every legacy country', () => {
  for (const [name, exp] of Object.entries(ORIGINAL_KW_MAP)) {
    const got = resolveCountry(name);
    for (const key of ['locationName', 'gl', 'languageCode']) {
      assert.strictEqual(got[key], exp[key], `${name}.${key}`);
    }
  }
});

// Phase C4: the ONE intentional divergence from the original map. Validated
// against DataForSEO's live locations_and_languages list on 2026-08-05 — 52 of
// our 53 codes resolve, China (2156) is not published (Google is blocked in
// mainland China, so DataForSEO has no Labs corpus). Offering it guaranteed a
// task error. The country stays in COUNTRY_LOCALES for every other surface;
// only the keyword-research picker drops it.
test('keyword-research: SUPPORTED_COUNTRIES matches the original map minus DataForSEO-unsupported', () => {
  const expected = Object.keys(ORIGINAL_KW_MAP)
    .filter((name) => !DATAFORSEO_UNSUPPORTED_COUNTRIES.has(name));
  assert.deepStrictEqual(SUPPORTED_COUNTRIES, expected);
});

// Phase C review. Removing China from SUPPORTED_COUNTRIES was NOT enough: the
// keyword UI ships its own hardcoded COUNTRIES array and never calls
// GET /keywords/countries, so the picker still offered a country the backend
// could not serve. This pins the two lists together so the next divergence
// fails here instead of reaching a user.
test('the frontend country picker matches the backend supported list', () => {
  const frontendPath = path.resolve(
    __dirname,
    '../../suparank/app/(dashboard)/workspace/[workspaceNumber]/keyword-research/components/data.tsx',
  );
  if (!fs.existsSync(frontendPath)) {
    console.log(`# SKIP keyword data.tsx not found at ${frontendPath}`);
    return;
  }
  const src = fs.readFileSync(frontendPath, 'utf8');
  const m = src.match(/export const SUPPORTED_COUNTRIES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'could not locate the SUPPORTED_COUNTRIES array in data.tsx');
  // Strip comments so a commented-out entry is not counted as offered.
  const listBody = m[1].replace(/\/\/[^\n]*/g, '');
  const frontendCountries = [...listBody.matchAll(/"([^"]+)"/g)].map((x) => x[1]);

  assert.deepStrictEqual(
    frontendCountries, SUPPORTED_COUNTRIES,
    'the keyword country picker drifted from the backend supported list',
  );
  assert.ok(
    !frontendCountries.includes('China'),
    'China is offered in the UI but DataForSEO cannot serve it',
  );
});

test('the DataForSEO exclusion list is exactly {China} — widening it needs a live re-validation', () => {
  assert.deepStrictEqual([...DATAFORSEO_UNSUPPORTED_COUNTRIES], ['China']);
  // CN must remain resolvable for non-keyword surfaces.
  assert.strictEqual(resolveCountryByName('China').locationCode, 2156);
});

test('resolveCountry falls back to United States for an unknown country', () => {
  assert.deepStrictEqual(resolveCountry('Atlantis'), resolveCountryByName('United States'));
});

// ── Language support / selectability ──────────────────────────────────────────
test('isSupportedLanguage accepts the catalog and rejects junk', () => {
  assert.ok(isSupportedLanguage('en'));
  assert.ok(isSupportedLanguage('th')); // supported (tier 3) even if not selectable
  assert.ok(!isSupportedLanguage('xx'));
  assert.ok(!isSupportedLanguage(null));
  assert.ok(!isSupportedLanguage(undefined));
});

// Phase C1: this test used to assert that ALL of tier 3 was non-selectable
// ("until Phase C"). The multi-language work has since shipped segmenters for
// Thai (mapkha) and Korean, so ENABLED_TIER3 = {th, ko} — the test was stale,
// not the code. It now pins the ENACTED state: th/ko selectable, ja/zh still
// gated pending their segmentation work.
test('isSelectableLanguage: tiers 1-2 plus the enabled tier-3 set', () => {
  assert.ok(isSelectableLanguage('en'));
  assert.ok(isSelectableLanguage('de'));
  assert.ok(isSelectableLanguage('id')); // tier 2

  for (const t3 of ['th', 'ja', 'ko', 'zh']) {
    assert.ok(isSupportedLanguage(t3), `${t3} supported`);
  }
  for (const enabled of ['th', 'ko']) {
    assert.ok(isSelectableLanguage(enabled), `${enabled} IS selectable (segmenter shipped)`);
  }
  for (const stillGated of ['ja', 'zh']) {
    assert.ok(!isSelectableLanguage(stillGated), `${stillGated} NOT selectable yet`);
  }
  assert.ok(!isSelectableLanguage('xx'));
});

// The backend comment above ENABLED_TIER3 says it "MUST stay in lockstep with
// the frontend's lib/locales.ts — the two are one enum". That was prose; this
// makes it executable. Enabling a language on one side only would ship a
// selector the other side rejects.
test('ENABLED_TIER3 is byte-identical across backend and frontend', () => {
  const backendSrc = fs.readFileSync(path.resolve(__dirname, '../src/config/locales.js'), 'utf8');
  const frontendPath = path.resolve(__dirname, '../../suparank/lib/locales.ts');
  if (!fs.existsSync(frontendPath)) {
    // The frontend repo is not always checked out beside the backend in CI.
    // Skipping silently is what let this drift before, so say so loudly.
    console.log(`# SKIP frontend locales.ts not found at ${frontendPath}`);
    return;
  }
  const frontendSrc = fs.readFileSync(frontendPath, 'utf8');

  const parse = (src, label) => {
    const m = src.match(/ENABLED_TIER3\s*=\s*new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, `${label}: could not locate ENABLED_TIER3`);
    return [...m[1].matchAll(/["']([a-z-]+)["']/g)].map((x) => x[1]).sort();
  };

  assert.deepStrictEqual(
    parse(backendSrc, 'backend'),
    parse(frontendSrc, 'frontend'),
    'ENABLED_TIER3 drifted between backend/src/config/locales.js and suparank/lib/locales.ts',
  );
});

test('every country default language is a supported language', () => {
  for (const [code, entry] of Object.entries(COUNTRY_LOCALES)) {
    assert.ok(isSupportedLanguage(entry.languageCode), `${code} default ${entry.languageCode}`);
  }
});

// ── resolveLocale semantics ───────────────────────────────────────────────────
test('resolveLocale: gl follows the country, hl/language follow the content language', () => {
  const de_es = resolveLocale('DE', 'es');
  assert.strictEqual(de_es.gl, 'de');
  assert.strictEqual(de_es.locationCode, 2276);
  assert.strictEqual(de_es.hl, 'es');
  assert.strictEqual(de_es.languageCode, 'es');
  assert.strictEqual(de_es.language, 'es');
});

test('resolveLocale: absent/unsupported language falls back to the country default', () => {
  assert.strictEqual(resolveLocale('DE').language, 'de');
  assert.strictEqual(resolveLocale('DE', 'xx').language, 'de');
  assert.strictEqual(resolveLocale('FR', '').language, 'fr');
});

test('resolveLocale: unknown country falls back to US', () => {
  const r = resolveLocale('ZZ', 'en');
  assert.strictEqual(r.country, 'US');
  assert.strictEqual(r.gl, 'us');
  assert.strictEqual(r.locationCode, 2840);
});

test('location codes are distinct positive integers (= 2000 + ISO numeric)', () => {
  const seen = new Set();
  for (const [code, entry] of Object.entries(COUNTRY_LOCALES)) {
    assert.ok(Number.isInteger(entry.locationCode) && entry.locationCode > 2000, `${code} locationCode`);
    assert.ok(!seen.has(entry.locationCode), `${code} duplicate locationCode`);
    seen.add(entry.locationCode);
  }
});

// ── Frontend mirror parity (guards drift between lib/locales.ts and this file) ──
test('frontend lib/locales.ts mirror matches the backend config', () => {
  const feText = fs.readFileSync(
    path.join(__dirname, '../../suparank/lib/locales.ts'),
    'utf8'
  );

  // Countries: code + defaultLanguage.
  const feCountries = {};
  for (const m of feText.matchAll(/\{\s*code:\s*"([A-Z]{2})",\s*label:\s*"[^"]+",\s*defaultLanguage:\s*"([a-z]{2})"\s*\}/g)) {
    feCountries[m[1]] = m[2];
  }
  const beCodes = Object.keys(COUNTRY_LOCALES).sort();
  assert.deepStrictEqual(Object.keys(feCountries).sort(), beCodes, 'country code sets differ');
  for (const code of beCodes) {
    assert.strictEqual(feCountries[code], COUNTRY_LOCALES[code].languageCode, `${code} default language differs`);
  }

  // Languages: code + tier.
  const feLangs = {};
  for (const m of feText.matchAll(/\{\s*code:\s*"([a-z]{2})",\s*label:\s*"[^"]+",\s*tier:\s*([123])/g)) {
    feLangs[m[1]] = Number(m[2]);
  }
  const beLangs = {};
  SUPPORTED_LANGUAGES.forEach((l) => { beLangs[l.code] = l.tier; });
  assert.deepStrictEqual(feLangs, beLangs, 'language code/tier sets differ');
});

test('SUPPORTED_LANGUAGE_CODES has no duplicates and includes en default', () => {
  assert.strictEqual(new Set(SUPPORTED_LANGUAGE_CODES).size, SUPPORTED_LANGUAGE_CODES.length);
  assert.ok(SUPPORTED_LANGUAGE_CODES.includes('en'));
});
