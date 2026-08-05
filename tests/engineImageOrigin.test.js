'use strict';

// Phase 4: the ENGINE image path — the mirror image of rehostImageSsrf.test.js.
//
// Two guards defend opposite directions and must not be confused:
//   assertSafeImageURL   — user-supplied URLs: anywhere EXCEPT our own network.
//   assertEngineImageURL — the engine's own generated images: our engine and
//                          nowhere else. Loopback is the NORMAL case here, so
//                          the SSRF guard cannot be reused; it would reject
//                          every legitimate URL in the default deployment.
//
// What this replaced was `block.src.includes('/api/images/img_')`, a substring
// test against a CLIENT-SUPPLIED string on the content-save path. Any URL
// carrying those characters anywhere was fetched server-side and its body
// uploaded to B2 under a URL the caller could then read — an authenticated
// SSRF read primitive, reachable on every content save whenever B2 is on and
// entirely independent of whether /image is enabled.
//
// B2 env is set BEFORE require so isEnabled() is true (consts are captured at
// module load), matching rehostImageSsrf.test.js.

process.env.B2_ENDPOINT = 'https://example-b2.invalid';
process.env.B2_BUCKET = 'test-bucket';
process.env.B2_KEY_ID = 'test-key';
process.env.B2_APP_KEY = 'test-secret';
process.env.WRITING_ENGINE_URL = 'http://localhost:8090';

const test = require('node:test');
const assert = require('node:assert');
const imageStorage = require('../src/services/imageStorage');
const {
  assertEngineImageURL, looksLikeEngineImageUrl, uploadFromUrl, UrlValidationError,
} = imageStorage;

// ─── The exact attacks the substring check let through ───────

const ATTACKS = [
  // Every one of these contains '/api/images/img_' and so passed the old test.
  ['arbitrary external host', 'https://evil.example.com/api/images/img_x'],
  ['AWS/GCP metadata via query', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/?/api/images/img_'],
  ['metadata via fragment', 'http://169.254.169.254/#/api/images/img_'],
  ['internal service probe', 'http://127.0.0.1:6379/api/images/img_'],
  ['engine host, wrong port', 'http://localhost:9999/api/images/img_a.png'],
  ['engine origin, wrong scheme', 'https://localhost:8090/api/images/img_a.png'],
  ['lookalike host', 'http://localhost.evil.test:8090/api/images/img_a.png'],
  ['marker only in the path suffix', 'http://evil.test/x/api/images/img_'],
  ['credentials smuggled in', 'http://user:pass@localhost:8090/api/images/img_a.png'],
  ['near-miss path prefix', 'http://localhost:8090/api/imagesX/img_a.png'],
];

for (const [label, url] of ATTACKS) {
  test(`assertEngineImageURL rejects: ${label}`, () => {
    assert.throws(() => assertEngineImageURL(url), UrlValidationError, url);
  });
}

test('the old substring check would have admitted every one of them', () => {
  // Pins the premise. If this ever stops holding, the attack list above has
  // drifted away from the bug it documents and needs rewriting, not deleting.
  for (const [label, url] of ATTACKS) {
    if (label === 'near-miss path prefix') continue; // deliberately lacks the marker
    assert.ok(url.includes('/api/images/img_'),
      `${label} no longer demonstrates the substring bug`);
  }
});

// ─── Legitimate engine URLs still work ───────────────────────

test('accepts the engine\'s own generated-image URLs', () => {
  assertEngineImageURL('http://localhost:8090/api/images/img_abc.png');
  assertEngineImageURL('http://localhost:8090/api/images/nested/img_abc.svg');
  // No img_ prefix required: the path prefix is the contract, and the engine's
  // key format is its own business.
  assertEngineImageURL('http://localhost:8090/api/images/whatever.webp');
});

test('a second origin can be allowlisted for split deploys', () => {
  // In production the engine bakes its PUBLIC IMAGE_BASE_URL into the markdown,
  // which is a different origin from the backend→engine address. Without this
  // escape hatch every generated image in a split deploy would be refused.
  const prev = process.env.ENGINE_IMAGE_BASE_URL;
  process.env.ENGINE_IMAGE_BASE_URL = 'https://engine.example.com';
  try {
    assertEngineImageURL('https://engine.example.com/api/images/img_a.png');
    assert.equal(looksLikeEngineImageUrl('https://engine.example.com/api/images/img_a.png'), true);
    // and still nothing else
    assert.throws(() => assertEngineImageURL('https://other.example.com/api/images/img_a.png'),
      UrlValidationError);
  } finally {
    if (prev === undefined) delete process.env.ENGINE_IMAGE_BASE_URL;
    else process.env.ENGINE_IMAGE_BASE_URL = prev;
  }
});

test('origins are read per call, not frozen at module load', () => {
  // The allowlist is the security boundary; a snapshot taken at require() time
  // would ignore a later config change in exactly the direction that matters.
  const prev = process.env.ENGINE_IMAGE_BASE_URL;
  delete process.env.ENGINE_IMAGE_BASE_URL;
  try {
    assert.equal(looksLikeEngineImageUrl('https://late.example.com/api/images/a.png'), false);
    process.env.ENGINE_IMAGE_BASE_URL = 'https://late.example.com';
    assert.equal(looksLikeEngineImageUrl('https://late.example.com/api/images/a.png'), true);
  } finally {
    if (prev === undefined) delete process.env.ENGINE_IMAGE_BASE_URL;
    else process.env.ENGINE_IMAGE_BASE_URL = prev;
  }
});

test('looksLikeEngineImageUrl is a safe pre-filter, never a substitute', () => {
  // It exists to avoid throwing on ordinary non-engine srcs. It is deliberately
  // NOT the authority: credentials pass it and are caught by the assert. A
  // caller that used only the pre-filter would still be safe because
  // uploadFromUrl re-asserts, and this pins that division.
  assert.equal(looksLikeEngineImageUrl('http://user:pass@localhost:8090/api/images/img_a.png'), true);
  assert.throws(() => assertEngineImageURL('http://user:pass@localhost:8090/api/images/img_a.png'),
    UrlValidationError);

  for (const junk of [null, undefined, '', 42, {}, 'not a url', 'data:image/png;base64,AAA']) {
    assert.equal(looksLikeEngineImageUrl(junk), false, String(junk));
  }
});

// ─── uploadFromUrl: the fetch is bounded ─────────────────────

const okHeaders = (o = {}) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const ENGINE_URL = 'http://localhost:8090/api/images/img_a.png';

function bodyOf(buf) {
  let sent = false;
  return {
    getReader: () => ({
      read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })),
      cancel: async () => {},
    }),
  };
}

