/**
 * Backblaze B2 image storage via S3-compatible API.
 * Falls back gracefully when B2 is not configured — returns original data as-is.
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
  });
  return s3;
}

function isEnabled() {
  return !!(B2_ENDPOINT && B2_BUCKET && B2_KEY_ID && B2_APP_KEY);
}

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

module.exports = {
  isEnabled,
  uploadImage,
  uploadFromDataUri,
  uploadFromUrl,
  getPresignedUrl,
  isB2Path,
  extractKey,
  migratePublicUrl,
};
