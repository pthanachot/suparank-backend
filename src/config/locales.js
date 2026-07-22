'use strict';

/**
 * Locale configuration — single source of truth for
 *   (1) the supported content-language set, and
 *   (2) country → SEO/AEO provider locale mapping.
 *
 * Consumers:
 *   - keywordService.js (keyword research) — via resolveCountryByName / SUPPORTED_COUNTRIES.
 *   - contentController.js — validates Content.language against SUPPORTED_LANGUAGE_CODES.
 *   - analysisController.runAnalysis (Issue 2 Phase A, step A4) — via resolveLocale,
 *     to thread gl/hl/location_code/language_code into the engine.
 *   - Frontend mirror: suparank/lib/locales.ts (keep in sync; a future
 *     /api/public/locales endpoint can replace the mirror).
 *
 * Language tiers (Issue 2 plan):
 *   tier 1 — space-delimited + stemmer available: full term scoring after Phase B.
 *            B0 RESOLVED: all 15 tier-1 languages have a verified Snowball stemmer
 *            — en/es/fr/ru/sv/no/hu via kljensen/snowball, and de/it/nl/pt/da/fi/
 *            ro/tr via blevesearch/snowballstem. No demotions; the table stands.
 *   tier 2 — space-delimited, no stemmer: exact-match term scoring.
 *   tier 3 — no word delimiters (Thai/CJK): BLOCKED until Phase C (segmentation).
 *            NOT selectable in the creation UI yet — enabling before Phase C
 *            produces an empty competitor corpus (crawl-gate collapse, finding F12).
 */

// ─── Supported content languages ─────────────────────────────────────────────
const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', tier: 1 },
  { code: 'es', label: 'Spanish', tier: 1 },
  { code: 'pt', label: 'Portuguese', tier: 1 },
  { code: 'fr', label: 'French', tier: 1 },
  { code: 'de', label: 'German', tier: 1 },
  { code: 'it', label: 'Italian', tier: 1 },
  { code: 'nl', label: 'Dutch', tier: 1 },
  { code: 'ru', label: 'Russian', tier: 1 },
  { code: 'sv', label: 'Swedish', tier: 1 },
  { code: 'no', label: 'Norwegian', tier: 1 },
  { code: 'da', label: 'Danish', tier: 1 },
  { code: 'fi', label: 'Finnish', tier: 1 },
  { code: 'hu', label: 'Hungarian', tier: 1 },
  { code: 'ro', label: 'Romanian', tier: 1 },
  { code: 'tr', label: 'Turkish', tier: 1 },
  { code: 'pl', label: 'Polish', tier: 2 },
  { code: 'cs', label: 'Czech', tier: 2 },
  { code: 'el', label: 'Greek', tier: 2 },
  { code: 'id', label: 'Indonesian', tier: 2 },
  { code: 'vi', label: 'Vietnamese', tier: 2 },
  { code: 'hi', label: 'Hindi', tier: 2 },
  { code: 'ms', label: 'Malay', tier: 2 },
  { code: 'uk', label: 'Ukrainian', tier: 2 },
  { code: 'bn', label: 'Bengali', tier: 2 },
  { code: 'ar', label: 'Arabic', tier: 2, rtl: true },
  { code: 'he', label: 'Hebrew', tier: 2, rtl: true },
  { code: 'th', label: 'Thai', tier: 3 },
  { code: 'ja', label: 'Japanese', tier: 3 },
  { code: 'ko', label: 'Korean', tier: 3 },
  { code: 'zh', label: 'Chinese', tier: 3 },
];

const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
const SUPPORTED_LANGUAGE_SET = new Set(SUPPORTED_LANGUAGE_CODES);

const DEFAULT_LANGUAGE = 'en';
const DEFAULT_COUNTRY = 'US';

