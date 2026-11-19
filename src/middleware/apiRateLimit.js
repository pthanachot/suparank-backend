/**
 * The global /api/ rate limiter (QA Nov 2026: N2, B36).
 *
 * THE BUG. All browser traffic reaches this server through the Next.js server,
 * so an IP-keyed limiter saw ONE client: every user of the app shared a single
 * 100-requests-per-15-minutes bucket in production. One writer autosaving and
 * scoring could 429 everybody.
 *
 * THE FIX.
 *  - Key by the authenticated USER when the request carries a valid access
 *    token, else by req.ip. The token is verified exactly as authenticateToken
 *    verifies it (HS256 pinned, ACCESS_TOKEN_SECRET, expiry enforced) but
 *    WITHOUT the user/session lookups: this runs on every request, and an
 *    unverified id is never trusted, so a forged or expired token simply falls
 *    back to the IP bucket. (A revoked-but-unexpired token still keys to its
 *    own user, which only ever rate-limits that user: harmless.)
 *  - Two ceilings: a per-USER bucket sized for an editor that autosaves and
 *    scores (600 / 15 min in production), and the old strict per-IP ceiling for
 *    unauthenticated traffic (100 / 15 min), so login/signup brute force stays
 *    as constrained as before. Admin override: SystemSettings.rateLimit.max
 *    (per-user bucket, as before the only knob) and the new optional
 *    rateLimit.ipMax (per-IP bucket).
 *  - req.ip must be the CLIENT, not the Next hop: index.js trusts
 *    TRUST_PROXY_HOPS (default 1) proxy hops, so the Next server must APPEND the
 *    browser's address as the LAST X-Forwarded-For entry.
 *  - A JSON 429 the frontend can act on:
 *      HTTP 429, header Retry-After: <seconds>
 *      { "error": "rate_limited", "message": "<friendly>", "retryAfter": <seconds> }
 */

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const PROD = process.env.NODE_ENV === 'production';
const USER_DEFAULT_MAX = PROD ? 600 : 3000;
const IP_DEFAULT_MAX = PROD ? 100 : 1000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

const RATE_LIMITED_MESSAGE = 'You are sending requests faster than we can handle. Please wait a moment and try again.';

/**
 * Resolve (and memoise on req) who this request is for rate-limit purposes.
 * @returns {{ key: string, kind: 'user'|'ip' }}
 */
function rateLimitIdentity(req, secret = process.env.ACCESS_TOKEN_SECRET) {
  if (req._rateLimitIdentity) return req._rateLimitIdentity;
  let identity = null;
  const header = req.headers?.authorization;
  if (secret && typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
        const uid = decoded && decoded.userId != null ? String(decoded.userId) : '';
        if (uid) identity = { key: `u:${uid}`, kind: 'user' };
      } catch { /* invalid/expired/forged → fall back to IP */ }
    }
  }
  if (!identity) identity = { key: `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`, kind: 'ip' };
  req._rateLimitIdentity = identity;
  return identity;
}

function keyGenerator(req) {
  return rateLimitIdentity(req).key;
}

function maxFor(req, settings) {
  const rl = (settings && settings.rateLimit) || {};
  return rateLimitIdentity(req).kind === 'user'
    ? (rl.max || USER_DEFAULT_MAX)
    : (rl.ipMax || IP_DEFAULT_MAX);
}

function retryAfterSeconds(req, windowMs) {
  const reset = req.rateLimit?.resetTime;
  const ms = reset instanceof Date ? reset.getTime() - Date.now() : windowMs;
  return Math.max(1, Math.ceil(ms / 1000));
}

function makeHandler(windowMs) {
  return (req, res) => {
    const retryAfter = retryAfterSeconds(req, windowMs);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate_limited', message: RATE_LIMITED_MESSAGE, retryAfter });
  };
}

// Server-to-server and separately-limited paths (see each limiter's comment).
function skip(req) {
  const url = req.originalUrl || '';
  return url.startsWith('/api/internal/') ||
    // The notification bell polls every ~90s per tab and has its own per-user
    // limiter (notificationRoutes).
    url.startsWith('/api/notifications') ||
    // Telemetry batches have their own per-user limiter (observeRoutes).
    url.startsWith('/api/observe') ||
    // Ghost-text autocomplete fires on every typing pause; own limiter
    // (workspaceRoutes autocompleteLimiter).
    /\/ai\/autocomplete(?:\?|$)/.test(url);
}

/**
 * Build the limiter. `getSettings` is read per request for `max` so an admin
 * change applies without a rebuild; windowMs is fixed at construction.
 */
function buildApiLimiter(getSettings) {
  const windowMs = getSettings().rateLimit?.windowMs || DEFAULT_WINDOW_MS;
  return rateLimit({
    windowMs,
    max: (req) => maxFor(req, getSettings()),
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: makeHandler(windowMs),
  });
}

module.exports = {
  buildApiLimiter,
  rateLimitIdentity,
  keyGenerator,
  maxFor,
  makeHandler,
  skip,
  USER_DEFAULT_MAX,
  IP_DEFAULT_MAX,
  RATE_LIMITED_MESSAGE,
};
