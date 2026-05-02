/**
 * Backblaze B2 image storage via S3-compatible API.
 * Falls back gracefully when B2 is not configured — returns original data as-is.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const https = require('https');
const crypto = require('crypto');

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
  uploadBuffer,
  deleteObject,
  getPresignedUrl,
  isB2Path,
  extractKey,
  migratePublicUrl,
  deleteAllWithPrefix,
};
