// src/config/appUrl.js
//
// THE canonical origin for every user-facing absolute URL this backend mints:
// verification and invite links, report share links, Stripe success/cancel and
// billing-portal return URLs, Connect onboarding, the emailed brand logo, and
// the Google Search Console OAuth redirect URI.
//
// Exactly two env vars drive it — APP_URL (preferred) and FRONTEND_URL
// (fallback) — so the domain changes in one place.
//
// RESOLVED ON EVERY CALL, never cached at require time. tests/domainService.test.js
// and tests/emailBrandLogo.test.js both set and delete these vars between cases
// and expect the next call to see the change. (The frontend's lib/siteUrl.ts is a
// module constant instead, because Next inlines env at build time — the two are
// deliberately different shapes.)
//
// FOOTGUN: on the backend Railway service, APP_URL historically held the BACKEND
// host and was read by nothing (see .env.example). Now that it is preferred,
// pointing user-facing links at it would be worse than the bug this replaces —
// warnOnAmbiguousConfig() shouts at boot when the two vars disagree.

/**
 * Last-resort origin. Deliberately the live apex rather than localhost: an unset
 * var must never put a dead host into an email. See the reasoning recorded in
 * tests/emailBrandLogo.test.js ("an unset FRONTEND_URL would have put a dead logo
 * and dead links in every email").
 */
const DEFAULT_APP_URL = 'https://suparank.ai';

const clean = (v) => String(v || '').trim().replace(/\/+$/, '');

/** The canonical origin, guaranteed absolute and without a trailing slash. */
function appUrl() {
  return clean(process.env.APP_URL) || clean(process.env.FRONTEND_URL) || DEFAULT_APP_URL;
}

/**
 * True when an origin was explicitly configured, as opposed to falling through
 * to DEFAULT_APP_URL. Callers that must refuse to guess (the PDF renderer) gate
 * on this rather than on a specific env var.
 */
function isConfigured() {
  return Boolean(clean(process.env.APP_URL) || clean(process.env.FRONTEND_URL));
}

/**
 * CORS allow-list: the canonical origin, plus FRONTEND_URL for as long as it
 * still names a different host. That makes a domain cutover survivable without
 * inventing a third env var — set APP_URL to the new origin, leave FRONTEND_URL
 * on the old one until traffic has moved, then drop it and the list collapses
 * back to a single entry.
 */
function allowedOrigins() {
  return Array.from(new Set([appUrl(), clean(process.env.FRONTEND_URL)].filter(Boolean)));
}

/**
 * Boot-time sanity check. Never throws — a warning keeps a misconfigured deploy
 * serving (degraded) rather than crash-looping, and Railway surfaces it on the
 * first line of the log.
 */
function warnOnAmbiguousConfig(log = console.warn) {
  const app = clean(process.env.APP_URL);
  const frontend = clean(process.env.FRONTEND_URL);

  if (app && !/^https?:\/\//i.test(app)) {
    log(`[appUrl] APP_URL is not an absolute URL (${app}) — links built from it will be broken.`);
  }
  if (app && frontend && app !== frontend) {
    log(
      `[appUrl] APP_URL (${app}) and FRONTEND_URL (${frontend}) disagree; APP_URL wins. ` +
        'If APP_URL still holds the BACKEND host, every user-facing link is now wrong — ' +
        `set APP_URL=${DEFAULT_APP_URL} or unset it.`
    );
  }
  if (!app && !frontend) {
    log(`[appUrl] Neither APP_URL nor FRONTEND_URL is set; falling back to ${DEFAULT_APP_URL}.`);
  }
}

module.exports = {
  appUrl,
  isConfigured,
  allowedOrigins,
  warnOnAmbiguousConfig,
  DEFAULT_APP_URL,
};
