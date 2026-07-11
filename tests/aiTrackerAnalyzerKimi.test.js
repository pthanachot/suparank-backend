/**
 * Phase 3 — AI-tracker analyzer moved from Anthropic-direct Haiku 4.5 to
 * Kimi K2 (moonshotai/kimi-k2-0905) via OpenRouter. This pins the rewritten
 * request shape + OpenRouter/OpenAI response parsing, which the main tracker
 * suite never exercises (it runs the regex fallback with no API key).
 *
 * No network: global.fetch is stubbed to return OpenRouter-shaped payloads.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { analyzeResponse } = require('../src/services/aiTrackerScanEngine');

const AI_RESPONSE =
  'For SEO, Suparank is a strong AI-SEO platform. Ahrefs and Semrush are also popular. ' +
  'See [suparank.com](https://suparank.com/blog) for details.';

// Build a valid OpenRouter/OpenAI chat-completions payload wrapping `content`.
function orResponse(content, { finish = 'stop', pIn = 800, pOut = 60 } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'moonshotai/kimi-k2-0905',
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: pIn, completion_tokens: pOut },
    }),
  };
}

const GOOD_JSON = JSON.stringify({
  brands: ['Suparank', 'Ahrefs', 'Semrush'],
  citationUrls: ['https://suparank.com/blog'],
  sentiment: { label: 'positive', score: 85 },
});

let origFetch, origKey, lastReq;

beforeEach(() => {
  origFetch = global.fetch;
  origKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  lastReq = null;
});
afterEach(() => {
  global.fetch = origFetch;
  if (origKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = origKey;
});

describe('Phase 3: Kimi/OpenRouter tracker analyzer', () => {
  it('calls OpenRouter with Kimi and parses a well-formed response', async () => {
    global.fetch = async (url, opts) => {
      lastReq = { url, opts };
      return orResponse(GOOD_JSON);
    };

    const r = await analyzeResponse(AI_RESPONSE, 'best seo tools', 'Suparank', 'suparank.com', null);

    // Request shape — the actual swap under test.
    assert.equal(lastReq.url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(lastReq.opts.body);
    assert.equal(body.model, 'moonshotai/kimi-k2-0905');
    assert.equal(body.temperature, 0);
    assert.match(lastReq.opts.headers.Authorization, /^Bearer /);

    // Parse — NOT the fallback (fallback returns position null).
    assert.equal(r.mentioned, true);
    assert.equal(typeof r.position, 'number');
    assert.ok(r.brandRanking.some((b) => /suparank/i.test(b.brandName)));
    assert.equal(r.sentiment, 'positive');
    assert.ok(r.sentimentScore >= 80);
    assert.ok(r.citationCount >= 1);
  });

  it('strips a ```json fenced response', async () => {
    global.fetch = async () => orResponse('```json\n' + GOOD_JSON + '\n```');
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.mentioned, true);
    assert.ok(r.brandRanking.length >= 1 && r.brandRanking[0].brandName);
  });

  it('parses a truncated (finish_reason=length) but still-valid JSON', async () => {
    global.fetch = async () => orResponse(GOOD_JSON, { finish: 'length' });
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.mentioned, true); // finish_reason only warns; parse still runs
  });

  it('falls back to regex when OPENROUTER_API_KEY is absent', async () => {
    delete process.env.OPENROUTER_API_KEY;
    let called = false;
    global.fetch = async () => { called = true; return orResponse(GOOD_JSON); };
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(called, false, 'must not hit the network without a key');
    assert.equal(r.position, null); // regex fallback signature
  });

  it('falls back on an OpenRouter error status', async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
    const r = await analyzeResponse(AI_RESPONSE, 'q', 'Suparank', 'suparank.com', null);
    assert.equal(r.position, null); // fallback
  });
});
