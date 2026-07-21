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
const { resolveCountry, SUPPORTED_COUNTRIES } = require('../src/services/keywordService');

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

test('keyword-research: SUPPORTED_COUNTRIES set + order unchanged (no additions/drops)', () => {
  assert.deepStrictEqual(SUPPORTED_COUNTRIES, Object.keys(ORIGINAL_KW_MAP));
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

test('isSelectableLanguage gates tier 3 (Thai/CJK) until Phase C', () => {
  assert.ok(isSelectableLanguage('en'));
  assert.ok(isSelectableLanguage('de'));
  assert.ok(isSelectableLanguage('id')); // tier 2
  for (const t3 of ['th', 'ja', 'ko', 'zh']) {
    assert.ok(isSupportedLanguage(t3), `${t3} supported`);
    assert.ok(!isSelectableLanguage(t3), `${t3} NOT selectable`);
  }
  assert.ok(!isSelectableLanguage('xx'));
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