test('uploadFromUrl refuses a non-engine URL before any fetch happens', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('should not be reached'); };
  await assert.rejects(
    () => uploadFromUrl('https://evil.example.com/api/images/img_x', 'ws1', 1, { fetchImpl }),
    UrlValidationError,
  );
  assert.equal(called, false, 'the guard must run BEFORE the request, not after');
});

test('uploadFromUrl refuses a redirect rather than following it off the allowlist', async () => {
  // fetch follows redirects by default, so the previous implementation would
  // have chased a 302 from the engine origin to anywhere at all.
  const fetchImpl = async () => ({
    status: 302, ok: false,
    headers: okHeaders({ location: 'http://169.254.169.254/latest/meta-data' }),
  });
  await assert.rejects(() => uploadFromUrl(ENGINE_URL, 'ws1', 1, { fetchImpl }), UrlValidationError);
});

test('uploadFromUrl rejects a disallowed content-type instead of relabelling it', async () => {
  // The old code defaulted a missing content-type to 'image/png', so whatever
  // came back was stored and later served as an image.
  for (const ct of [null, 'text/html', 'application/json', 'image/svg+xml']) {
    const fetchImpl = async () => ({
      status: 200, ok: true,
      headers: okHeaders(ct ? { 'content-type': ct } : {}),
      body: bodyOf(Buffer.from('x')),
    });
    await assert.rejects(
      () => uploadFromUrl(ENGINE_URL, 'ws1', 1, { fetchImpl }),
      UrlValidationError,
      `content-type ${ct}`,
    );
  }
});

test('uploadFromUrl enforces the size cap even when content-length lies', async () => {
  const huge = Buffer.alloc(11 * 1024 * 1024);
  const fetchImpl = async () => ({
    status: 200, ok: true,
    // No content-length at all — the cap must come from the streamed bytes.
    headers: okHeaders({ 'content-type': 'image/png' }),
    body: bodyOf(huge),
  });
  await assert.rejects(() => uploadFromUrl(ENGINE_URL, 'ws1', 1, { fetchImpl }), UrlValidationError);
});

test('uploadFromUrl rejects an oversize declared content-length up front', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: okHeaders({ 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) }),
    body: bodyOf(Buffer.from('x')),
  });
  await assert.rejects(() => uploadFromUrl(ENGINE_URL, 'ws1', 1, { fetchImpl }), UrlValidationError);
});

test('uploadFromUrl passes an abort signal so a hung engine cannot pin the request', async () => {
  let sawSignal = false;
  const fetchImpl = async (_u, opts) => {
    sawSignal = !!opts?.signal;
    return {
      status: 200, ok: true,
      headers: okHeaders({ 'content-type': 'image/png' }),
      body: bodyOf(Buffer.from('x')),
    };
  };
  // uploadImage would need real B2; we only care that the request was bounded,
  // so let the upload fail and assert on what the fetch received.
  await uploadFromUrl(ENGINE_URL, 'ws1', 1, { fetchImpl }).catch(() => {});
  assert.equal(sawSignal, true, 'no timeout signal was attached to the fetch');
});
