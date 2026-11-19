/**
 * QA B32 (Phase 3): one authentication per request, parallel lookups, and a
 * throttled lastActive write.
 *
 * Six routers are mounted on /api/workspace and each runs
 * router.use(authenticateToken). The first pass now records the token it
 * verified on the request; later passes with the same token reuse req.user.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { authenticateToken } = require('../src/middleware/auth');
const { generateAccessToken } = require('../src/utils/jwt');
const User = require('../src/models/User');
const Session = require('../src/models/Session');

const USER_ID = 'a'.repeat(24);
const SESSION_ID = 'c'.repeat(24);
const real = {};
let calls;
let userDoc;
let sessionDoc;
let lastActiveWrites;

beforeEach(() => {
  process.env.ACCESS_TOKEN_SECRET = 'auth-once-secret';
  calls = { user: 0, session: 0, order: [] };
  lastActiveWrites = 0;
  userDoc = { _id: USER_ID, email: 'u@x.co', roles: ['user'], tokenVersion: 1, status: 'active', updateLastActive: () => { lastActiveWrites++; return Promise.resolve(); } };
  sessionDoc = { _id: SESSION_ID, status: 'active' };
  real.uf = User.findById;
  real.sf = Session.findById;
  User.findById = async () => { calls.user++; calls.order.push('user:start'); await new Promise((r) => setTimeout(r, 20)); calls.order.push('user:end'); return userDoc; };
  Session.findById = async () => { calls.session++; calls.order.push('session:start'); await new Promise((r) => setTimeout(r, 20)); calls.order.push('session:end'); return sessionDoc; };
});
afterEach(() => { User.findById = real.uf; Session.findById = real.sf; });

function token(extra = {}) {
  return generateAccessToken({ _id: USER_ID, email: 'u@x.co', roles: ['user'], tokenVersion: 1, ...extra }, SESSION_ID);
}
function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function pass(req) {
  return new Promise((resolve) => {
    const res = mkRes();
    authenticateToken(req, res, () => resolve({ res, nexted: true }));
    // A refusal answers without next(); give the async verify time to run.
    setTimeout(() => resolve({ res, nexted: false }), 200);
  });
}

test('six router passes on one request authenticate once', async () => {
  const req = { headers: { authorization: `Bearer ${token()}` } };
  for (let i = 0; i < 6; i++) {
    const { nexted, res } = await pass(req);
    assert.equal(nexted, true, `pass ${i}`);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(calls.user, 1);
  assert.equal(calls.session, 1);
  assert.equal(lastActiveWrites, 1);
  assert.equal(String(req.user.userId), USER_ID);
});

test('user and session are read in parallel', async () => {
  const req = { headers: { authorization: `Bearer ${token()}` } };
  await pass(req);
  // Both started before either finished.
  assert.deepEqual(calls.order.slice(0, 2).sort(), ['session:start', 'user:start']);
});

test('separate requests each authenticate (nothing leaks across requests)', async () => {
  await pass({ headers: { authorization: `Bearer ${token()}` } });
  await pass({ headers: { authorization: `Bearer ${token()}` } });
  assert.equal(calls.user, 2);
});

test('a different token on the same request is verified from scratch', async () => {
  const req = { headers: { authorization: `Bearer ${token()}` } };
  await pass(req);
  req.headers.authorization = `Bearer ${token({ email: 'other@x.co' })}`;
  await pass(req);
  assert.equal(calls.user, 2);
});

test('refusals still refuse, and leave nothing to reuse', async () => {
  // Revoked session.
  sessionDoc = { _id: SESSION_ID, status: 'ended' };
  const req = { headers: { authorization: `Bearer ${token()}` } };
  const r1 = await pass(req);
  assert.equal(r1.nexted, false);
  assert.equal(r1.res.statusCode, 401);
  assert.match(r1.res.body.error, /revoked/);
  assert.equal(req._authenticatedToken, undefined);
  // Token version bumped (logout everywhere) → 401, user read only.
  sessionDoc = { _id: SESSION_ID, status: 'active' };
  userDoc.tokenVersion = 2;
  const r2 = await pass({ headers: { authorization: `Bearer ${token()}` } });
  assert.equal(r2.res.statusCode, 401);
  // Inactive account.
  userDoc.tokenVersion = 1;
  userDoc.status = 'suspended';
  const r3 = await pass({ headers: { authorization: `Bearer ${token()}` } });
  assert.equal(r3.res.statusCode, 401);
  // A bad token is refused before any lookup.
  const before = calls.user;
  const r4 = await pass({ headers: { authorization: 'Bearer not-a-jwt' } });
  assert.equal(r4.res.statusCode, 401);
  assert.equal(calls.user, before);
});

test('a forged req flag without req.user does not skip verification', async () => {
  const t = token();
  const req = { headers: { authorization: `Bearer ${t}` }, _authenticatedToken: t };
  await pass(req);
  assert.equal(calls.user, 1, 'req.user was absent, so the token was verified');
});

test('a DB error answers 503 as before', async () => {
  Session.findById = async () => { throw new Error('db down'); };
  const r = await pass({ headers: { authorization: `Bearer ${token()}` } });
  assert.equal(r.res.statusCode, 503);
});

// ─── lastActive throttle (model method) ──────────────────────────────

test('updateLastActive writes at most once a minute, as a single-field update', async () => {
  const realUpdateOne = User.updateOne;
  const writes = [];
  User.updateOne = (filter, update) => { writes.push({ filter, update }); return { exec: async () => ({}) }; };
  try {
    const u = new User({ email: 'z@x.co', userId: 123456 });
    await u.updateLastActive();
    await u.updateLastActive(); // within the minute: no write
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].update.$set), ['lastActive']);
    u.lastActive = new Date(Date.now() - User.LAST_ACTIVE_THROTTLE_MS - 1000);
    await u.updateLastActive();
    assert.equal(writes.length, 2);
  } finally {
    User.updateOne = realUpdateOne;
  }
});
