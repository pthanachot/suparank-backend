// Tests for the public visibility-check tool: input validation, cache-input
// normalization, and snippet extraction (incl. inline-markdown stripping).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  validateVisibilityCheck,
  visibilityCacheInput,
  validateContentBrief,
  contentBriefCacheInput,
  validateShareOfVoice,
  shareOfVoiceCacheInput,
  _snippetAround,
  _normalizeQuestions,
  _normalizeRelated,
  _computeSov,
} = require('../src/controllers/publicToolsController');

const req = (body) => ({ body });
const VALID = {
  engine: 'claude',
  brand: 'SupaRank',
  domain: 'suparank.app',
  prompts: ['best ai content tools for seo'],
};

test('validateVisibilityCheck accepts a valid body', () => {
  assert.strictEqual(validateVisibilityCheck(req(VALID)), null);
});

test('validateVisibilityCheck rejects bad shapes', () => {
  assert.ok(validateVisibilityCheck(req(null)));
  assert.ok(validateVisibilityCheck(req({ ...VALID, engine: 'bing' })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, brand: 'x' })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, brand: 'y'.repeat(81) })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, domain: 42 })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, prompts: [] })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, prompts: ['a', 'b', 'c', 'd'] })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, prompts: ['short'] })));
  assert.ok(validateVisibilityCheck(req({ ...VALID, prompts: ['z'.repeat(201)] })));
});

test('validateVisibilityCheck allows missing domain', () => {
  const body = { ...VALID };
  delete body.domain;
  assert.strictEqual(validateVisibilityCheck(req(body)), null);
});

test('visibilityCacheInput normalizes whitespace', () => {
  const input = visibilityCacheInput(
    req({ engine: 'claude', brand: '  SupaRank ', domain: ' suparank.app ', prompts: [' best ai tools '] })
  );
  assert.deepStrictEqual(input, {
    engine: 'claude',
    brand: 'SupaRank',
    domain: 'suparank.app',
    prompts: ['best ai tools'],
  });
});

test('visibilityCacheInput maps empty domain to null', () => {
  const input = visibilityCacheInput(req({ ...VALID, domain: '' }));
  assert.strictEqual(input.domain, null);
});

test('snippetAround strips inline markdown citations', () => {
  const answer =
    'There are many options. Top picks include SupaRank [suparank.app](https://suparank.app/tools) and others [ex.com](https://ex.com). Cheap too.';
  const snippet = _snippetAround(answer, 'SupaRank');
  assert.ok(snippet.includes('SupaRank'));
  assert.ok(!snippet.includes(']('), `markdown leaked into snippet: ${snippet}`);
  assert.ok(!snippet.includes('https://'), `raw URL leaked into snippet: ${snippet}`);
});

test('snippetAround returns null when brand absent', () => {
  assert.strictEqual(_snippetAround('Nothing relevant here.', 'SupaRank'), null);
});

test('snippetAround caps length at 200 chars', () => {
  const long = `SupaRank ${'word '.repeat(80)}`;
  const snippet = _snippetAround(long, 'SupaRank');
  assert.ok(snippet.length <= 200);
});

test('validateContentBrief accepts a plain keyword and rejects junk', () => {
  assert.strictEqual(validateContentBrief(req({ keyword: 'ai content tools' })), null);
  assert.ok(validateContentBrief(req({ keyword: 'ab' })));
  assert.ok(validateContentBrief(req({ keyword: 'x'.repeat(101) })));
  assert.ok(validateContentBrief(req({ keyword: 'https://example.com' })));
  assert.ok(validateContentBrief(req({ keyword: 'line\nbreak keyword' })));
  assert.ok(validateContentBrief(req({})));
});

test('contentBriefCacheInput lowercases and trims', () => {
  assert.deepStrictEqual(
    contentBriefCacheInput(req({ keyword: '  AI Content Tools ' })),
    { keyword: 'ai content tools' }
  );
});

