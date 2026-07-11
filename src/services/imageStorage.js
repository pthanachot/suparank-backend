/**
 * Backblaze B2 image storage via S3-compatible API.
 * Falls back gracefully when B2 is not configured — returns original data as-is.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_REGION = process.env.B2_REGION || 'us-west-004';
const B2_BUCKET = process.env.B2_BUCKET;
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_CDN_URL = process.env.B2_CDN_URL; // optional, for custom CDN domain

let s3 = null;

function getClient() {
  if (s3) return s3;
  if (!isEnabled()) return null;
  s3 = new S3Client({
    endpoint: B2_ENDPOINT,
    region: B2_REGION,
    credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
    }),
  });
  return s3;
}

function isEnabled() {
  return !!(B2_ENDPOINT && B2_BUCKET && B2_KEY_ID && B2_APP_KEY);
}

// Keep B2 connection warm — initial handshake + periodic ping every 30s
// so uploads always hit the fast path (~3s) instead of cold start (~11s).
(function keepWarm() {
  const client = getClient();
  if (!client) return;
  const ping = () => client.send(new ListObjectsV2Command({ Bucket: B2_BUCKET, MaxKeys: 1 })).catch(() => {});
  ping().then(() => console.log('[B2] connection warmed up'));
  setInterval(ping, 60_000).unref();
})();

/**
 * Build a backend-relative path for an uploaded file.
 * Images are served via the /api/b2-image/* redirect route.
 */
function buildImagePath(key) {
  return `/api/b2-image/${key}`;
}

/** In-memory cache for presigned URLs — avoids regenerating on every request. */
const presignedCache = new Map(); // key → { url, expiresAt }

/**
 * Generate a presigned URL for a B2 object (valid 1 hour, cached ~58 min).
 * @param {string} key - B2 object key (e.g. 'images/ws/cn/file.png')
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedUrl(key) {
  const cached = presignedCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const client = getClient();
  if (!client) throw new Error('B2 storage not configured');

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: B2_BUCKET, Key: key }),
    { expiresIn: 3600 },
  );
  presignedCache.set(key, { url, expiresAt: Date.now() + 58 * 60 * 1000 });
  return url;
}

const B2_IMAGE_PREFIX = '/api/b2-image/';

/** Check if a src is a B2 image path served by our redirect route. */
function isB2Path(src) {
  return typeof src === 'string' && src.startsWith(B2_IMAGE_PREFIX);
}

/** Extract the B2 object key from a /api/b2-image/... path. */
function extractKey(src) {
  return src.slice(B2_IMAGE_PREFIX.length);
}

/**
 * Check if a src is an old-format public B2 URL and convert to new path.
 * Returns the new path if converted, or null if not a B2 URL.
 */
function migratePublicUrl(src) {
  if (!src || typeof src !== 'string') return null;
  // Match: https://endpoint/bucket/images/... or https://cdn-url/images/...
  if (B2_ENDPOINT && src.startsWith(B2_ENDPOINT.replace(/\/$/, ''))) {
    const prefix = `${B2_ENDPOINT.replace(/\/$/, '')}/${B2_BUCKET}/`;
    if (src.startsWith(prefix)) {
      return buildImagePath(src.slice(prefix.length));
    }
  }
  if (B2_CDN_URL && src.startsWith(B2_CDN_URL.replace(/\/$/, ''))) {
    const prefix = `${B2_CDN_URL.replace(/\/$/, '')}/`;
    if (src.startsWith(prefix)) {
      return buildImagePath(src.slice(prefix.length));
    }
  }
  return null;
}

/**
 * Map common data URI MIME types to file extensions.
 */
function mimeToExt(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return map[mime] || 'png';
}

/**
 * Upload a buffer to B2.
 * @param {Buffer} buffer - Image data
 * @param {string} contentType - MIME type (e.g. 'image/png')
 * @param {string} workspaceId - Workspace ID for path namespacing
 * @param {string|number} contentNumber - Content number for path namespacing
 * @returns {Promise<string>} Public URL
 */
