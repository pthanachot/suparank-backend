/**
 * Boot-time environment-variable validation.
 *
 * Call at server startup with the env vars the app needs to function.
 * If any are missing or empty, log the full list and exit(1) so the
 * process manager (Railway, systemd, pm2) reports a clear failure
 * instead of the server starting in a broken state and surfacing
 * opaque 500s on request-time use.
 *
 * Usage (at top of index.js, before any service is required):
 *   require('./utils/requireEnv')({
 *     required: ['MONGODB_URI', 'JWT_SECRET'],
 *     optional: ['GOOGLE_CLIENT_ID', 'GSC_TOKEN_ENCRYPTION_KEY'],
 *   });
 *
 * `required` — fatal if any missing.
 * `optional` — logged as a warning so missing-integration symptoms (e.g. the
 *   GSC auth-url 503 we ran into) are visible at boot rather than discovered
 *   on the first request.
 */
function requireEnv({ required = [], optional = [] } = {}) {
  const missing = [];
  for (const key of required) {
    const value = process.env[key];
    if (value === undefined || value === null || value === '') {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error('');
    console.error('================================================');
    console.error('FATAL: Missing required environment variables:');
    for (const key of missing) console.error(`  - ${key}`);
    console.error('Set these on the server (Railway env, .env, etc.)');
    console.error('and restart.');
    console.error('================================================');
    process.exit(1);
  }

  const optMissing = optional.filter((k) => !process.env[k]);
  if (optMissing.length > 0) {
    console.warn('[requireEnv] Optional env vars not set — related features will be disabled:');
    for (const key of optMissing) console.warn(`  - ${key}`);
  }
}

module.exports = requireEnv;
