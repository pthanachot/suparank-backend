'use strict';

// R18: SSRF hardening for rehosting untrusted image-search URLs.
// Covers assertSafeImageURL's reject/accept matrix and uploadFromExternalUrl's
// redirect re-validation + content-type/size caps (with an injected fetch so no
// network or B2 is touched). B2 env is set BEFORE require so isEnabled() is true
// (the consts are captured at module load); the keep-warm ping to the .invalid
// endpoint fails silently and its interval is unref'd.

process.env.B2_ENDPOINT = 'https://example-b2.invalid';
process.env.B2_BUCKET = 'test-bucket';
process.env.B2_KEY_ID = 'test-key';
process.env.B2_APP_KEY = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const imageStorage = require('../src/services/imageStorage');
const { assertSafeImageURL, uploadFromExternalUrl, UrlValidationError } = imageStorage;

// ─── assertSafeImageURL: reject matrix ───────────────────────

const REJECTED = [
  'http://localhost/x',
  'http://localhost:8090/api/images/img_1',
  'http://127.0.0.1/x',
  'http://2130706433/x',                           // decimal 127.0.0.1
  'http://0x7f000001/x',                           // hex 127.0.0.1
  'http://[::1]/x',                                // IPv6 loopback
  'http://[fe80::1]/x',                            // IPv6 link-local
  'http://[fc00::1]/x',                            // IPv6 ULA
  'http://[fd12:3456::1]/x',                       // IPv6 ULA
  'http://[::ffff:7f00:1]/x',                      // IPv4-mapped loopback (hex form)
  'http://[::ffff:127.0.0.1]/x',                   // IPv4-mapped loopback (dotted → hex)
  'http://[::ffff:0a00:5]/x',                      // IPv4-mapped 10.0.0.5
  'http://0.0.0.0/x',
  'http://169.254.169.254/latest/meta-data',       // AWS metadata
  'http://10.0.0.5/x',                             // 10/8
  'http://172.16.0.1/x',                           // 172.16/12
  'http://172.31.255.255/x',
  'http://192.168.1.1/x',                          // 192.168/16
  'http://100.64.0.1/x',                           // CGNAT
  'ftp://example.com/x',                           // scheme
  'file:///etc/passwd',                            // scheme
  'http://user:pass@example.com/x',                // credentials
  'http://metadata.google.internal/x',            // GCP metadata
  'http://svc.internal/x',                         // *.internal
  'http://box.local/x',                            // *.local
  'not-a-url',                                     // unparseable
];

for (const url of REJECTED) {
  test(`assertSafeImageURL rejects ${url}`, async () => {
    await assert.rejects(() => assertSafeImageURL(url), UrlValidationError, `should reject ${url}`);
  });
}

// Public literal IPs (v4 + v6) pass without a DNS lookup.
for (const url of ['http://8.8.8.8/x.png', 'https://93.184.216.34/img.jpg', 'http://[2606:4700::1111]/x.png']) {
  test(`assertSafeImageURL accepts public IP ${url}`, async () => {
    await assert.doesNotReject(() => assertSafeImageURL(url));
  });
}

// ─── uploadFromExternalUrl: fetch-path guards (injected fetch) ─

function streamFrom(...bufs) {
  return new ReadableStream({
    start(controller) {
      for (const b of bufs) controller.enqueue(new Uint8Array(b));
      controller.close();
    },
  });
}

function fakeRes({ status = 200, headers = {}, bodyChunks = [Buffer.alloc(0)] }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    body: streamFrom(...bodyChunks),
    arrayBuffer: async () => Buffer.concat(bodyChunks),
  };
}

test('rejects a non-image content-type (text/html)', async () => {
  const fetchImpl = async () => fakeRes({ headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    () => uploadFromExternalUrl('http://8.8.8.8/x', 'ws', 1, { fetchImpl }),
    UrlValidationError,
  );
});

test('rejects an oversize image (content-length > 10MB)', async () => {
  const fetchImpl = async () => fakeRes({
    headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
  });
  await assert.rejects(
    () => uploadFromExternalUrl('http://8.8.8.8/x', 'ws', 1, { fetchImpl }),
    UrlValidationError,
  );
});

test('enforces the size cap on the STREAMED body even without content-length', async () => {
  // No content-length header — the header guard can't help; the streaming read
  // must abort once the body exceeds 10MB. Six 2MB chunks = 12MB.
  const bigChunks = Array.from({ length: 6 }, () => Buffer.alloc(2 * 1024 * 1024));
  const fetchImpl = async () => fakeRes({
    status: 200,
    headers: { 'content-type': 'image/png' }, // no content-length
    bodyChunks: bigChunks,
  });
  await assert.rejects(
    () => uploadFromExternalUrl('http://8.8.8.8/x', 'ws', 1, { fetchImpl }),
    UrlValidationError,
  );
});

test('re-validates redirect hops — redirect to a private IP is rejected', async () => {
  const fetchImpl = async () => fakeRes({
    status: 302,
    headers: { location: 'http://169.254.169.254/latest/meta-data' },
  });
  await assert.rejects(
    () => uploadFromExternalUrl('http://8.8.8.8/x', 'ws', 1, { fetchImpl }),
    UrlValidationError,
  );
});

test('rejects an infinite public redirect loop (too many redirects)', async () => {
  const fetchImpl = async () => fakeRes({ status: 302, headers: { location: 'http://8.8.8.8/next' } });
  await assert.rejects(
    () => uploadFromExternalUrl('http://8.8.8.8/x', 'ws', 1, { fetchImpl }),
    /too many redirects/,
  );
});

test('a valid public image passes all SSRF/content/size checks (reaches upload)', async () => {
  // A legit 200 image/png. Validation + content-type + size all pass; it then
  // fails at the real B2 upload (fake endpoint) — proving it got PAST the guards.
  const fetchImpl = async () => fakeRes({
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': '1024' },
    bodyChunks: [Buffer.alloc(1024)],
  });
  let err;
  try {
    await uploadFromExternalUrl('http://8.8.8.8/x.png', 'ws', 1, { fetchImpl });
  } catch (e) { err = e; }
  assert.ok(err, 'expected a B2 upload failure (fake endpoint)');
  assert.ok(!(err instanceof UrlValidationError), 'must NOT be a validation error — validation passed');
});
