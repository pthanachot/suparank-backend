const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { internalAuth, safeEqual } = require('../src/middleware/internalAuth');

// Mock req/res helpers (no Express dep)
function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
  return res;
}

function callMiddleware({ key, prevKey, header }) {
  const prevEnvKey = process.env.INTERNAL_API_KEY;
  const prevEnvPrev = process.env.INTERNAL_API_KEY_PREVIOUS;

  if (key === null) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = key;
  if (prevKey === null) delete process.env.INTERNAL_API_KEY_PREVIOUS;
  else if (prevKey !== undefined) process.env.INTERNAL_API_KEY_PREVIOUS = prevKey;

  const req = { headers: header != null ? { 'x-internal-key': header } : {} };
  const res = mockRes();
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  internalAuth(req, res, next);

  // restore
  if (prevEnvKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = prevEnvKey;
  if (prevEnvPrev === undefined) delete process.env.INTERNAL_API_KEY_PREVIOUS;
  else process.env.INTERNAL_API_KEY_PREVIOUS = prevEnvPrev;

  return { res, nextCalled };
}

describe('internalAuth — fail-closed', () => {
  it('rejects when INTERNAL_API_KEY is not configured', () => {
    const { res, nextCalled } = callMiddleware({ key: null, prevKey: null, header: 'anything' });
    assert.equal(res.statusCode, 503);
    assert.equal(nextCalled, false);
    assert.match(res.body.error, /not configured/);
  });
});

describe('internalAuth — header presence', () => {
  it('rejects when x-internal-key is missing', () => {
    const { res, nextCalled } = callMiddleware({ key: 'secret', header: null });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });
  it('rejects when x-internal-key is empty', () => {
    const { res, nextCalled } = callMiddleware({ key: 'secret', header: '' });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });
});

describe('internalAuth — key matching', () => {
  it('accepts the current key', () => {
    const { res, nextCalled } = callMiddleware({ key: 'secret', header: 'secret' });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });
  it('rejects an incorrect key', () => {
    const { res, nextCalled } = callMiddleware({ key: 'secret', header: 'guess' });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });
});

describe('internalAuth — dual-key rotation', () => {
  it('accepts the previous key during rotation window', () => {
    const { res, nextCalled } = callMiddleware({
      key: 'new-secret',
      prevKey: 'old-secret',
      header: 'old-secret',
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });
  it('accepts the new key during rotation window', () => {
    const { res, nextCalled } = callMiddleware({
      key: 'new-secret',
      prevKey: 'old-secret',
      header: 'new-secret',
    });
    assert.equal(nextCalled, true);
  });
  it('rejects keys that match neither', () => {
    const { res, nextCalled } = callMiddleware({
      key: 'new-secret',
      prevKey: 'old-secret',
      header: 'guess',
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });
});

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
  });
  it('returns false for unequal strings of same length', () => {
    assert.equal(safeEqual('abc', 'abd'), false);
  });
  it('returns false for unequal lengths', () => {
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('abcd', 'abc'), false);
  });
  it('returns false for non-strings', () => {
    assert.equal(safeEqual(null, 'abc'), false);
    assert.equal(safeEqual('abc', undefined), false);
    assert.equal(safeEqual(123, 'abc'), false);
  });
});