async function uploadImage(buffer, contentType, workspaceId, contentNumber) {
  const client = getClient();
  if (!client) throw new Error('B2 storage not configured');

  const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 8);
  const ext = mimeToExt(contentType);
  const key = `images/${workspaceId}/${contentNumber}/${Date.now()}-${hash}.${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'private, max-age=86400',
  }));

  return buildImagePath(key);
}

/**
 * Upload a base64 data URI to B2.
 * @param {string} dataUri - e.g. 'data:image/png;base64,iVBOR...'
 * @param {string} workspaceId
 * @param {string|number} contentNumber
 * @returns {Promise<string>} Public URL, or the original dataUri if B2 is not enabled
 */
async function uploadFromDataUri(dataUri, workspaceId, contentNumber) {
  if (!isEnabled()) return dataUri;

  const match = dataUri.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return dataUri;

  const contentType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return uploadImage(buffer, contentType, workspaceId, contentNumber);
}

/**
 * Fetch a URL (e.g. temporary engine URL) and upload to B2.
 * @param {string} url - The URL to fetch
 * @param {string} workspaceId
 * @param {string|number} contentNumber
 * @returns {Promise<string>} Public URL, or the original URL if B2 is not enabled
 */
async function uploadFromUrl(url, workspaceId, contentNumber) {
  if (!isEnabled()) return url;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  return uploadImage(buffer, contentType, workspaceId, contentNumber);
}

// ─── R18: SSRF-hardened rehost of UNTRUSTED image URLs ────────
// uploadFromUrl above is for TRUSTED internal URLs (the writing engine's own
// temp image host, which is localhost/private and must NOT be blocked). The
// helpers below are for user-supplied search-result URLs, which are hostile
// input and must be validated against SSRF before we fetch them server-side.

/** Thrown when an untrusted URL fails SSRF validation (→ HTTP 400). */
class UrlValidationError extends Error {
  constructor(message) { super(message); this.name = 'UrlValidationError'; }
}

const REHOST_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const REHOST_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const REHOST_MAX_REDIRECTS = 3;
const REHOST_TIMEOUT_MS = 15000;

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata.google.internal', 'metadata', 'instance-data',
]);

// Private / loopback / link-local / reserved ranges (IPv4 + IPv6).
function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0) return true;                              // 0.0.0.0/8
    if (p[0] === 10) return true;                             // 10/8 private
    if (p[0] === 127) return true;                            // loopback
    if (p[0] === 169 && p[1] === 254) return true;            // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;           // 192.168/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    if (p[0] >= 224) return true;                            // multicast/reserved
    return false;
  }
  if (kind === 6) {
    const h = ip.toLowerCase();
    if (h === '::1' || h === '::') return true;              // loopback / unspecified
    if (/^fe[89ab]/.test(h)) return true;                   // link-local fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA fc00::/7
    // IPv4-mapped ::ffff:a.b.c.d — new URL rewrites the dotted form to hex
    // (::ffff:7f00:1), so decode BOTH forms and defer to the IPv4 rules. An
    // unrecognized mapped form fails closed (returns true) rather than leak.
    if (h.startsWith('::ffff:')) {
      const tail = h.slice(7);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateIp(tail);
      const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
        return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
      return true; // unrecognized ::ffff: form — fail closed
    }
    return false;
  }
  return false; // not an IP literal
}

function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  return h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost');
}

/**
 * Validate an untrusted URL is safe to fetch server-side. Rejects non-http(s)
 * schemes, embedded credentials, blocked hostnames, and literal or DNS-resolved
 * private/loopback/link-local IPs (the DNS check defeats rebinding for THIS
 * fetch). Throws UrlValidationError on any violation.
 */
async function assertSafeImageURL(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new UrlValidationError('invalid URL'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UrlValidationError(`scheme not allowed: ${u.protocol}`);
  }
  if (u.username || u.password) throw new UrlValidationError('credentials in URL not allowed');

  const host = u.hostname;
  if (!host) throw new UrlValidationError('missing host');
  if (isBlockedHostname(host)) throw new UrlValidationError(`host not allowed: ${host}`);

  // Literal IP host — check directly (no DNS). new URL keeps IPv6 hosts
  // bracketed ("[::1]") and net.isIP rejects brackets, so strip them first;
  // otherwise every IPv6 literal would skip this branch and fall to DNS.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bare)) {
    if (isPrivateIp(bare)) throw new UrlValidationError(`private IP not allowed: ${host}`);
    return;
  }

  // Hostname — resolve and reject if ANY record is private (anti-rebinding).
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new UrlValidationError(`DNS resolution failed: ${host}`); }
  if (!addrs.length) throw new UrlValidationError(`no DNS records: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new UrlValidationError(`host resolves to private IP: ${host}`);
  }
}

/**
 * Fetch an UNTRUSTED image URL (with SSRF validation, redirect re-validation,
 * content-type allowlist, size cap, and timeout) and upload it to B2.
 * Returns the backend-relative image path. Throws UrlValidationError for unsafe
 * URLs / disallowed types / oversize; other Errors for network/B2 failures.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable fetch (tests); defaults to global fetch
 */
