/**
 * Keyword Research Service
 *
 * External API integrations for keyword data:
 * - DataForSEO Labs (related_keywords/live) → keyword metrics + related keywords
 * - Serper API → SERP results + People Also Ask
 */

// ─── Country Mapping ─────────────────────────────────────────────────────────

const COUNTRY_MAP = {
  'United States':       { locationName: 'United States',       gl: 'us', languageCode: 'en' },
  'United Kingdom':      { locationName: 'United Kingdom',      gl: 'uk', languageCode: 'en' },
  'Canada':              { locationName: 'Canada',              gl: 'ca', languageCode: 'en' },
  'Australia':           { locationName: 'Australia',           gl: 'au', languageCode: 'en' },
  'Germany':             { locationName: 'Germany',             gl: 'de', languageCode: 'de' },
  'France':              { locationName: 'France',              gl: 'fr', languageCode: 'fr' },
  'Spain':               { locationName: 'Spain',               gl: 'es', languageCode: 'es' },
  'Italy':               { locationName: 'Italy',               gl: 'it', languageCode: 'it' },
  'Netherlands':         { locationName: 'Netherlands',         gl: 'nl', languageCode: 'nl' },
  'Belgium':             { locationName: 'Belgium',             gl: 'be', languageCode: 'nl' },
  'Switzerland':         { locationName: 'Switzerland',         gl: 'ch', languageCode: 'de' },
  'Austria':             { locationName: 'Austria',             gl: 'at', languageCode: 'de' },
  'Sweden':              { locationName: 'Sweden',              gl: 'se', languageCode: 'sv' },
  'Norway':              { locationName: 'Norway',              gl: 'no', languageCode: 'no' },
  'Denmark':             { locationName: 'Denmark',             gl: 'dk', languageCode: 'da' },
  'Finland':             { locationName: 'Finland',             gl: 'fi', languageCode: 'fi' },
  'Poland':              { locationName: 'Poland',              gl: 'pl', languageCode: 'pl' },
  'Czech Republic':      { locationName: 'Czechia',             gl: 'cz', languageCode: 'cs' },
  'Romania':             { locationName: 'Romania',             gl: 'ro', languageCode: 'ro' },
  'Hungary':             { locationName: 'Hungary',             gl: 'hu', languageCode: 'hu' },
  'Portugal':            { locationName: 'Portugal',            gl: 'pt', languageCode: 'pt' },
  'Greece':              { locationName: 'Greece',              gl: 'gr', languageCode: 'el' },
  'Ireland':             { locationName: 'Ireland',             gl: 'ie', languageCode: 'en' },
  'Turkey':              { locationName: 'Turkey',              gl: 'tr', languageCode: 'tr' },
  'Israel':              { locationName: 'Israel',              gl: 'il', languageCode: 'he' },
  'United Arab Emirates':{ locationName: 'United Arab Emirates',gl: 'ae', languageCode: 'ar' },
  'Saudi Arabia':        { locationName: 'Saudi Arabia',        gl: 'sa', languageCode: 'ar' },
  'Egypt':               { locationName: 'Egypt',               gl: 'eg', languageCode: 'ar' },
  'South Africa':        { locationName: 'South Africa',        gl: 'za', languageCode: 'en' },
  'Nigeria':             { locationName: 'Nigeria',             gl: 'ng', languageCode: 'en' },
  'Kenya':               { locationName: 'Kenya',               gl: 'ke', languageCode: 'en' },
  'India':               { locationName: 'India',               gl: 'in', languageCode: 'en' },
  'Japan':               { locationName: 'Japan',               gl: 'jp', languageCode: 'ja' },
  'South Korea':         { locationName: 'South Korea',         gl: 'kr', languageCode: 'ko' },
  'China':               { locationName: 'China',               gl: 'cn', languageCode: 'zh' },
  'Taiwan':              { locationName: 'Taiwan',              gl: 'tw', languageCode: 'zh' },
  'Hong Kong':           { locationName: 'Hong Kong',           gl: 'hk', languageCode: 'zh' },
  'Singapore':           { locationName: 'Singapore',           gl: 'sg', languageCode: 'en' },
  'Malaysia':            { locationName: 'Malaysia',            gl: 'my', languageCode: 'ms' },
  'Indonesia':           { locationName: 'Indonesia',           gl: 'id', languageCode: 'id' },
  'Thailand':            { locationName: 'Thailand',            gl: 'th', languageCode: 'th' },
  'Vietnam':             { locationName: 'Vietnam',             gl: 'vn', languageCode: 'vi' },
  'Philippines':         { locationName: 'Philippines',         gl: 'ph', languageCode: 'en' },
  'Pakistan':            { locationName: 'Pakistan',            gl: 'pk', languageCode: 'en' },
  'Bangladesh':          { locationName: 'Bangladesh',          gl: 'bd', languageCode: 'bn' },
  'Brazil':              { locationName: 'Brazil',              gl: 'br', languageCode: 'pt' },
  'Mexico':              { locationName: 'Mexico',              gl: 'mx', languageCode: 'es' },
  'Argentina':           { locationName: 'Argentina',           gl: 'ar', languageCode: 'es' },
  'Colombia':            { locationName: 'Colombia',            gl: 'co', languageCode: 'es' },
  'Chile':               { locationName: 'Chile',               gl: 'cl', languageCode: 'es' },
  'Peru':                { locationName: 'Peru',                gl: 'pe', languageCode: 'es' },
  'New Zealand':         { locationName: 'New Zealand',         gl: 'nz', languageCode: 'en' },
  'Ukraine':             { locationName: 'Ukraine',             gl: 'ua', languageCode: 'uk' },
};

