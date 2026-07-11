/**
 * Phase A — the analysis-engine client. Pins the contract every call site now
 * depends on: correct host (ENGINE_URL, never WRITING_ENGINE_URL), the
 * X-Internal-Key auth header, the optional model-preset header, JSON body
 * encoding, and a timeout. These are exactly the two things hand-rolled fetches
 * got wrong (dropped key, wrong host), so this test is the backstop.
 *
 * ENGINE_URL is resolved at module load, so we set env + bust the require cache
 * before importing.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ANALYSIS_HOST = 'http://analysis-host:8080';
const WRITING_HOST = 'http://writing-host:9090';

const prevEnv = {
  ENGINE_URL: process.env.ENGINE_URL,
  WRITING_ENGINE_URL: process.env.WRITING_ENGINE_URL,
  ENGINE_INTERNAL_KEY: process.env.ENGINE_INTERNAL_KEY,
};

let engineFetch;
const realFetch = global.fetch;
let calls;

before(() => {
  process.env.ENGINE_URL = ANALYSIS_HOST;
  process.env.WRITING_ENGINE_URL = WRITING_HOST;
  process.env.ENGINE_INTERNAL_KEY = 'test-internal-key';
  // Bust the cache so the module re-reads env for ENGINE_URL / engineHeaders.
  delete require.cache[require.resolve('../src/services/analysisEngine')];
  delete require.cache[require.resolve('../src/services/writingEngine')];
  ({ engineFetch } = require('../src/services/analysisEngine'));
});

after(() => {
  global.fetch = realFetch;
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Restore a clean module state for any later test file in the same process.
  delete require.cache[require.resolve('../src/services/analysisEngine')];
  delete require.cache[require.resolve('../src/services/writingEngine')];
});

beforeEach(() => {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
});

describe('engineFetch', () => {
  it('targets ENGINE_URL, never WRITING_ENGINE_URL', async () => {
    await engineFetch('/api/score', { body: {}, timeoutMs: 1000 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(ANALYSIS_HOST), `expected analysis host, got ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('writing-host'), 'must not hit the writing engine host');
    assert.equal(calls[0].url, `${ANALYSIS_HOST}/api/score`);
  });

  it('injects X-Internal-Key from ENGINE_INTERNAL_KEY', async () => {
    await engineFetch('/api/discover', { body: { keywords: ['x'] }, timeoutMs: 1000 });
    assert.equal(calls[0].opts.headers['X-Internal-Key'], 'test-internal-key');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  });

  it('defaults to POST and JSON-encodes the body', async () => {
    await engineFetch('/api/analyze', { body: { keywords: ['a', 'b'] }, timeoutMs: 1000 });
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { keywords: ['a', 'b'] });
  });

  it('adds X-Model-Preset only when a preset is given', async () => {
    await engineFetch('/api/analyze', { body: {}, preset: 'budget', timeoutMs: 1000 });
    assert.equal(calls[0].opts.headers['X-Model-Preset'], 'budget');

    await engineFetch('/api/analyze', { body: {}, timeoutMs: 1000 });
    assert.equal(calls[1].opts.headers['X-Model-Preset'], undefined);
  });

  it('sets an AbortSignal from timeoutMs', async () => {
    await engineFetch('/api/score', { body: {}, timeoutMs: 1000 });
    assert.ok(calls[0].opts.signal instanceof AbortSignal, 'timeoutMs should produce an AbortSignal');
  });

  it('always bounds the request — a caller that omits timeoutMs still gets a timeout signal', async () => {
    await engineFetch('/api/score', { body: {} }); // no timeoutMs, no signal
    assert.ok(calls[0].opts.signal instanceof AbortSignal, 'must default to a timeout, never unbounded');
  });

  it('prefers an explicit caller signal over the timeout', async () => {
    const ac = new AbortController();
    await engineFetch('/api/score', { body: {}, timeoutMs: 1000, signal: ac.signal });
    assert.equal(calls[0].opts.signal, ac.signal);
  });

  it('omits the body when none is given', async () => {
    await engineFetch('/api/score', { timeoutMs: 1000 });
    assert.equal(calls[0].opts.body, undefined);
  });
});