test('normalizeQuestions handles strings, objects, and junk', () => {
  const out = _normalizeQuestions([
    'plain question?',
    { question: 'object question?' },
    { query: 'query-shaped?' },
    { nothing: true },
    42,
  ]);
  assert.deepStrictEqual(out, ['plain question?', 'object question?', 'query-shaped?']);
  assert.deepStrictEqual(_normalizeQuestions(null), []);
});

const SOV_VALID = {
  brand: 'SupaRank',
  competitors: ['Surfer SEO', 'Frase'],
  prompt: 'best ai content optimization tools',
};

test('validateShareOfVoice accepts valid input and rejects bad shapes', () => {
  assert.strictEqual(validateShareOfVoice(req(SOV_VALID)), null);
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, competitors: [] })));
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, competitors: ['a', 'b', 'c', 'd'] })));
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, competitors: ['x'] })));
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, prompt: 'short' })));
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, brand: '' })));
});

test('validateShareOfVoice rejects duplicate brands (case-insensitive)', () => {
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, competitors: ['suparank'] })));
  assert.ok(validateShareOfVoice(req({ ...SOV_VALID, competitors: ['Frase', ' frase '] })));
  assert.strictEqual(validateShareOfVoice(req({ ...SOV_VALID, competitors: ['Frase', 'Moz'] })), null);
});

test('shareOfVoiceCacheInput trims all fields', () => {
  const input = shareOfVoiceCacheInput(
    req({ brand: ' SupaRank ', domain: null, competitors: [' Surfer '], prompt: ' best tools ' })
  );
  assert.deepStrictEqual(input, {
    brand: 'SupaRank',
    domain: null,
    competitors: ['Surfer'],
    prompt: 'best tools',
  });
});

test('computeSov splits share across brands and excludes dead engines', () => {
  const cell = (brand, mentioned, cited = false) => ({ brand, mentioned, cited });
  const matrix = [
    { engine: 'gemini', ok: true, brands: [cell('A', true, true), cell('B', true), cell('C', false)] },
    { engine: 'chatgpt', ok: true, brands: [cell('A', true), cell('B', false), cell('C', false)] },
    { engine: 'claude', ok: false, brands: [cell('A', false), cell('B', false), cell('C', false)] },
  ];
  const sov = _computeSov(matrix);
  assert.deepStrictEqual(sov.enginesUsed, ['gemini', 'chatgpt']);
  const a = sov.perBrand.find((b) => b.brand === 'A');
  const bBrand = sov.perBrand.find((b) => b.brand === 'B');
  const c = sov.perBrand.find((b) => b.brand === 'C');
  assert.strictEqual(a.mentions, 2);
  assert.strictEqual(a.citations, 1);
  assert.strictEqual(a.sovPct, 67); // 2 of 3 total mentions
  assert.strictEqual(bBrand.sovPct, 33);
  assert.strictEqual(c.sovPct, 0);
  // dead engine must not appear in perEngine
  assert.strictEqual(a.perEngine.claude, undefined);
});

test('computeSov returns zeros when nobody is mentioned', () => {
  const matrix = [
    { engine: 'gemini', ok: true, brands: [{ brand: 'A', mentioned: false, cited: false }] },
  ];
  const sov = _computeSov(matrix);
  assert.strictEqual(sov.perBrand[0].sovPct, 0);
});

test('normalizeRelated extracts query/volume/difficulty defensively', () => {
  const out = _normalizeRelated([
    { query: 'related one', search_volume: 900, difficulty: 21 },
    { query: 'related two' },
    'bare string',
    { volume: 5 },
  ]);
  assert.deepStrictEqual(out[0], { query: 'related one', volume: 900, difficulty: 21 });
  assert.deepStrictEqual(out[1], { query: 'related two', volume: null, difficulty: null });
  assert.deepStrictEqual(out[2], { query: 'bare string', volume: null, difficulty: null });
  assert.strictEqual(out.length, 3);
});