// ─── Country → locale ─────────────────────────────────────────────────────────
// Keyed by ISO 3166-1 alpha-2. Fields:
//   countryName  — display name (also the keyword-research lookup key; must match
//                  the strings the keyword UI sends).
//   locationName — DataForSEO location_name.
//   locationCode — DataForSEO location_code (= 2000 + ISO 3166-1 numeric).
//                  NOTE (A7): these are formula-derived and verified typo-free,
//                  but NOT yet confirmed against DataForSEO's published Google-Ads
//                  location list — validate the full set before the volume client
//                  consumes them, since a code DataForSEO doesn't serve = no/wrong volume.
//   gl           — Serper/Google country parameter (preserves legacy values,
//                  e.g. 'uk' for the United Kingdom).
//   languageCode — the country's DEFAULT content language (overridable per article).
// Ordering mirrors the legacy keyword-research map so SUPPORTED_COUNTRIES order is stable.
const COUNTRY_LOCALES = {
  US: { countryName: 'United States',        locationName: 'United States',        locationCode: 2840, gl: 'us', languageCode: 'en' },
  GB: { countryName: 'United Kingdom',       locationName: 'United Kingdom',       locationCode: 2826, gl: 'uk', languageCode: 'en' },
  CA: { countryName: 'Canada',               locationName: 'Canada',               locationCode: 2124, gl: 'ca', languageCode: 'en' },
  AU: { countryName: 'Australia',            locationName: 'Australia',            locationCode: 2036, gl: 'au', languageCode: 'en' },
  DE: { countryName: 'Germany',              locationName: 'Germany',              locationCode: 2276, gl: 'de', languageCode: 'de' },
  FR: { countryName: 'France',               locationName: 'France',               locationCode: 2250, gl: 'fr', languageCode: 'fr' },
  ES: { countryName: 'Spain',                locationName: 'Spain',                locationCode: 2724, gl: 'es', languageCode: 'es' },
  IT: { countryName: 'Italy',                locationName: 'Italy',                locationCode: 2380, gl: 'it', languageCode: 'it' },
  NL: { countryName: 'Netherlands',          locationName: 'Netherlands',          locationCode: 2528, gl: 'nl', languageCode: 'nl' },
  BE: { countryName: 'Belgium',              locationName: 'Belgium',              locationCode: 2056, gl: 'be', languageCode: 'nl' },
  CH: { countryName: 'Switzerland',          locationName: 'Switzerland',          locationCode: 2756, gl: 'ch', languageCode: 'de' },
  AT: { countryName: 'Austria',              locationName: 'Austria',              locationCode: 2040, gl: 'at', languageCode: 'de' },
  SE: { countryName: 'Sweden',               locationName: 'Sweden',               locationCode: 2752, gl: 'se', languageCode: 'sv' },
  NO: { countryName: 'Norway',               locationName: 'Norway',               locationCode: 2578, gl: 'no', languageCode: 'no' },
  DK: { countryName: 'Denmark',              locationName: 'Denmark',              locationCode: 2208, gl: 'dk', languageCode: 'da' },
  FI: { countryName: 'Finland',              locationName: 'Finland',              locationCode: 2246, gl: 'fi', languageCode: 'fi' },
  PL: { countryName: 'Poland',               locationName: 'Poland',               locationCode: 2616, gl: 'pl', languageCode: 'pl' },
  CZ: { countryName: 'Czech Republic',       locationName: 'Czechia',              locationCode: 2203, gl: 'cz', languageCode: 'cs' },
  RO: { countryName: 'Romania',              locationName: 'Romania',              locationCode: 2642, gl: 'ro', languageCode: 'ro' },
  HU: { countryName: 'Hungary',              locationName: 'Hungary',              locationCode: 2348, gl: 'hu', languageCode: 'hu' },
  PT: { countryName: 'Portugal',             locationName: 'Portugal',             locationCode: 2620, gl: 'pt', languageCode: 'pt' },
  GR: { countryName: 'Greece',               locationName: 'Greece',               locationCode: 2300, gl: 'gr', languageCode: 'el' },
  IE: { countryName: 'Ireland',              locationName: 'Ireland',              locationCode: 2372, gl: 'ie', languageCode: 'en' },
  TR: { countryName: 'Turkey',               locationName: 'Turkey',               locationCode: 2792, gl: 'tr', languageCode: 'tr' },
  IL: { countryName: 'Israel',               locationName: 'Israel',               locationCode: 2376, gl: 'il', languageCode: 'he' },
  AE: { countryName: 'United Arab Emirates', locationName: 'United Arab Emirates', locationCode: 2784, gl: 'ae', languageCode: 'ar' },
  SA: { countryName: 'Saudi Arabia',         locationName: 'Saudi Arabia',         locationCode: 2682, gl: 'sa', languageCode: 'ar' },
  EG: { countryName: 'Egypt',                locationName: 'Egypt',                locationCode: 2818, gl: 'eg', languageCode: 'ar' },
  ZA: { countryName: 'South Africa',         locationName: 'South Africa',         locationCode: 2710, gl: 'za', languageCode: 'en' },
  NG: { countryName: 'Nigeria',              locationName: 'Nigeria',              locationCode: 2566, gl: 'ng', languageCode: 'en' },
  KE: { countryName: 'Kenya',                locationName: 'Kenya',                locationCode: 2404, gl: 'ke', languageCode: 'en' },
  IN: { countryName: 'India',                locationName: 'India',                locationCode: 2356, gl: 'in', languageCode: 'en' },
  JP: { countryName: 'Japan',                locationName: 'Japan',                locationCode: 2392, gl: 'jp', languageCode: 'ja' },
  KR: { countryName: 'South Korea',          locationName: 'South Korea',          locationCode: 2410, gl: 'kr', languageCode: 'ko' },
  CN: { countryName: 'China',                locationName: 'China',                locationCode: 2156, gl: 'cn', languageCode: 'zh' },
  TW: { countryName: 'Taiwan',               locationName: 'Taiwan',               locationCode: 2158, gl: 'tw', languageCode: 'zh' },
  HK: { countryName: 'Hong Kong',            locationName: 'Hong Kong',            locationCode: 2344, gl: 'hk', languageCode: 'zh' },
  SG: { countryName: 'Singapore',            locationName: 'Singapore',            locationCode: 2702, gl: 'sg', languageCode: 'en' },
  MY: { countryName: 'Malaysia',             locationName: 'Malaysia',             locationCode: 2458, gl: 'my', languageCode: 'ms' },
  ID: { countryName: 'Indonesia',            locationName: 'Indonesia',            locationCode: 2360, gl: 'id', languageCode: 'id' },
  TH: { countryName: 'Thailand',             locationName: 'Thailand',             locationCode: 2764, gl: 'th', languageCode: 'th' },
  VN: { countryName: 'Vietnam',              locationName: 'Vietnam',              locationCode: 2704, gl: 'vn', languageCode: 'vi' },
  PH: { countryName: 'Philippines',          locationName: 'Philippines',          locationCode: 2608, gl: 'ph', languageCode: 'en' },
  PK: { countryName: 'Pakistan',             locationName: 'Pakistan',             locationCode: 2586, gl: 'pk', languageCode: 'en' },
  BD: { countryName: 'Bangladesh',           locationName: 'Bangladesh',           locationCode: 2050, gl: 'bd', languageCode: 'bn' },
  BR: { countryName: 'Brazil',               locationName: 'Brazil',               locationCode: 2076, gl: 'br', languageCode: 'pt' },
  MX: { countryName: 'Mexico',               locationName: 'Mexico',               locationCode: 2484, gl: 'mx', languageCode: 'es' },
  AR: { countryName: 'Argentina',            locationName: 'Argentina',            locationCode: 2032, gl: 'ar', languageCode: 'es' },
  CO: { countryName: 'Colombia',             locationName: 'Colombia',             locationCode: 2170, gl: 'co', languageCode: 'es' },
  CL: { countryName: 'Chile',                locationName: 'Chile',                locationCode: 2152, gl: 'cl', languageCode: 'es' },
  PE: { countryName: 'Peru',                 locationName: 'Peru',                 locationCode: 2604, gl: 'pe', languageCode: 'es' },
  NZ: { countryName: 'New Zealand',          locationName: 'New Zealand',          locationCode: 2554, gl: 'nz', languageCode: 'en' },
  UA: { countryName: 'Ukraine',              locationName: 'Ukraine',              locationCode: 2804, gl: 'ua', languageCode: 'uk' },
};

