/**
 * QA Nov 2026 (N2, B36) — per-user /api/ limiter keying, ceilings, JSON 429,
 * plus the B41 benchmark averages (small, unrelated, kept here to avoid a
 * one-assertion file).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');

const SECRET = 'test-secret-for-limiter';
const {
  rateLimitIdentity, maxFor, makeHandler, skip, buildApiLimiter, USER_DEFAULT_MAX, IP_DEFAULT_MAX,
} = require('../src/middleware/apiRateLimit');

const req = (headers = {}, ip = '203.0.113.9') => ({ headers, ip });
const bearer = (payload, opts = {}, secret = SECRET) => ({ authorization: `Bearer ${jwt.sign(payload, secret, { expiresIn: '1h', ...opts })}` });

test('a valid access token keys by user id', () => {
  const id = rateLimitIdentity(req(bearer({ userId: 'abc123' })), SECRET);
  assert.deepEqual(id, { key: 'u:abc123', kind: 'user' });
});

test('two users behind the same IP get separate buckets', () => {
  const a = rateLimitIdentity(req(bearer({ userId: 'a' })), SECRET).key;
  const b = rateLimitIdentity(req(bearer({ userId: 'b' })), SECRET).key;
  assert.notEqual(a, b);
});

test('unverifiable tokens never key by their claimed user: forged, expired, wrong alg, none', () => {
  const forged = rateLimitIdentity(req(bearer({ userId: 'victim' }, {}, 'other-secret')), SECRET);
  assert.deepEqual(forged, { key: 'ip:203.0.113.9', kind: 'ip' });
  const expiredTok = jwt.sign({ userId: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
  const expired = rateLimitIdentity(req({ authorization: `Bearer ${expiredTok}` }), SECRET);
  assert.equal(expired.kind, 'ip');
  const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"userId":"victim"}').toString('base64url')}.`;
  assert.equal(rateLimitIdentity(req({ authorization: `Bearer ${unsigned}` }), SECRET).kind, 'ip');
  assert.equal(rateLimitIdentity(req({ authorization: 'Bearer garbage' }), SECRET).kind, 'ip');
  assert.equal(rateLimitIdentity(req({}), SECRET).kind, 'ip');
  assert.equal(rateLimitIdentity(req(bearer({ email: 'no-user-id' })), SECRET).kind, 'ip', 'a token without userId is not a user');
});

test('no secret configured → IP keying (fail safe)', () => {
  assert.equal(rateLimitIdentity(req(bearer({ userId: 'a' })), '').kind, 'ip');
});

test('identity is memoised per request', () => {
  const r = req(bearer({ userId: 'm' }));
  const first = rateLimitIdentity(r, SECRET);
  assert.equal(rateLimitIdentity(r, 'different'), first);
});

test('ceilings: per-user default, per-IP default, admin overrides', () => {
  const u = req(bearer({ userId: 'a' })); rateLimitIdentity(u, SECRET);
  const ip = req({}); rateLimitIdentity(ip, SECRET);
  assert.equal(maxFor(u, {}), USER_DEFAULT_MAX);
  assert.equal(maxFor(ip, {}), IP_DEFAULT_MAX);
  assert.ok(USER_DEFAULT_MAX > IP_DEFAULT_MAX, 'an editor needs more than an anonymous client');
  assert.equal(maxFor(u, { rateLimit: { max: 900 } }), 900, 'rateLimit.max overrides the per-user bucket');
  assert.equal(maxFor(ip, { rateLimit: { max: 900 } }), IP_DEFAULT_MAX, 'and does not loosen the IP bucket');
  assert.equal(maxFor(ip, { rateLimit: { ipMax: 50 } }), 50);
});

test('429 body and Retry-After header', () => {
  const headers = {};
  let status; let body;
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status: (c) => { status = c; return res; },
    json: (b) => { body = b; return res; },
  };
  makeHandler(900000)({ rateLimit: { resetTime: new Date(Date.now() + 30500) } }, res);
  assert.equal(status, 429);
  assert.equal(body.error, 'rate_limited');
  assert.equal(typeof body.message, 'string');
  assert.doesNotMatch(body.message, /—/);
  assert.ok(body.retryAfter >= 30 && body.retryAfter <= 31, String(body.retryAfter));
  assert.equal(headers['Retry-After'], String(body.retryAfter));
});

test('skip list is unchanged: internal, notifications, observe, autocomplete', () => {
  assert.equal(skip({ originalUrl: '/api/internal/cfs/1/2/read' }), true);
  assert.equal(skip({ originalUrl: '/api/notifications/feed' }), true);
  assert.equal(skip({ originalUrl: '/api/observe' }), true);
  assert.equal(skip({ originalUrl: '/api/workspace/1/content/2/ai/autocomplete' }), true);
  assert.equal(skip({ originalUrl: '/api/workspace/1/content/2' }), false);
});

test('end to end: a user bucket fills independently of another user on the same IP', async () => {
  const saved = process.env.ACCESS_TOKEN_SECRET;
  process.env.ACCESS_TOKEN_SECRET = SECRET;
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/', buildApiLimiter(() => ({ rateLimit: { max: 2, ipMax: 1, windowMs: 60000 } })));
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokA = bearer({ userId: 'A' }).authorization;
  const tokB = bearer({ userId: 'B' }).authorization;
  try {
    const hit = (h) => fetch(`${base}/api/ping`, { headers: h });
    assert.equal((await hit({ authorization: tokA })).status, 200);
    assert.equal((await hit({ authorization: tokA })).status, 200);
    const limited = await hit({ authorization: tokA });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await limited.json()).error, 'rate_limited');
    assert.equal((await hit({ authorization: tokB })).status, 200, 'user B is unaffected');
    // Anonymous: keyed by the client IP the Next hop forwarded.
    assert.equal((await hit({ 'x-forwarded-for': '198.51.100.1' })).status, 200);
    assert.equal((await hit({ 'x-forwarded-for': '198.51.100.1' })).status, 429);
    assert.equal((await hit({ 'x-forwarded-for': '198.51.100.2' })).status, 200, 'a different client IP has its own bucket');
  } finally {
    server.close();
    if (saved === undefined) delete process.env.ACCESS_TOKEN_SECRET; else process.env.ACCESS_TOKEN_SECRET = saved;
  }
});

test('B41: benchmark reads title/description/sentence averages, 0 when absent', () => {
  const { curateBenchmark } = require('../src/controllers/analysisController')._curators;
  const withStats = curateBenchmark({ keyword: 'k', competitor_stats: { avg_title_length: 58.5, avg_desc_length: 151, avg_sentence_length: 17.2 } });
  assert.equal(withStats.avgTitleLength, 58.5);
  assert.equal(withStats.avgDescLength, 151);
  assert.equal(withStats.avgSentenceLength, 17.2);
  const old = curateBenchmark({ keyword: 'k', competitor_stats: {} });
  assert.equal(old.avgTitleLength, 0);
  assert.equal(old.avgDescLength, 0);
  assert.equal(old.avgSentenceLength, 0);
  assert.equal(curateBenchmark({ competitor_stats: { avg_title_length: 'NaN' } }).avgTitleLength, 0);
});

test('N5: /health config status is booleans only and never echoes a value', () => {
  const { configStatus } = require('../src/config/configStatus');
  const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, INTERNAL_API_KEY: process.env.INTERNAL_API_KEY };
  process.env.OPENROUTER_API_KEY = 'sk-or-secret-value';
  delete process.env.INTERNAL_API_KEY;
  try {
    const st = configStatus();
    for (const [k, v] of Object.entries(st)) assert.equal(typeof v, 'boolean', k);
    assert.equal(st.openRouterKeyConfigured, true);
    assert.equal(st.internalApiKeyConfigured, false);
    assert.doesNotMatch(JSON.stringify(st), /sk-or-secret-value/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
