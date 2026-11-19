/**
 * Analysis failure classification + user-facing copy (QA Nov 2026: B09, B40).
 *
 * Before this, runAnalysis stored the raw engine error ("Engine returned 502:
 * openrouter returned status 401: {"error":...}") in content.analysisError and
 * getBenchmark sent it to the browser verbatim, and only timeouts and dropped
 * connections were treated as "our fault" (free retry). A provider credential
 * failure, a rate limit or an engine 5xx was billed back to the customer: the
 * UI fell through to the paid /reanalyze.
 *
 * Now every failure maps to a STABLE CODE plus friendly copy. The raw error is
 * logged server-side only and never stored or sent.
 *
 * Stored format (Content):
 *   analysisErrorCode: '<code>'                       (new field)
 *   analysisError:     'transient: <friendly copy>'   when the retry is free
 *                      '<friendly copy>'              when it is not
 * The `transient: ` prefix is kept because the current editor (and
 * retryAnalysis) key the free-retry affordance off it. New clients should read
 * the response fields from presentAnalysisError instead.
 */

const FREE_PREFIX = 'transient: ';

// code → { retryFree, message }. Copy rule: no em dashes, no internals.
const CODES = Object.freeze({
  engine_timeout: {
    retryFree: true,
    message: 'The analysis took too long to finish. This was a problem on our side, so trying again is free.',
  },
  engine_unavailable: {
    retryFree: true,
    message: 'We could not reach the analysis service. This was a problem on our side, so trying again is free.',
  },
  engine_busy: {
    retryFree: true,
    message: 'The analysis service is busy right now. Please try again in a minute. Trying again is free.',
  },
  server_restart: {
    retryFree: true,
    message: 'The analysis was interrupted while our servers restarted. Trying again is free.',
  },
  provider_auth: {
    retryFree: true,
    message: 'An AI service we rely on turned down our request. This is a problem on our side, so trying again is free.',
  },
  provider_rate_limited: {
    retryFree: true,
    message: 'An AI service we rely on is limiting requests right now. Please wait a minute and try again. Trying again is free.',
  },
  server_error: {
    retryFree: true,
    message: 'Something went wrong on our side while analyzing this page. Trying again is free.',
  },
  no_serp_results: {
    retryFree: false,
    message: 'We could not find search results for this keyword. Try a different or broader keyword.',
  },
  no_sources: {
    retryFree: false,
    message: 'We could not read enough competitor pages to build the analysis. Try a different keyword, or run the analysis again later.',
  },
  invalid_request: {
    retryFree: false,
    message: 'This page could not be analyzed with its current setup. Check the target keyword and try again.',
  },
  unknown: {
    retryFree: false,
    message: 'Something went wrong while analyzing this page. Please try again in a moment.',
  },
});

const has = (m, ...needles) => needles.some((n) => m.includes(n));
// Own-property check: CODES['constructor'] / CODES['__proto__'] are truthy
// inherited values, which would present as "undefined" copy.
const isCode = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CODES, c);

/**
 * Classify a raw failure message (engine body, thrown error, poll result).
 * Order matters: content problems are recognised before the generic 5xx rule,
 * because the engine also 502s on "could not crawl" / "no SERP results".
 */
