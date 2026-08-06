/**
 * Phase 9 review addition — unit tests for the live-smoke verify() predicates.
 *
 * The smoke script is the ONLY detector for a silently-degraded vendor, and it
 * had no tests. That is how it came to contain probes that cannot detect their
 * own stated failure:
 *   - every AI probe checked `Array.isArray(citations)`, but the engine builds
 *     `const citations = []` unconditionally, so the check was DEAD CODE and a
 *     vendor returning zero citations passed as healthy;
 *   - the ChatGPT probe ignored `fanoutUnavailable`/`modelVariant`, so the
 *     Responses→ChatCompletions fallback (i.e. "the model was deprecated",
 *     the script's stated purpose #1) was invisible;
 *   - the location-code probe checked only that a code EXISTS in DataForSEO's
 *     list, never that it denotes the country we think — the exact failure its
 *     own comment describes.
 *
 * These run against fixtures. No network, no keys, nothing billed: requiring
 * the script does not execute main().
 *
 * Run: node --test tests/aiTracker/smoke-probes.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PROBES } = require('../../scripts/smokeVendors');

const byId = (id) => {
  const p = PROBES.find((x) => x.id === id);
  assert.ok(p, `probe '${id}' not found — was it renamed or removed?`);
  return p;
};

const goodAnswer = 'SupaRank leads AI visibility tracking; Ahrefs is strong for backlinks.';

describe('smoke probes — the surface is complete', () => {
  it('covers all six vendors plus the location-code check', () => {
    const ids = PROBES.map((p) => p.id).sort();
    assert.deepEqual(ids, [
      'analyzer(kimi)', 'chatgpt', 'claude', 'dataforseo',
      'dataforseo-location-codes', 'gemini', 'perplexity', 'serper',
    ].sort());
  });

  it('every probe declares a key and a verify function', () => {
    for (const p of PROBES) {
      assert.ok(p.key, `${p.id}: no key declared`);
      assert.equal(typeof p.verify, 'function', `${p.id}: no verify()`);
      assert.equal(typeof p.run, 'function', `${p.id}: no run()`);
    }
  });
});

describe('AI vendor probes reject the real drift signatures', () => {
  const AI = ['chatgpt', 'gemini', 'claude', 'perplexity'];

  it('a healthy response passes', () => {
    for (const id of AI) {
      const healthy = {
        answer: goodAnswer,
        citations: ['https://suparank.com/features'],
        fanoutQueries: ['best ai visibility tools'],
      };
      assert.equal(byId(id).verify(healthy), null, `${id}: rejected a healthy response`);
    }
  });

  it('an empty answer is drift', () => {
    for (const id of AI) {
      assert.ok(byId(id).verify({ answer: '   ', citations: ['x'], fanoutQueries: [] }), `${id}`);
      assert.ok(byId(id).verify(null), `${id}: null result`);
    }
  });

  it('ZERO citations is drift — the check used to be dead code', () => {
    for (const id of AI) {
      const problem = byId(id).verify({ answer: goodAnswer, citations: [], fanoutQueries: ['q'] });
      assert.ok(problem, `${id}: an empty citations array passed as healthy`);
      assert.match(problem, /citation/i, `${id}: unexpected message "${problem}"`);
    }
  });

  it('a missing citations field is drift', () => {
    for (const id of AI) {
      assert.ok(byId(id).verify({ answer: goodAnswer, fanoutQueries: [] }), `${id}`);
    }
  });
});

describe('chatgpt probe detects the silent API-ladder fallback', () => {
  const base = { answer: goodAnswer, citations: ['https://suparank.com'], fanoutQueries: ['q'] };

  it('flags fanoutUnavailable (Responses API rejected us)', () => {
    const problem = byId('chatgpt').verify({ ...base, fanoutUnavailable: true });
    assert.ok(problem, 'the fallback ladder passed as healthy');
    assert.match(problem, /FELL BACK/i);
  });

  it('flags a -fallback model variant', () => {
    const problem = byId('chatgpt').verify({
      ...base, modelVariant: 'gpt-4o-mini-search-preview-fallback',
    });
    assert.ok(problem, 'a fallback model variant passed as healthy');
    assert.match(problem, /fallback model variant/i);
  });

  it('accepts the normal model variant', () => {
    assert.equal(byId('chatgpt').verify({ ...base, modelVariant: 'gpt-4o-mini-search-preview' }), null);
  });

  it('flags an empty fanout list (web_search may not have run)', () => {
    assert.ok(byId('chatgpt').verify({ ...base, fanoutQueries: [] }));
  });
});

describe('gemini probe detects unresolved grounding redirects (G2)', () => {
  it('flags a citation left as the Google redirect wrapper', () => {
    const problem = byId('gemini').verify({
      answer: goodAnswer,
      citations: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123'],
    });
    assert.ok(problem, 'an unresolved redirect wrapper passed as a healthy citation');
    assert.match(problem, /redirect/i);
  });

  it('accepts fully resolved citations', () => {
    assert.equal(
      byId('gemini').verify({ answer: goodAnswer, citations: ['https://suparank.com/features'] }),
      null,
    );
  });
});

describe('analyzer probe detects the regex fallback (the P9-01 fingerprint)', () => {
  const p = byId('analyzer(kimi)');

  it('accepts a real analysis', () => {
    assert.equal(p.verify({ mentioned: true, brandRanking: ['SupaRank', 'Ahrefs'], position: 1 }), null);
  });

  it('flags an empty brandRanking on a control answer', () => {
    const problem = p.verify({ mentioned: true, brandRanking: [], position: 1 });
    assert.ok(problem);
    assert.match(problem, /REGEX/i);
  });

  it('flags a null position', () => {
    assert.ok(p.verify({ mentioned: true, brandRanking: ['SupaRank'], position: null }));
  });

  it('flags the target brand going undetected', () => {
    assert.ok(p.verify({ mentioned: false, brandRanking: ['SupaRank'], position: 1 }));
  });
});

describe('keyword probes', () => {
  it('dataforseo rejects an all-zero metric set (field rename fingerprint)', () => {
    const problem = byId('dataforseo').verify({
      related: [
        { keyword: 'a', searchVolume: 0, keywordDifficulty: 0, cpc: 0, monthlySearches: [] },
        { keyword: 'b', searchVolume: 0, keywordDifficulty: 0, cpc: 0, monthlySearches: [] },
      ],
    });
    assert.ok(problem);
    assert.match(problem, /rename|0/i);
  });

  it('dataforseo accepts a normal payload', () => {
    assert.equal(byId('dataforseo').verify({
      related: [{ keyword: 'a', searchVolume: 1200, keywordDifficulty: 42, cpc: 2.4, monthlySearches: [1, 2] }],
    }), null);
  });

  it('serper requires a derived domain and a PAA array', () => {
    const ok = { organic: [{ title: 't', link: 'https://x.com/a', domain: 'x.com' }], peopleAlsoAsk: [] };
    assert.equal(byId('serper').verify(ok), null);
    assert.ok(byId('serper').verify({ ...ok, organic: [{ title: 't', link: 'https://x.com/a' }] }));
    assert.ok(byId('serper').verify({ organic: [], peopleAlsoAsk: [] }));
  });
});

describe('location-code probe detects a code pointing at the WRONG country (F9)', () => {
  const p = byId('dataforseo-location-codes');

  it('accepts codes whose published name matches ours', () => {
    assert.equal(p.verify({
      published: new Map([[2840, 'United States'], [2826, 'United Kingdom']]),
      ours: {
        US: { locationCode: 2840, locationName: 'United States' },
        GB: { locationCode: 2826, locationName: 'United Kingdom' },
      },
    }), null);
  });

  it('flags a code that is not published at all', () => {
    const problem = p.verify({
      published: new Map([[2840, 'United States']]),
      ours: { CN: { locationCode: 2156, locationName: 'China' } },
    });
    assert.ok(problem);
    assert.match(problem, /not published/i);
  });

  it('flags a code that EXISTS but denotes a different country', () => {
    // The failure the probe's own comment describes and previously could not
    // detect: DataForSEO happily returns data for the wrong market.
    const problem = p.verify({
      published: new Map([[2840, 'Canada']]),
      ours: { US: { locationCode: 2840, locationName: 'United States' } },
    });
    assert.ok(problem, 'a wrong-country code passed as valid');
    assert.match(problem, /WRONG COUNTRY/i);
  });

  it('fails when the published list could not be read', () => {
    assert.ok(p.verify({ published: new Map(), ours: {} }));
  });
});
