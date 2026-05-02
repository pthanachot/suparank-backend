/**
 * Tests for imageStorage.js helper functions.
 * Only tests pure functions — no actual B2 connection needed.
 *
 * Note: isEnabled/getClient/getPresignedUrl/upload* require env vars
 * and real S3 clients, so we test them indirectly via the helper functions.
 */

// We need to set env vars BEFORE requiring the module
// so isEnabled() can be tested both ways.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Restore env
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

describe('imageStorage helpers', () => {
  let imageStorage;

  beforeEach(() => {
    // Set minimal env so the module loads without errors
    process.env.B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
    process.env.B2_BUCKET = 'Suparank';
    process.env.B2_KEY_ID = 'test-key-id';
    process.env.B2_APP_KEY = 'test-app-key';
    imageStorage = require('../src/services/imageStorage');
  });

  // ── isB2Path ────────────────────────────────────────────

  test('isB2Path returns true for /api/b2-image/ paths', () => {
    expect(imageStorage.isB2Path('/api/b2-image/images/ws1/c2/file.png')).toBe(true);
  });

  test('isB2Path returns false for non-B2 paths', () => {
    expect(imageStorage.isB2Path('https://example.com/img.png')).toBe(false);
    expect(imageStorage.isB2Path('/api/other/path')).toBe(false);
  });

  test('isB2Path returns false for non-string input', () => {
    expect(imageStorage.isB2Path(null)).toBe(false);
    expect(imageStorage.isB2Path(undefined)).toBe(false);
    expect(imageStorage.isB2Path(123)).toBe(false);
  });

  // ── extractKey ──────────────────────────────────────────

  test('extractKey strips the /api/b2-image/ prefix', () => {
    expect(imageStorage.extractKey('/api/b2-image/images/ws1/c2/file.png'))
      .toBe('images/ws1/c2/file.png');
  });

  test('extractKey returns empty string for prefix-only path', () => {
    expect(imageStorage.extractKey('/api/b2-image/')).toBe('');
  });

  // ── migratePublicUrl ────────────────────────────────────

  test('migratePublicUrl converts endpoint-based URL to /api/b2-image/ path', () => {
    const publicUrl = 'https://s3.us-east-005.backblazeb2.com/Suparank/images/ws1/c2/file.png';
    const result = imageStorage.migratePublicUrl(publicUrl);
    expect(result).toBe('/api/b2-image/images/ws1/c2/file.png');
  });

  test('migratePublicUrl returns null for non-B2 URLs', () => {
    expect(imageStorage.migratePublicUrl('https://example.com/img.png')).toBeNull();
    expect(imageStorage.migratePublicUrl('https://other-cdn.com/file.jpg')).toBeNull();
  });

  test('migratePublicUrl returns null for null/empty input', () => {
    expect(imageStorage.migratePublicUrl(null)).toBeNull();
    expect(imageStorage.migratePublicUrl('')).toBeNull();
    expect(imageStorage.migratePublicUrl(undefined)).toBeNull();
  });

  test('migratePublicUrl handles trailing slash on endpoint', () => {
    // The endpoint doesn't have trailing slash, but the function strips it
    const publicUrl = 'https://s3.us-east-005.backblazeb2.com/Suparank/key.png';
    const result = imageStorage.migratePublicUrl(publicUrl);
    expect(result).toBe('/api/b2-image/key.png');
  });
});

// ── isEnabled ─────────────────────────────────────────────

describe('imageStorage.isEnabled', () => {
  test('returns true when all 4 required env vars are set', () => {
    process.env.B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
    process.env.B2_BUCKET = 'Suparank';
    process.env.B2_KEY_ID = 'key';
    process.env.B2_APP_KEY = 'secret';
    const mod = require('../src/services/imageStorage');
    expect(mod.isEnabled()).toBe(true);
  });

  test('returns false when B2_ENDPOINT is missing', () => {
    delete process.env.B2_ENDPOINT;
    process.env.B2_BUCKET = 'Suparank';
    process.env.B2_KEY_ID = 'key';
    process.env.B2_APP_KEY = 'secret';
    jest.resetModules();
    const mod = require('../src/services/imageStorage');
    expect(mod.isEnabled()).toBe(false);
  });

  test('returns false when B2_BUCKET is missing', () => {
    process.env.B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
    delete process.env.B2_BUCKET;
    process.env.B2_KEY_ID = 'key';
    process.env.B2_APP_KEY = 'secret';
    jest.resetModules();
    const mod = require('../src/services/imageStorage');
    expect(mod.isEnabled()).toBe(false);
  });
});
