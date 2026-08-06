/**
 * Phase B — DataForSEO / Serper response fixtures.
 *
 * Shapes mirror what `keywordService` actually parses (related_keywords/live
 * and Serper /search), including the ugly cases: a task-level error, a
 * non-20000 status, an empty task list, >50 rows (the billing cap), and rows
 * missing the optional metric objects.
 */

function dfsKeyword(keyword, over = {}) {
  return {
    keyword_data: {
      keyword,
      keyword_info: {
        search_volume: over.searchVolume ?? 1200,
        cpc: over.cpc ?? 2.4,
        monthly_searches: over.monthlySearches ?? [
          { year: 2026, month: 1, search_volume: 900 },
          { year: 2026, month: 3, search_volume: 1400 }, // deliberately out of order
          { year: 2026, month: 2, search_volume: 1100 },
        ],
      },
      keyword_properties: { keyword_difficulty: over.difficulty ?? 42 },
      search_intent_info: { main_intent: over.intent ?? 'commercial' },
      serp_info: { serp_item_types: over.serpFeatures ?? ['organic', 'people_also_ask'] },
    },
  };
}

/**
 * A well-formed related_keywords response yielding exactly `count` RELATED
 * rows. The service pulls the seed from `seed_keyword_data` and filters any
 * item matching the seed out of `related` (keywordService.js:117-131), so
 * the seed is supplied separately rather than counted as a related row —
 * getting this wrong makes every billing assertion off by one.
 */
function dfsOk(count = 3, seedKeyword = 'seo tools') {
  const items = [];
  for (let i = 0; i < count; i++) items.push(dfsKeyword(`${seedKeyword} variant ${i}`));
  return {
    status_code: 20000,
    tasks: [{
      status_code: 20000,
      result: [{ seed_keyword_data: dfsKeyword(seedKeyword).keyword_data, items }],
    }],
  };
}

/** Task ran but returned nothing — the K3 "empty result" case. */
const dfsEmpty = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] };

/** Top-level API failure (auth, malformed request…). */
const dfsApiError = { status_code: 40501, status_message: 'Invalid Field: account balance exhausted' };

/** Task-level failure inside an otherwise-200 response. */
const dfsTaskError = {
  status_code: 20000,
  tasks: [{ status_code: 40401, status_message: 'Task error: location not found' }],
};

/** No task objects at all. */
const dfsNoTasks = { status_code: 20000, tasks: [] };

/** Rows with the optional metric objects missing entirely. */
const dfsSparse = {
  status_code: 20000,
  tasks: [{ status_code: 20000, result: [{ items: [{ keyword_data: { keyword: 'bare keyword' } }] }] }],
};

const serperOk = {
  organic: [
    { position: 1, title: 'Best SEO Tools', link: 'https://example.com/seo', snippet: 'A list.', domain: 'example.com' },
    { position: 2, title: 'More Tools', link: 'https://other.com/tools', snippet: 'Another list.' }, // no domain → derived
  ],
  peopleAlsoAsk: [
    { question: 'What is the best SEO tool?', snippet: 'It depends.', link: 'https://example.com/faq' },
  ],
};

const serperNoPaa = { organic: serperOk.organic };

module.exports = { dfsKeyword, dfsOk, dfsEmpty, dfsApiError, dfsTaskError, dfsNoTasks, dfsSparse, serperOk, serperNoPaa };
