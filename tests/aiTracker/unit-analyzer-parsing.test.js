/**
 * Phase 2 — analyzer parsing gaps the Kimi suite doesn't cover.
 *
 * aiTrackerAnalyzerKimi.test.js pins the happy path, fence stripping,
 * finish_reason=length, and the no-key / error-status fallbacks. This file
 * adds the remaining dossier §12 parse rows:
 *   - F3-11: object-shaped `brands` coerced to an array (no false negative)
 *   - F3-09: sentiment label re-derived from score; score 0 preserved
 *   - malformed JSON → _fallbackAnalysis (position null, target-only ranking)
 *   - F3-08: citation URLs funneled through isSafeCitationURL
 *   - F3-06: dedup name-upgrade keeps mention counts and re-evaluates target
 *
 * No network: global.fetch stubbed with OpenRouter-shaped payloads
 * (same pattern as aiTrackerAnalyzerKimi.test.js).
 * Run: node --test tests/aiTracker/unit-analyzer-parsing.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { analyzeResponse } = require('../../src/services/aiTrackerScanEngine');

const AI_RESPONSE =
  'Suparank leads AI-era SEO. Ahrefs is popular too. See [suparank.com](https://suparank.com/blog).';

function orResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 60 },
    }),
  };
}

let origFetch;
let origKey;

beforeEach(() => {
  origFetch = global.fetch;
  origKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
});

afterEach(() => {
  global.fetch = origFetch;
  if (origKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = origKey;
});

function stubContent(content) {
  global.fetch = async () => orResponse(content);
}

describe('analyzeResponse — F3-11 object-shaped brands coercion', () => {
  it('coerces {"0":"A","1":"B"} to an array instead of silently reporting not-mentioned', async () => {
    stubContent(JSON.stringify({
      brands: { 0: 'Suparank', 1: 'Ahrefs' },
      citationUrls: [],
      sentiment: null,
    }));
    const r = await analyzeResponse(AI_RESPONSE, 'best seo tools', 'Suparank', 'suparank.com', null);
    assert.equal(r.mentioned, true, 'target found despite object-shaped brands');
    assert.equal(r.brandRanking.length, 2);
    assert.equal(r.position, 1);
  });

  it('non-coercible brands (string) degrade to empty ranking, not a crash', async () => {
    stubContent(JSON.stringify({ brands: 'Suparank', citationUrls: [], sentiment: null }));
    const r = await analyzeResponse(AI_RESPONSE, 'best seo tools', 'Suparank', 'suparank.com', null);
    // String is typeof 'string', not object → not coerced → empty ranking.
    assert.equal(r.mentioned, false);
    assert.deepEqual(r.brandRanking, []);
    assert.equal(r.position, null);
  });
});

describe('analyzeResponse — F3-09 sentiment label/score consistency', () => {
  it('re-derives the label from the score: {positive, 0} → negative with score 0 preserved', async () => {
    stubContent(JSON.stringify({
      brands: ['Suparank'],
      citationUrls: [],
      sentiment: { label: 'positive', score: 0 },
    }));
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.sentimentScore, 0, 'legitimate 0 must not fall back to 50');
    assert.equal(r.sentiment, 'negative', 'label re-derived from score (<33)');
  });

  it('missing score falls back to 50 → neutral', async () => {
    stubContent(JSON.stringify({
      brands: ['Suparank'],
      citationUrls: [],
      sentiment: { label: 'positive' },
    }));
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.sentimentScore, 50);
    assert.equal(r.sentiment, 'neutral');
  });

  it('boundaries: 66 → positive, 33 → neutral, 32 → negative; out-of-range clamped', async () => {
    const cases = [
      [66, 'positive'],
      [33, 'neutral'],
      [32, 'negative'],
      [150, 'positive'], // clamped to 100
      [-5, 'negative'], // clamped to 0
    ];
    for (const [score, label] of cases) {
      stubContent(JSON.stringify({
        brands: ['Suparank'],
        citationUrls: [],
        sentiment: { label: 'neutral', score },
      }));
      const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
      assert.equal(r.sentiment, label, `score ${score}`);
      assert.ok(r.sentimentScore >= 0 && r.sentimentScore <= 100);
    }
  });

  it('invalid label → sentiment and score both null', async () => {
    stubContent(JSON.stringify({
      brands: ['Suparank'],
      citationUrls: [],
      sentiment: { label: 'ecstatic', score: 90 },
    }));
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.sentiment, null);
    assert.equal(r.sentimentScore, null);
  });
});

describe('analyzeResponse — malformed JSON → _fallbackAnalysis', () => {
  it('prose content falls back: regex mention, null position, target-only ranking', async () => {
    stubContent('The brands I found were Suparank and Ahrefs, both quite prominent.');
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.mentioned, true, 'regex finds the target in the ORIGINAL answer text');
    assert.equal(r.position, null, 'fallback must not fabricate a rank (F3-02)');
    assert.equal(r.sentiment, null);
    assert.ok(r.brandRanking.length <= 1, 'fallback carries at most the target brand');
    assert.ok(r.citedUrls.includes('https://suparank.com/blog'), 'markdown citation recovered');
    assert.equal(r.cited, true);
  });
});

describe('analyzeResponse — F3-08 citation URL safety', () => {
  it('filters private-IP, javascript:, and malformed URLs from the analyzer output', async () => {
    stubContent(JSON.stringify({
      brands: ['Suparank'],
      citationUrls: [
        'https://suparank.com/features',
        'http://10.0.0.1/internal',
        'javascript:alert(1)',
        'http://169.254.169.254/latest/meta-data',
        'not a url',
      ],
      sentiment: null,
    }));
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.deepEqual(r.citedUrls, ['https://suparank.com/features']);
    assert.equal(r.citationCount, 1);
    assert.equal(r.cited, true);
  });
});

describe('analyzeResponse — F3-06 dedup name upgrade', () => {
  it('merges brand variants, keeps the longer name, and sums mention counts', async () => {
    stubContent(JSON.stringify({
      brands: ['Ahrefs', 'Ahrefs Webmaster Tools', 'Ahrefs'],
      citationUrls: [],
      sentiment: null,
    }));
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.brandRanking.length, 1, 'variants merged via isSameBrand');
    assert.equal(r.brandRanking[0].brandName, 'Ahrefs Webmaster Tools', 'longer canonical name kept');
    assert.equal(r.brandRanking[0].mentionCount, 3);
    assert.equal(r.brandRanking[0].isTargetBrand, false, 're-evaluated against the upgraded name');
    assert.equal(r.mentioned, false);
  });
});
