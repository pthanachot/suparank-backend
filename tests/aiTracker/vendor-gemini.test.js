/**
 * Phase 9 review addition — Gemini integration coverage.
 *
 * Gemini appeared in this tier ONLY as the "API key absent" case: no fixture,
 * no scripted reply, and every other test file deletes GEMINI_API_KEY. Its
 * entire response parser — part concatenation, groundingChunks → citations,
 * vertexaisearch redirect resolution, webSearchQueries fanout — and the
 * Gemini-only citation embedder had zero executions anywhere in the suite.
 *
 * That matters more for Gemini than for the other vendors: stored `citedUrls`
 * is re-extracted from markdown links in the answer text, so
 * embedGeminiCitations is the ONLY bridge between Google's structured
 * grounding data and anything the product records. A silent no-op there
 * produces "brand mentioned but never cited" — a wrong metric that raises no
 * error and looks entirely legitimate.
 *
 * Run: node --test tests/aiTracker/vendor-gemini.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const vendorMock = require('./helpers/vendorMock');
const grounded = require('./fixtures/gemini-grounded-clean.json');

process.env.GEMINI_API_KEY = 'test-key';

const engine = require('../../src/services/aiTrackerScanEngine');

/** A grounded reply with the grounding metadata patched. */
function withGrounding(patch) {
  const copy = JSON.parse(JSON.stringify(grounded));
  Object.assign(copy.candidates[0].groundingMetadata, patch);
  return copy;
}

/** Script the two redirect chunks to resolve to real destinations. */
function redirectsResolve(...locations) {
  return locations.map((loc) => ({ status: 302, headers: { location: loc } }));
}

before(() => vendorMock.install());
after(() => vendorMock.uninstall());
beforeEach(() => vendorMock.script({}));

