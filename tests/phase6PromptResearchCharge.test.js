/**
 * Phase 6 — prompt-research (suggestPrompts) charges ONLY when real AI research
 * was delivered. The no-API-key path and the both-LLM-calls-failed path both
 * fall back to deterministic buildDefaultSuggestions (no model spend) and must
 * NOT bill the 10-credit prompt-research charge. A real suggestion set bills once.
 *
 * creditService.deductForRequest is patched to record calls; global.fetch is
 * stubbed. No DB/network.
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const aiTrackerController = require('../src/controllers/aiTrackerController');
const creditService = require('../src/services/creditService');

const realDeduct = creditService.deductForRequest;
const realFetch = global.fetch;
const realKey = process.env.CHATGPT_API_KEY;
after(() => {
  creditService.deductForRequest = realDeduct;
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.CHATGPT_API_KEY;
  else process.env.CHATGPT_API_KEY = realKey;
});

let deductCalls;
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
// Unique workspace id per test so the in-memory rate limiter never collides.
let wsSeq = 0;
const reqFor = () => ({
  workspace: { _id: `ws_${++wsSeq}` },
  user: { userId: 'u1' },
  body: { domain: 'example.com' },
  creditContext: { deductionEnabled: true, orgId: 'org1', userId: 'u1', workspaceId: 'ws1', estimatedCredits: 10, featureKey: 'promptResearch' },
});

beforeEach(() => {
  deductCalls = [];
  creditService.deductForRequest = async (req, opts) => { deductCalls.push({ req, opts }); return { deducted: 10 }; };
});
afterEach(() => { global.fetch = realFetch; });

describe('suggestPrompts — prompt-research charge guard', () => {
  it('no CHATGPT_API_KEY → default suggestions, NO charge', async () => {
    delete process.env.CHATGPT_API_KEY;
    const r = res();
    await aiTrackerController.suggestPrompts(reqFor(), r);
    assert.ok(Array.isArray(r.body.suggestions) && r.body.suggestions.length > 0, 'still returns defaults');
    assert.equal(deductCalls.length, 0, 'deterministic fallback is never billed');
  });

  it('API key set but both LLM calls fail → default suggestions, NO charge', async () => {
    process.env.CHATGPT_API_KEY = 'sk-test';
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'err', json: async () => ({}) });
    const r = res();
    await aiTrackerController.suggestPrompts(reqFor(), r);
    assert.ok(r.body.suggestions.length > 0, 'falls back to defaults');
    assert.equal(deductCalls.length, 0, 'no AI value delivered → no charge');
  });

  it('API key set + valid AI suggestions → charged exactly once', async () => {
    process.env.CHATGPT_API_KEY = 'sk-test';
    const payload = JSON.stringify({
      suggestions: [{ prompt: 'best seo tools for small business', category: 'industry', reason: 'x' }],
    });
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: payload }] }] }),
      text: async () => payload,
    });
    const r = res();
    await aiTrackerController.suggestPrompts(reqFor(), r);
    assert.ok(r.body.suggestions.some((s) => s.prompt.includes('seo tools')), 'returns the AI suggestions');
    assert.equal(deductCalls.length, 1, 'billed once for real AI research');
  });
});