// Name-keyed view for backward-compatible keyword-research lookups (which resolve
// by display name). Derived — do not maintain by hand.
const COUNTRY_LOCALES_BY_NAME = {};
for (const [code, entry] of Object.entries(COUNTRY_LOCALES)) {
  COUNTRY_LOCALES_BY_NAME[entry.countryName] = Object.assign({ country: code }, entry);
}

function isSupportedLanguage(code) {
  return typeof code === 'string' && SUPPORTED_LANGUAGE_SET.has(code);
}

// A supported language may not be usable end-to-end yet. Tier 1/2 are always
// selectable. Tier 3 (Thai/CJK) needed Phase C (segmentation) — now shipped — and
// then per-language launch sign-off: Thai + Korean are enabled; Chinese/Japanese
// are held (see ENABLED_TIER3). This MUST stay in lockstep with the frontend's
// lib/locales.ts (ENABLED_TIER3 + SELECTABLE_LANGUAGES) — the two are one enum.
const SELECTABLE_TIER_MAX = 2;
const ENABLED_TIER3 = new Set(['th', 'ko']);
function isSelectableLanguage(code) {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
  return !!lang && (lang.tier <= SELECTABLE_TIER_MAX || ENABLED_TIER3.has(code));
}

// Content-analysis path (A4): country code + chosen content language → the exact
// provider locale. gl/location follow the country (geography); hl/language_code
// follow the chosen content language (e.g. Spanish content in the US market:
// gl=us, hl=es). An unsupported/absent language falls back to the country default.
function resolveLocale(countryCode, language) {
  const cc = String(countryCode || DEFAULT_COUNTRY).toUpperCase();
  // Resolve to a real country so every returned field (incl. `country`) is
  // consistent — an unknown code falls back wholesale to the default, not just
  // its provider params.
  const resolvedCode = COUNTRY_LOCALES[cc] ? cc : DEFAULT_COUNTRY;
  const entry = COUNTRY_LOCALES[resolvedCode];
  const lang = isSupportedLanguage(language) ? language : entry.languageCode;
  return {
    country: resolvedCode,
    countryName: entry.countryName,
    gl: entry.gl,
    hl: lang,
    locationCode: entry.locationCode,
    locationName: entry.locationName,
    languageCode: lang,
    language: lang,
  };
}

// Backward-compat for keywordService.resolveCountry(displayName). Returns the same
// { locationName, gl, languageCode } shape (plus extra fields) it relied on.
function resolveCountryByName(displayName) {
  return COUNTRY_LOCALES_BY_NAME[displayName] || COUNTRY_LOCALES_BY_NAME[COUNTRY_LOCALES[DEFAULT_COUNTRY].countryName];
}

module.exports = {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_CODES,
  DEFAULT_LANGUAGE,
  DEFAULT_COUNTRY,
  COUNTRY_LOCALES,
  COUNTRY_LOCALES_BY_NAME,
  isSupportedLanguage,
  isSelectableLanguage,
  resolveLocale,
  resolveCountryByName,
};