async function uploadFromExternalUrl(url, workspaceId, contentNumber, { fetchImpl = fetch } = {}) {
  if (!isEnabled()) return url; // caller (handler) should short-circuit; defensive

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REHOST_TIMEOUT_MS);
  try {
    let current = url;
    let res;
    for (let hop = 0; ; hop++) {
      await assertSafeImageURL(current); // re-validate every hop (defeats redirect-to-internal)
      res = await fetchImpl(current, { redirect: 'manual', signal: controller.signal });
      if (res.status >= 300 && res.status < 400) {
        if (hop >= REHOST_MAX_REDIRECTS) throw new UrlValidationError('too many redirects');
        const loc = res.headers.get('location');
        if (!loc) throw new UrlValidationError('redirect without location');
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    }

    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!REHOST_ALLOWED_TYPES.has(contentType)) {
      throw new UrlValidationError(`disallowed content-type: ${contentType || 'none'}`);
    }
    // Fast reject on an honest content-length, then enforce the cap on the
    // ACTUAL bytes as we stream — so a server that omits/lies about
    // content-length can't make us buffer an unbounded body (memory DoS).
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > REHOST_MAX_BYTES) throw new UrlValidationError('image exceeds size limit');

    const buffer = await readBodyWithCap(res, REHOST_MAX_BYTES);
    return uploadImage(buffer, contentType, workspaceId, contentNumber);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a fetch Response body, aborting as soon as it exceeds maxBytes so an
 * oversize (or content-length-less) stream is never fully buffered. Throws
 * UrlValidationError past the cap. Falls back to arrayBuffer() only if the
 * response has no readable stream (defensive; real fetch always provides one).
 */
async function readBodyWithCap(res, maxBytes) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new UrlValidationError('image exceeds size limit');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closing */ }
      throw new UrlValidationError('image exceeds size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a buffer to B2 with a custom key.
 * Generic version of uploadImage for non-image files (e.g. brand voice uploads).
 * @param {Buffer} buffer - File data
 * @param {string} contentType - MIME type
 * @param {string} key - Full B2 object key
 * @returns {Promise<string>} The B2 key
 */
async function uploadBuffer(buffer, contentType, key) {
  const client = getClient();
  if (!client) throw new Error('B2 storage not configured');

  const t0 = Date.now();
  await client.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'private, max-age=86400',
  }));
  console.log(`[B2] uploadBuffer key=${key} took=${Date.now() - t0}ms`);

  // Upload succeeded — now clean up old versions (B2 versioning stacks on each PUT)
  await cleanOldVersions(key).catch(() => {});

  return key;
}

/**
 * Delete all old versions of a key, keeping only the latest.
 * B2 versioning creates a new version on every PUT — this prevents stacking.
 */
async function cleanOldVersions(key) {
  const client = getClient();
  if (!client) return;

  const res = await client.send(new ListObjectVersionsCommand({
    Bucket: B2_BUCKET,
    Prefix: key,
    MaxKeys: 50,
  }));

  // Filter to exact key match (prefix could match other keys)
  const versions = (res.Versions || []).filter(v => v.Key === key);
  const markers = (res.DeleteMarkers || []).filter(dm => dm.Key === key);

  // Keep the first (latest) version, delete the rest
  for (const v of versions.slice(1)) {
    await client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key, VersionId: v.VersionId }));
  }
  // Delete all hide markers
  for (const dm of markers) {
    await client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: dm.Key, VersionId: dm.VersionId }));
  }
}

/**
 * Delete an object from B2 by key.
 * @param {string} key - B2 object key
 */
async function deleteObject(key) {
  const client = getClient();
  if (!client) return;

  await client.send(new DeleteObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
  }));
}

/**
 * Delete ALL versions of all B2 objects under a given prefix.
 * Uses ListObjectVersions to find every version (including hide markers)
 * and deletes each by VersionId so they're truly removed.
 * @param {string} prefix - e.g. 'brand-voice/' or 'images/'
 * @returns {Promise<number>} Number of versions deleted
 */
async function deleteAllWithPrefix(prefix) {
  const client = getClient();
  if (!client) return 0;

  let deleted = 0;
  let keyMarker;
  let versionIdMarker;

  do {
    const res = await client.send(new ListObjectVersionsCommand({
      Bucket: B2_BUCKET,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));

    // Delete all versions (actual files)
    for (const v of res.Versions || []) {
      await client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: v.Key, VersionId: v.VersionId }));
      deleted++;
    }

    // Delete all delete markers (hide markers)
    for (const dm of res.DeleteMarkers || []) {
      await client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: dm.Key, VersionId: dm.VersionId }));
      deleted++;
    }

    keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
    versionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
  } while (keyMarker);

  return deleted;
}

module.exports = {
  isEnabled,
  uploadImage,
  uploadFromDataUri,
  uploadFromUrl,
  uploadFromExternalUrl,
  assertSafeImageURL,
  UrlValidationError,
  uploadBuffer,
  deleteObject,
  getPresignedUrl,
  isB2Path,
  extractKey,
  migratePublicUrl,
  deleteAllWithPrefix,
};