describe('searchGemini — success path (previously untested)', () => {
  it('parses answer, citations and fanout queries', async () => {
    vendorMock.script({
      gemini: [vendorMock.jsonReply(grounded)],
      geminiRedirect: redirectsResolve('https://suparank.com/features', 'https://ahrefs.com/backlinks'),
    });

    const r = await engine.searchGemini('best ai visibility tools', null);
    assert.match(r.answer, /SupaRank leads AI visibility tracking/);
    assert.deepEqual(r.citations.sort(), ['https://ahrefs.com/backlinks', 'https://suparank.com/features']);
    assert.deepEqual(r.fanoutQueries, ['best ai visibility tracking tools', 'suparank vs ahrefs']);
  });

  it('resolves vertexaisearch redirect wrappers to their destinations', async () => {
    vendorMock.script({
      gemini: [vendorMock.jsonReply(grounded)],
      geminiRedirect: redirectsResolve('https://suparank.com/features', 'https://ahrefs.com/backlinks'),
    });
    const r = await engine.searchGemini('q', null);
    for (const url of r.citations) {
      assert.ok(!url.includes('vertexaisearch'), `citation left unresolved: ${url}`);
    }
  });

  it('G2: an UNRESOLVED redirect is dropped, never stored as the Google wrapper', async () => {
    // The wrapper passes the URL safety check but its hostname can never match
    // a tracked domain, so storing it silently turned `cited` into `mentioned`
    // and made citationCount a count of un-attributable redirect wrappers.
    vendorMock.script({
      gemini: [vendorMock.jsonReply(grounded)],
      geminiRedirect: [
        { status: 200, headers: {} },                                   // no Location
        { status: 302, headers: { location: 'https://ahrefs.com/backlinks' } },
      ],
    });
    const r = await engine.searchGemini('q', null);
    assert.deepEqual(r.citations, ['https://ahrefs.com/backlinks']);
    for (const url of r.citations) {
      assert.ok(!url.includes('vertexaisearch'), `wrapper stored as a citation: ${url}`);
    }
  });

  it('G4: an UNSAFE redirect target is dropped, not kept as a safe-looking wrapper', async () => {
    // The residual P8-01 hole: the sanitizer guarded the wrapper, not the
    // target, so a wrapper 302-ing to javascript:/metadata endpoints was
    // embedded as a clickable link.
    vendorMock.script({
      gemini: [vendorMock.jsonReply(grounded)],
      geminiRedirect: [
        { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
        { status: 302, headers: { location: 'https://ahrefs.com/backlinks' } },
      ],
    });
    const r = await engine.searchGemini('q', null);
    assert.deepEqual(r.citations, ['https://ahrefs.com/backlinks']);
    assert.ok(!JSON.stringify(r.citations).includes('169.254'));
  });

  it('G7: a null entry in groundingChunks does not throw', async () => {
    vendorMock.script({
      gemini: [vendorMock.jsonReply(withGrounding({
        groundingChunks: [null, { web: { uri: 'https://suparank.com/features' } }],
        groundingSupports: [],
      }))],
    });
    const r = await engine.searchGemini('q', null);
    assert.deepEqual(r.citations, ['https://suparank.com/features']);
  });

  it('drops unsafe grounding-chunk URIs outright (P8-01 for Gemini)', async () => {
    vendorMock.script({
      gemini: [vendorMock.jsonReply(withGrounding({
        groundingChunks: [
          { web: { uri: 'javascript:alert(1)' } },
          { web: { uri: 'http://169.254.169.254/latest/meta-data/' } },
          { web: { uri: 'https://suparank.com/features' } },
        ],
        groundingSupports: [],
      }))],
    });
    const r = await engine.searchGemini('q', null);
    assert.deepEqual(r.citations, ['https://suparank.com/features']);
  });

  it('tolerates a non-array webSearchQueries', async () => {
    vendorMock.script({
      gemini: [vendorMock.jsonReply(withGrounding({ webSearchQueries: 'not-an-array', groundingSupports: [] }))],
      geminiRedirect: redirectsResolve('https://suparank.com/x', 'https://ahrefs.com/y'),
    });
    const r = await engine.searchGemini('q', null);
    assert.ok(Array.isArray(r.fanoutQueries));
  });
});

describe('G1 — citations survive when inline positioning is impossible', () => {
  const embed = (answer, citations, supports, chunkUrls) =>
    engine.__test.embedGeminiCitations(answer, citations, supports, chunkUrls);

  it('appends a Sources block when groundingSupports is ABSENT', () => {
    // Previously returned the answer unchanged, dropping both citations —
    // and since citedUrls is re-extracted from the answer text, the product
    // recorded zero citations with no error.
    const out = embed('SupaRank is the top pick.', ['https://suparank.com/features'], [], {});
    assert.match(out, /Sources:/);
    assert.match(out, /\]\(https:\/\/suparank\.com\/features\)/);
  });

  it('appends a Sources block when no support yields an insertion', () => {
    const supports = [{ segment: {}, groundingChunkIndices: [0] }]; // no endIndex
    const out = embed('SupaRank is the top pick.', ['https://suparank.com/features'], supports, { 0: 'https://suparank.com/features' });
    assert.match(out, /Sources:/);
  });

  it('never appends an UNSAFE url in the fallback', () => {
    const out = embed('text', ['javascript:alert(1)', 'http://169.254.169.254/'], [], {});
    assert.equal(out, 'text', 'an unsafe URL reached the Sources block');
  });

  it('returns the answer unchanged when there is genuinely nothing to add', () => {
    assert.equal(embed('text', [], [], {}), 'text');
  });

  it('inline positioning still wins when supports ARE usable', () => {
    const out = embed(
      'SupaRank leads.',
      ['https://suparank.com/features'],
      [{ segment: { endIndex: 15 }, groundingChunkIndices: [0] }],
      { 0: 'https://suparank.com/features' },
    );
    assert.match(out, /\]\(https:\/\/suparank\.com\/features\)/);
    assert.ok(!out.includes('Sources:'), 'fell back to Sources despite a usable inline position');
  });

  it('G3: an out-of-range segment offset cannot throw or truncate the answer', () => {
    const answer = 'Short answer.';
    const out = embed(
      answer,
      ['https://suparank.com/features'],
      [{ segment: { endIndex: 99999 }, groundingChunkIndices: [0] }],
      { 0: 'https://suparank.com/features' },
    );
    assert.ok(out.startsWith('Short answer.'), `answer was mangled: ${out}`);
    assert.match(out, /suparank\.com/);
  });
});

describe('G5 — blocked and truncated responses are reported, not retried blindly', () => {
  it('a prompt-level block surfaces its reason', async () => {
    vendorMock.script({ gemini: [vendorMock.jsonReply({ promptFeedback: { blockReason: 'SAFETY' } })] });
    await assert.rejects(
      () => engine.searchGemini('q', null),
      (err) => {
        assert.match(err.message, /SAFETY/, `generic message hid the reason: ${err.message}`);
        return true;
      },
    );
  });

  it('a candidate-level SAFETY finish is NOT retried (one call, not three)', async () => {
    vendorMock.script({
      gemini: [{ ...vendorMock.jsonReply({ candidates: [{ finishReason: 'SAFETY', content: {} }] }), repeat: true }],
    });
    await assert.rejects(() => engine.searchGemini('q', null));
    const calls = vendorMock.calls.filter((c) => c.vendor === 'gemini').length;
    assert.equal(calls, 1, `a deterministic refusal was retried ${calls} times, paying each attempt`);
  });

  it('a genuinely empty response still reports the generic message', async () => {
    vendorMock.script({ gemini: [vendorMock.jsonReply({ candidates: [] })] });
    await assert.rejects(() => engine.searchGemini('q', null), /empty response/);
  });
});