function resolveCountry(displayName) {
  return COUNTRY_MAP[displayName] || COUNTRY_MAP['United States'];
}

// ─── Question Detection ──────────────────────────────────────────────────────

const QUESTION_REGEX = /^(how|what|why|when|where|which|who|is|can|does|do|are|will|should)\b/i;

function isQuestionKeyword(keyword) {
  return QUESTION_REGEX.test(keyword);
}

// ─── SERP Feature Filtering ─────────────────────────────────────────────────

const KNOWN_SERP_FEATURES = new Set([
  'featured_snippet',
  'people_also_ask',
  'paid',
  'video',
  'reviews',
  'local_pack',
  'images',
  'shopping',
  'knowledge_graph',
  'site_links',
  'top_stories',
  'twitter',
  'carousel',
]);

function filterSerpFeatures(serpItemTypes) {
  if (!Array.isArray(serpItemTypes)) return [];
  return serpItemTypes.filter((t) => KNOWN_SERP_FEATURES.has(t));
}

// ─── DataForSEO: Related Keywords ────────────────────────────────────────────

/**
 * Fetch related keywords from DataForSEO Labs.
 *
 * @param {string} seedKeyword
 * @param {string} locationName - e.g. "United States"
 * @param {string} languageCode - e.g. "en"
 * @returns {Promise<{ seed: Object|null, related: Object[] }>}
 */
async function fetchRelatedKeywords(seedKeyword, locationName = 'United States', languageCode = 'en') {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('DataForSEO credentials not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{
        keyword: seedKeyword,
        location_name: locationName,
        language_code: languageCode,
        limit: 100,
        include_seed_keyword: true,
        include_serp_info: true,
      }]),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DataForSEO returned status ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();

    if (data.status_code !== 20000) {
      throw new Error(`DataForSEO error: ${data.status_message || 'Unknown error'}`);
    }

    const task = data.tasks?.[0];
    if (!task) {
      return { seed: null, related: [] };
    }

    if (task.status_code !== 20000) {
      throw new Error(`DataForSEO task error: ${task.status_message || 'Unknown error'}`);
    }

    const taskResult = task.result?.[0];
    if (!taskResult) {
      return { seed: null, related: [] };
    }

    const items = taskResult.items || [];
    let seed = null;
    const related = [];

    // Extract seed keyword data
    const seedData = taskResult.seed_keyword_data;
    if (seedData) {
      seed = mapDataForSEOKeyword(seedData);
    }

    // Extract related keywords
    for (const item of items) {
      const kd = item.keyword_data;
      if (!kd) continue;
      const mapped = mapDataForSEOKeyword(kd);
      // Skip the seed keyword in related list
      if (mapped.keyword.toLowerCase() === seedKeyword.toLowerCase()) {
        if (!seed) seed = mapped;
        continue;
      }
      related.push(mapped);
    }

    return { seed, related };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Map a DataForSEO keyword_data object to our internal format.
 */
function mapDataForSEOKeyword(kd) {
  const info = kd.keyword_info || {};
  const props = kd.keyword_properties || {};
  const serp = kd.serp_info || {};
  const intentInfo = kd.search_intent_info || {};

  // monthly_searches: array of { year, month, search_volume } → sorted chronologically → number[]
  let monthlySearches = [];
  if (Array.isArray(info.monthly_searches)) {
    monthlySearches = [...info.monthly_searches]
      .filter((m) => m != null && typeof m === 'object')
      .sort((a, b) => (a.year - b.year) || (a.month - b.month))
      .map((m) => m.search_volume ?? 0);
  }

  return {
    keyword: kd.keyword || '',
    searchVolume: info.search_volume ?? 0,
    keywordDifficulty: props.keyword_difficulty ?? 0,
    cpc: info.cpc ?? 0,
    searchIntent: (intentInfo.main_intent || 'informational').toLowerCase(),
    monthlySearches,
    serpFeatures: filterSerpFeatures(serp.serp_item_types),
    isQuestion: isQuestionKeyword(kd.keyword || ''),
  };
}

// ─── Serper: SERP Results + PAA ──────────────────────────────────────────────

/**
 * Fetch SERP results and People Also Ask from Serper API.
 *
 * @param {string} keyword
 * @param {string} gl - country code, e.g. "us"
 * @param {string} hl - language code, e.g. "en"
 * @returns {Promise<{ organic: Object[], peopleAlsoAsk: Object[] }>}
 */
async function fetchSerpResults(keyword, gl = 'us', hl = 'en') {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('Serper API key not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: keyword,
        gl,
        hl,
        num: 10,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Serper returned status ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();

    // Map organic results
    const organic = (data.organic || []).map((item, index) => {
      let domain = item.domain || '';
      if (!domain && item.link) {
        try {
          domain = new URL(item.link).hostname;
        } catch {
          domain = '';
        }
      }

      return {
        position: item.position ?? (index + 1),
        domain,
        title: item.title || '',
        link: item.link || '',
        snippet: item.snippet || '',
      };
    });

    // Map People Also Ask
    const peopleAlsoAsk = (data.peopleAlsoAsk || []).map((item) => ({
      question: item.question || '',
      snippet: item.snippet || '',
      link: item.link || '',
    }));

    return { organic, peopleAlsoAsk };
  } finally {
    clearTimeout(timeout);
  }
}

const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_MAP);

module.exports = {
  resolveCountry,
  fetchRelatedKeywords,
  fetchSerpResults,
  SUPPORTED_COUNTRIES,
};