function classifyAnalysisFailure(raw) {
  const m = String(raw || '').toLowerCase();
  if (!m) return 'unknown';

  // Our own restart sweep / lost job.
  if (has(m, 'interrupted by server restart', 'job lost', 'engine restarted', 'expired or lost to a restart')) {
    return 'server_restart';
  }

  // Content / keyword problems: a retry with the same input will not help.
  if (has(m, 'no serp results')) return 'no_serp_results';
  if (has(m, 'no citations or crawlable sources', 'could not crawl', 'no competitor pages', 'no crawlable')) {
    return 'no_sources';
  }

  // Provider credentials / configuration (an OpenRouter 401 "User not found",
  // a missing key on the engine, our own engine key rejected).
  if (
    /\bstatus (401|403)\b/.test(m) || /\b(401|403)\b.*\b(unauthori[sz]ed|forbidden)\b/.test(m)
    || /engine returned (401|403)\b/.test(m)
    || has(m, 'unauthorized', 'unauthorised', 'invalid api key', 'invalid_api_key', 'incorrect api key',
      'no auth credentials', 'user not found', 'missing or invalid x-internal-key', 'not configured',
      'need openrouter_api_key', 'no openrouter_api_key', 'authentication failed', 'api key')
  ) {
    return 'provider_auth';
  }

  // Rate limits and provider-side quota/credit exhaustion (OpenRouter 402).
  if (
    /\bstatus (429|402)\b/.test(m) || /engine returned 429\b/.test(m)
    || has(m, 'rate limit', 'rate-limit', 'ratelimit', 'too many requests', 'quota exceeded',
      'insufficient credits', 'requires more credits', 'resource exhausted', 'resource_exhausted')
  ) {
    return 'provider_rate_limited';
  }

  // Capacity / queue / polling budget.
  if (has(m, 'analyze capacity', 'retry shortly', 'polling budget', 'did not finish within')) return 'engine_busy';

  // Timeouts.
  if (has(m, 'context deadline exceeded', 'aborted due to timeout', 'timeouterror', 'aborterror', 'etimedout', 'timed out', 'timeout')) {
    return 'engine_timeout';
  }

  // Connection failures. "fetch failed with status N" is the crawler failing
  // on ONE competitor page, and "SERP fetch failed" is the SERP provider (5xx
  // rule below) — neither is us failing to reach the engine.
  if (
    (m.includes('fetch failed') && !m.includes('fetch failed with status') && !m.includes('serp fetch failed'))
    || has(m, 'econnrefused', 'econnreset', 'socket hang up', 'enotfound', 'eai_again', 'network error')
  ) {
    return 'engine_unavailable';
  }

  // Any 5xx from the engine or an upstream provider.
  if (
    /engine returned 5\d\d\b/.test(m) || /\bstatus 5\d\d\b/.test(m) || /api error \(status 5\d\d\)/.test(m)
    || has(m, 'internal server error', 'bad gateway', 'service unavailable', 'gateway timeout', 'serp fetch failed')
  ) {
    return 'server_error';
  }

  // The engine refused the input (400/404/413 not covered above).
  if (/engine returned 4\d\d\b/.test(m)) return 'invalid_request';

  return 'unknown';
}

/** The fields to $set on Content for a failure. Never includes the raw text. */
function failureFields(raw, forcedCode) {
  const code = isCode(forcedCode) ? forcedCode : classifyAnalysisFailure(raw);
  const spec = CODES[code];
  return {
    analysisStatus: 'failed',
    analysisErrorCode: code,
    analysisError: (spec.retryFree ? FREE_PREFIX : '') + spec.message,
  };
}

/**
 * Client view of the stored failure. Handles rows written before this change
 * (no analysisErrorCode; analysisError holds a raw engine message, possibly
 * with the legacy `transient: ` prefix) by classifying the legacy text, so an
 * old OpenRouter-401 failure also gets its free retry.
 *
 * Response fields (getBenchmark):
 *   analysisError         string  same as stored ('transient: ' + copy or copy)
 *   analysisErrorCode     string  stable code, '' when not failed
 *   analysisErrorMessage  string  friendly copy without any prefix, '' when not failed
 *   analysisRetryFree     boolean true → POST /retry-analysis (free); false → /reanalyze (paid)
 */
function presentAnalysisError(content) {
  const status = content?.analysisStatus;
  const stored = String(content?.analysisError || '');
  if (status !== 'failed') {
    return { analysisError: '', analysisErrorCode: '', analysisErrorMessage: '', analysisRetryFree: false };
  }
  let code = content?.analysisErrorCode;
  if (!isCode(code)) {
    const legacyText = stored.startsWith('transient:') ? stored.slice('transient:'.length) : stored;
    code = classifyAnalysisFailure(legacyText);
    // A legacy row tagged transient stays free even if its text is unrecognised.
    if (stored.startsWith('transient:') && !CODES[code].retryFree) code = 'server_error';
  }
  const spec = CODES[code];
  return {
    analysisError: (spec.retryFree ? FREE_PREFIX : '') + spec.message,
    analysisErrorCode: code,
    analysisErrorMessage: spec.message,
    analysisRetryFree: spec.retryFree,
  };
}

module.exports = {
  ANALYSIS_ERROR_CODES: CODES,
  FREE_PREFIX,
  classifyAnalysisFailure,
  failureFields,
  presentAnalysisError,
};
