/**
 * Phase C3 — curation boundary invariant. Every curate* function maps the
 * engine's snake_case into the API's camelCase contract. bot-access shipped raw
 * snake_case to the frontend for months because it had no curator; this test
 * makes a forgotten remap fail in CI instead of silently in the UI.
 *
 * Scope: assert the KEYS the curator constructs are camelCase. We deliberately
 * skip recursing into a small set of documented raw-passthrough blobs (engine
 * objects forwarded verbatim, whose inner keys are intentionally still
 * snake_case) — checking those would flag intended behavior.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { _curators } = require('../src/controllers/analysisController');

// Keys whose VALUES are raw engine blobs forwarded verbatim (their inner keys
// are intentionally still snake_case — checking them would flag intended
// behavior). We assert the key itself is camelCase but do not recurse into the
// value. These are every `brief.<x> || {}` / `|| []` passthrough in the curators.
const PASSTHROUGH = new Set([
  'competitorStats',       // curateBenchmark / curateContentBrief — raw competitor_stats
  'layerTargets',          // curateContentBrief — raw layer_targets
  'formatDistribution',    // curateAiFormatData — raw format_distribution map
  'featuredSnippet',       // curateContentBrief — raw serp_analysis.featured_snippet object
  'audiences',             // curateContentBrief — raw brief.audiences
  'competitorWeaknesses',  // curateContentBrief — raw brief.competitor_weaknesses
]);

// Recursively assert every CONSTRUCTED key is camelCase; returns the number of
// keys checked so the caller can prove the walk wasn't vacuous.
function countCamelKeys(value, pathStr) {
  let n = 0;
  if (Array.isArray(value)) {
    value.forEach((v, i) => { n += countCamelKeys(v, `${pathStr}[${i}]`); });
    return n;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(!k.includes('_'), `snake_case key "${k}" in curated output at ${pathStr}`);
      n += 1;
      if (!PASSTHROUGH.has(k)) n += countCamelKeys(v, `${pathStr}.${k}`);
    }
  }
  return n;
}

// Representative snake_case engine inputs — populated enough to exercise the
// nested constructed shapes (terms, gaps, structure, verdicts, etc.).
const INPUTS = {
  curateBenchmark: {
    keyword: 'crm software',
    competitor_stats: {
      avg_word_count: 1500, avg_sections: 8, avg_h3_count: 12, avg_internal_links: 5,
      avg_external_links: 3, avg_images: 4, avg_keyword_density: 0.02, keyword_in_h2_rate: 0.5,
      keyword_in_first100_rate: 1, avg_lists: 2, avg_tables: 1, avg_faqs: 3,
      avg_paragraphs: 20, avg_reading_level: 9,
    },
    terms: [{ term: 'crm', freq: 10, doc_freq: 8, bm25: 1.2, uses: [2, 5], section: 'h2', layer: 'awareness' }],
    clusters: [{ label: 'features', terms: ['a', 'b'] }],
    structure: [{ name: 'key_features', prevalence: '8/10' }],
  },
  curateCompetitors: [
    { url: 'https://x.com', title: 'X', best_position: 3, keywords: ['a'], selected: true },
  ],
  curateContentBrief: {
    brief_id: 'b1', keyword: 'crm', created_at: '2026-01-01', archetype: 'guide',
    sophistication: 'high', audiences: ['smb'],
    structure: [{ id: 's1', name: 'Intro', priority: 1, words: ['crm'], prevalence: '9/10', paa_mapped: true, snippet_target: true, source: 'serp' }],
    serp_analysis: { featured_snippet: null, people_also_ask: ['what is crm?'] },
    competitor_stats: { avg_word_count: 1500 },
    layer_targets: { awareness: 3 },
    gaps: {
      concept_gaps: [{ id: 'g1', concept: 'pricing', coverage: 0.2, score: 8, terms: ['cost'], angle: 'a' }],
      layer_gaps: [{ id: 'g2', layer: 'consideration', current: 1, target: 3, score: 7, terms: ['compare'], angle: 'b' }],
      paa_gaps: [{ id: 'g3', question: 'how much?', answered_well_by_competitors: false, score: 6, terms: ['price'], angle: 'c' }],
    },
    terms: [{ term: 'crm', score: 9, centrality: 0.8, type: 'core', layer: 'awareness', section: 'h2', uses: [2, 5], cluster: 'c1', source: 'serp', gap_ref: 'g1', guidance: 'use it', bm25: 1.2, doc_freq: 8, freq: 10, volatile: false }],
    clusters: [{ id: 'c1', label: 'features', terms: ['a'] }],
    competitor_weaknesses: ['thin content'],
    pipeline_cost: 0.42,
    content_type: 'product-page',
    serp_formats: {
      total: 14, counts: { listicle: 9, 'product-page': 2 },
      declared_type: 'product-page', matched_labels: ['product-page'], matched_count: 2,
    },
    format_signal: {
      kind: 'minority', message: '2 of 14 ranking pages match…',
      matched_pages: [{ url: 'https://v.com/pricing', title: 'Pricing', position: 3, format: 'product-page', word_count: 900 }],
    },
  },
  curateAiFormatData: {
    keyword: 'crm', recommended_format: 'guide', format_confidence: 0.9,
    format_distribution: { guide: 0.9, listicle: 0.1 },
    recommended_structure: {
      target_word_count: 1800, target_sections: 8, target_section_length: 200,
      suggested_headings: ['What is CRM'], must_include_elements: ['table'],
      front_loading_guidance: 'answer early',
    },
    nlp_terms: [{ term: 'crm', group: 'mention', benchmark_count: 5, position: 'intro', proximity_partners: ['software'], volatile: false }],
  },
  curateCitationAppearance: [
    { domain: 'x.com', appearances: 3, samples: 10, rate: 0.3, example_urls: ['https://x.com/a'] },
  ],
  curateRecommendedOutline: {
    h1: 'The CRM Guide',
    sections: [{ h2: 'What is CRM', rationale: 'intent', children: [{ h3: 'Definition', rationale: 'clarity' }] }],
  },
  curateBotAccess: {
    robots_url: 'https://x.com/robots.txt', robots_status: 200,
    verdicts: [{ bot: 'GPTBot', allowed: false, source: 'robots_group' }],
    cdn_block: { normal_status: 200, bot_ua_status: 403, blocked: true },
    guidance: ['unblock GPTBot'],
  },
};

describe('curate* output is camelCase at the API boundary', () => {
  for (const [name, curate] of Object.entries(_curators)) {
    it(`${name} emits no snake_case keys`, () => {
      const out = curate(INPUTS[name]);
      assert.ok(out != null, `${name} returned null/undefined for its test input`);
      const checked = countCamelKeys(out, name);
      assert.ok(checked > 0, `${name} produced no keys to check — the assertion would be vacuous; enrich its test input`);
    });
  }

  it('every curator has a representative test input (no silent skips)', () => {
    for (const name of Object.keys(_curators)) {
      assert.ok(name in INPUTS, `missing test input for curator ${name}`);
    }
  });
});
