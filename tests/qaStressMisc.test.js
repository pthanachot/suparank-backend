/**
 * QA Nov 2026 stress pass — rate limiter (N2/B36), analysis error
 * classification (B09/B40), thread DTO (B43/N3), /health config status (N5)
 * and curateBenchmark averages (B41). No DB, no network beyond 127.0.0.1.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');

const { buildApiLimiter, rateLimitIdentity, maxFor, USER_DEFAULT_MAX, IP_DEFAULT_MAX } = require('../src/middleware/apiRateLimit');
const systemSettingsService = require('../src/services/systemSettingsService');
const SystemSettings = require('../src/models/SystemSettings');

const SECRET = 'qa-stress-secret';

async function withApp({ hops = 1, settings = {}, before } = {}, fn) {
  const savedSecret = process.env.ACCESS_TOKEN_SECRET;
  process.env.ACCESS_TOKEN_SECRET = SECRET;
  const app = express();
  app.set('trust proxy', hops);
  // Mirrors index.js: Stripe webhooks are mounted BEFORE the /api/ limiter.
  app.post('/api/billing/webhooks', (_req, res) => res.json({ received: true }));
  if (before) before(app);
  app.use('/api/', buildApiLimiter(() => ({ rateLimit: { windowMs: 60000, ...settings } })));
  app.get('/api/ping', (req, res) => res.json({ key: rateLimitIdentity(req).key }));
  app.get('/api/internal/cfs/x', (_req, res) => res.json({ ok: true }));
  app.get('/api/notifications/feed', (_req, res) => res.json({ ok: true }));
  app.get('/api/workspace/1/content/2/ai/autocomplete', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn((path, headers = {}, method = 'GET') => fetch(`${base}${path}`, { method, headers }));
  } finally {
    server.close();
    if (savedSecret === undefined) delete process.env.ACCESS_TOKEN_SECRET; else process.env.ACCESS_TOKEN_SECRET = savedSecret;
  }
}

const tok = (payload, opts = {}, secret = SECRET) => `Bearer ${jwt.sign(payload, secret, { expiresIn: '1h', ...opts })}`;

test('limiter: X-Forwarded-For with one trusted hop keys on the LAST entry; a spoofed leftmost entry is ignored', async () => {
  await withApp({ hops: 1, settings: { ipMax: 2 } }, async (hit) => {
    const k = async (xff) => (await (await hit('/api/ping', { 'x-forwarded-for': xff })).json()).key;
    assert.equal(await k('6.6.6.6, 198.51.100.7'), 'ip:198.51.100.7');
    assert.equal(await k('1.2.3.4, 198.51.100.7'), 'ip:198.51.100.7', 'rotating the spoofed entry does not mint a new bucket');
    const third = await hit('/api/ping', { 'x-forwarded-for': '9.9.9.9, 198.51.100.7' });
    assert.equal(third.status, 429, 'same real client, bucket exhausted');
  });
});

test('limiter: TRUST_PROXY_HOPS=2 keys on the second entry from the right', async () => {
  await withApp({ hops: 2 }, async (hit) => {
    const r = await hit('/api/ping', { 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 10.0.0.1' });
    assert.equal((await r.json()).key, 'ip:203.0.113.5');
  });
});

test('limiter: with NO X-Forwarded-For every anonymous caller shares the proxy socket bucket', async () => {
  // This is what production looks like if the Next proxy does not forward the
  // client address: all anonymous traffic (login, signup) shares ipMax.
  await withApp({ hops: 1 }, async (hit) => {
    const r = await hit('/api/ping');
    assert.match((await r.json()).key, /^ip:(::ffff:)?127\.0\.0\.1$/);
  });
});

test('limiter: forged / wrong-secret / expired / HS512 / lowercase-bearer tokens fall back to the IP bucket', async () => {
  await withApp({ settings: { max: 50, ipMax: 1 } }, async (hit) => {
    const bad = [
      tok({ userId: 'victim' }, {}, 'not-the-secret'),
      tok({ userId: 'x' }, { expiresIn: -10 }),
      `Bearer ${jwt.sign({ userId: 'x' }, SECRET, { algorithm: 'HS512' })}`,
      `bearer ${jwt.sign({ userId: 'x' }, SECRET)}`,
      'Bearer ',
      'Basic dXNlcjpwYXNz',
    ];
    const first = await hit('/api/ping', { authorization: bad[0], 'x-forwarded-for': '198.51.100.20' });
    assert.equal((await first.json()).key, 'ip:198.51.100.20');
    for (const h of bad.slice(1)) {
      const r = await hit('/api/ping', { authorization: h, 'x-forwarded-for': '198.51.100.20' });
      assert.equal(r.status, 429, `${h.slice(0, 20)}… must share the exhausted IP bucket`);
    }
    // A valid token for the same client IP is its own user bucket.
    const ok = await hit('/api/ping', { authorization: tok({ userId: 'real' }), 'x-forwarded-for': '198.51.100.20' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).key, 'u:real');
  });
});

test('limiter: 429 is JSON {error, message, retryAfter} with a matching Retry-After header', async () => {
  await withApp({ settings: { ipMax: 1 } }, async (hit) => {
    await hit('/api/ping', { 'x-forwarded-for': '198.51.100.30' });
    const r = await hit('/api/ping', { 'x-forwarded-for': '198.51.100.30' });
    assert.equal(r.status, 429);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'retryAfter']);
    assert.equal(body.error, 'rate_limited');
    assert.ok(Number.isInteger(body.retryAfter) && body.retryAfter >= 1 && body.retryAfter <= 60);
    assert.equal(r.headers.get('retry-after'), String(body.retryAfter));
    assert.doesNotMatch(body.message, /—/);
  });
});

test('limiter: exempt paths are never counted (webhooks, internal, bell, autocomplete, /health)', async () => {
  await withApp({ settings: { ipMax: 1, max: 1 } }, async (hit) => {
    const h = { 'x-forwarded-for': '198.51.100.40' };
    for (let i = 0; i < 4; i++) {
      assert.equal((await hit('/api/billing/webhooks', h, 'POST')).status, 200, 'Stripe webhook');
      assert.equal((await hit('/api/internal/cfs/x', h)).status, 200, 'internal');
      assert.equal((await hit('/api/notifications/feed', h)).status, 200, 'bell');
      assert.equal((await hit('/api/workspace/1/content/2/ai/autocomplete', h)).status, 200, 'autocomplete');
      assert.equal((await hit('/health', h)).status, 200, 'health');
    }
    assert.equal((await hit('/api/ping', h)).status, 200, 'the bucket was untouched by all of the above');
  });
});

test('limiter: admin max and ipMax are independent; unset falls back to the env defaults', () => {
  const u = { headers: { authorization: tok({ userId: 'a' }) }, ip: '1.1.1.1' };
  const a = { headers: {}, ip: '1.1.1.1' };
  rateLimitIdentity(u, SECRET); rateLimitIdentity(a, SECRET);
  assert.equal(maxFor(u, { rateLimit: { max: null, ipMax: 7 } }), USER_DEFAULT_MAX);
  assert.equal(maxFor(a, { rateLimit: { max: 5000, ipMax: null } }), IP_DEFAULT_MAX);
  assert.equal(maxFor(u, { rateLimit: { max: 5000, ipMax: 7 } }), 5000);
  assert.equal(maxFor(a, { rateLimit: { max: 5000, ipMax: 7 } }), 7);
  assert.equal(maxFor(a, undefined), IP_DEFAULT_MAX);
});

test('settings: rateLimit.ipMax survives the schema and the cache (admin override is reachable)', async () => {
  const doc = new SystemSettings({ key: 'global', rateLimit: { max: 900, ipMax: 120 } });
  assert.equal(doc.rateLimit.ipMax, 120, 'not stripped by strict mode');
  const savedFind = SystemSettings.findOneAndUpdate;
  SystemSettings.findOneAndUpdate = () => ({ lean: async () => doc.toObject() });
  try {
    await systemSettingsService.loadSettings();
    assert.equal(systemSettingsService.getSettings().rateLimit.ipMax, 120);
    assert.equal(systemSettingsService.getSettings().rateLimit.max, 900);
  } finally {
    SystemSettings.findOneAndUpdate = savedFind;
    SystemSettings.findOneAndUpdate = () => ({ lean: async () => ({}) });
    await systemSettingsService.loadSettings(); // back to defaults for later tests
    SystemSettings.findOneAndUpdate = savedFind;
  }
});

test('TRUST_PROXY_HOPS parsing in index.js: default 1, non-negative integers only', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  const m = /const TRUST_PROXY_HOPS = \(\(\) => \{([\s\S]*?)\}\)\(\);/.exec(src);
  assert.ok(m, 'parser block present');
  // eslint-disable-next-line no-new-func
  const parse = (v) => {
    const saved = process.env.TRUST_PROXY_HOPS;
    if (v === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = v;
    try { return new Function(m[1])(); } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = saved;
    }
  };
  assert.equal(parse(undefined), 1);
  assert.equal(parse(''), 1);
  assert.equal(parse('abc'), 1);
  assert.equal(parse('-1'), 1);
  assert.equal(parse('2'), 2);
  assert.equal(parse('0'), 0);
  assert.match(src, /app\.set\('trust proxy', TRUST_PROXY_HOPS\)/);
});

// ─── analysis error classification ─────────────────────────────

const { classifyAnalysisFailure, failureFields, presentAnalysisError, ANALYSIS_ERROR_CODES } = require('../src/services/analysisErrors');

test('classification: our-side failures are free, content problems are not', () => {
  const cases = [
    ['Engine returned 502: openrouter returned status 401: {"error":{"message":"User not found."}}', 'provider_auth', true],
    ['Engine returned 500: need OPENROUTER_API_KEY', 'provider_auth', true],
    ['Engine returned 429: Too Many Requests', 'provider_rate_limited', true],
    ['Engine returned 502: openrouter returned status 402: requires more credits', 'provider_rate_limited', true],
    ['Engine returned 503: analyze capacity reached, retry shortly', 'engine_busy', true],
    ['The operation was aborted due to timeout', 'engine_timeout', true],
    ['context deadline exceeded', 'engine_timeout', true],
    ['fetch failed', 'engine_unavailable', true],
    ['connect ECONNREFUSED 127.0.0.1:8080', 'engine_unavailable', true],
    ['Engine returned 502: Bad Gateway', 'server_error', true],
    ['Engine returned 502: SERP fetch failed', 'server_error', true],
    ['Analysis interrupted by server restart', 'server_restart', true],
    ['job lost', 'server_restart', true],
    ['Engine returned 502: no SERP results for keyword', 'no_serp_results', false],
    ['Engine returned 502: could not crawl any competitor page (fetch failed with status 403)', 'no_sources', false],
    ['Engine returned 400: invalid request body', 'invalid_request', false],
    // QA B40 follow-up: an unclassifiable failure is ours, so a free retry.
    ['something odd', 'unknown', true],
    ['', 'unknown', true],
  ];
  for (const [msg, code, free] of cases) {
    assert.equal(classifyAnalysisFailure(msg), code, msg);
    assert.equal(ANALYSIS_ERROR_CODES[code].retryFree, free, msg);
  }
  for (const v of [null, undefined, 42, {}, new Error('x')]) assert.equal(typeof classifyAnalysisFailure(v), 'string');
});

test('failure fields never carry the raw text; copy has no em dashes or internals', () => {
  const raw = 'Engine returned 502: openrouter returned status 401: {"error":"sk-or-v1-abc"} at /srv/engine.go:42';
  const f = failureFields(raw);
  assert.doesNotMatch(JSON.stringify(f), /sk-or|engine\.go|openrouter|502/);
  for (const [code, spec] of Object.entries(ANALYSIS_ERROR_CODES)) {
    assert.doesNotMatch(spec.message, /—|engine|OpenRouter|SERP|CFS/i, code);
  }
  assert.equal(failureFields('x', 'not-a-code').analysisErrorCode, 'unknown', 'a bogus forced code is ignored');
});

test('presentAnalysisError: legacy raw rows are presented, not echoed; legacy transient stays free', () => {
  const legacy = presentAnalysisError({ analysisStatus: 'failed', analysisError: 'Engine returned 500: panic: runtime error at main.go' });
  assert.equal(legacy.analysisErrorCode, 'server_error');
  assert.doesNotMatch(JSON.stringify(legacy), /panic|main\.go/);
  const legacyTransient = presentAnalysisError({ analysisStatus: 'failed', analysisError: 'transient: weird new thing' });
  assert.equal(legacyTransient.analysisRetryFree, true);
  const notFailed = presentAnalysisError({ analysisStatus: 'ready', analysisError: 'stale raw text' });
  assert.deepEqual(notFailed, { analysisError: '', analysisErrorCode: '', analysisErrorMessage: '', analysisRetryFree: false });
  const forgedCode = presentAnalysisError({ analysisStatus: 'failed', analysisErrorCode: '__proto__', analysisError: 'fetch failed' });
  assert.equal(forgedCode.analysisErrorCode, 'engine_unavailable');
});

// ─── thread DTO ────────────────────────────────────────────────

const { toClientThreadMessage } = require('../src/services/threadService');

test('thread DTO: ObjectId authors compare to string viewers; nothing outside the allowlist leaks', () => {
  const author = new mongoose.Types.ObjectId();
  const row = {
    seq: 1, kind: 'user', text: 'ENGINEERED PROMPT', displayText: '/facts', createdAt: new Date(0),
    meta: { userId: author, channel: 'steer', applied: true, model: 'm', tokensIn: 1, tokensOut: 2, costUsd: 3, coversThroughSeq: 9, runId: 'r' },
    _id: 'internal', threadId: 'thread-internal', contentId: 'content-internal',
  };
  const dto = toClientThreadMessage(row, String(author));
  assert.equal(dto.mine, true);
  assert.deepEqual(Object.keys(dto).sort(), ['createdAt', 'displayText', 'kind', 'meta', 'mine', 'seq', 'text']);
  assert.deepEqual(dto.meta, { channel: 'steer', applied: true, runId: 'r' });
  assert.equal(toClientThreadMessage(row, null).mine, false, 'anonymous viewer is never "mine"');
  assert.equal(toClientThreadMessage({ ...row, meta: { ...row.meta, userId: null } }, 'null').mine, false);
  assert.equal(toClientThreadMessage({ ...row, meta: undefined }, 'u').text, '/facts');
});

test('thread DTO: a shared thread shows a collaborator the same text (sharing still works)', () => {
  const row = { seq: 2, kind: 'assistant', text: 'Here is the reply.', meta: { userId: 'author' } };
  assert.equal(toClientThreadMessage(row, 'someone-else').text, 'Here is the reply.');
});

// ─── /health config status ─────────────────────────────────────

test('configStatus: booleans only; whitespace-only values count as missing; no value echoes', () => {
  const { configStatus } = require('../src/config/configStatus');
  const keys = ['OPENROUTER_API_KEY', 'INTERNAL_API_KEY', 'EXPRESS_INTERNAL_BASE_URL', 'PUBLIC_BASE_URL', 'STRIPE_SECRET_KEY', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APP_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.OPENROUTER_API_KEY = 'sk-or-SECRET';
    process.env.INTERNAL_API_KEY = '   ';
    delete process.env.EXPRESS_INTERNAL_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://internal.host.example';
    process.env.STRIPE_SECRET_KEY = 'sk_live_SECRET';
    process.env.B2_BUCKET = 'b'; process.env.B2_KEY_ID = 'k'; delete process.env.B2_APP_KEY;
    const st = configStatus();
    const json = JSON.stringify(st);
    assert.doesNotMatch(json, /SECRET|internal\.host|sk_/);
    for (const v of Object.values(st)) assert.equal(typeof v, 'boolean');
    assert.equal(st.internalApiKeyConfigured, false);
    assert.equal(st.cfsBaseUrlConfigured, true);
    assert.equal(st.cfsBaseUrlIsDefault, false);
    assert.equal(st.imageStorageConfigured, false, 'all three B2 values are needed');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ─── curateBenchmark averages ──────────────────────────────────

test('curateBenchmark: missing, zero, negative, NaN, Infinity and string stats all read as 0 or the number', () => {
  const { curateBenchmark } = require('../src/controllers/analysisController')._curators;
  const at = (v) => curateBenchmark({ keyword: 'k', competitor_stats: { avg_title_length: v, avg_desc_length: v, avg_sentence_length: v } });
  for (const v of [undefined, null, 0, -3, NaN, 'abc', {}, [], Infinity]) {
    const b = at(v);
    assert.equal(b.avgTitleLength, 0, String(v));
    assert.equal(b.avgDescLength, 0, String(v));
    assert.equal(b.avgSentenceLength, 0, String(v));
  }
  assert.equal(at('61.5').avgTitleLength, 61.5);
  const noStats = curateBenchmark({ keyword: 'k' });
  assert.equal(noStats.avgTitleLength, 0);
  assert.equal(curateBenchmark(null), null);
});
