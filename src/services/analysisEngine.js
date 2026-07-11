/**
 * Analysis Engine client — thin wrapper over the SEO analysis engine
 * (analyze / discover / score / recommend-outline / bot-access, all under
 * /api/*).
 *
 * The analysis engine is a SEPARATE app from the writing engine
 * (WRITING_ENGINE_URL, /api/session/*). It is resolved ONLY from ENGINE_URL so
 * a split-host deploy can point each at its own service.
 *
 * This module exists to kill a bug class: before it, every call site
 * re-implemented base-URL resolution + auth headers by hand, and the two the
 * audit found were exactly the ones that hand-rolled it wrong — driftService
 * dropped X-Internal-Key (401 on every keyed deploy), and a shared const once
 * fell back to WRITING_ENGINE_URL (cross-wired the two engines). Routing every
 * call through engineFetch means no site can forget the key or pick the wrong
 * host again (enforced by tests/engineFetchContainment.test.js).
 */

const { engineHeaders } = require('./writingEngine');

// Resolve ONLY ENGINE_URL — never fall back to WRITING_ENGINE_URL.
const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8090';

// Every engine call must be bounded. The original inline fetches each set an
// explicit AbortSignal.timeout; a client that made the timeout optional would
// silently allow an unbounded request (connection/worker held forever) if a
// caller forgot it. So timeoutMs defaults here — callers with a longer budget
// (analyze 330s, fetch-page 95s) pass their own; nobody can accidentally opt
// out of a timeout entirely.
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Call an analysis-engine endpoint. Owns base-URL resolution, the
 * X-Internal-Key auth header (via engineHeaders), the optional model-preset
 * header, and the request timeout.
 *
 * Returns the raw fetch Response — callers keep their own .ok / .json() /
 * .text() and error handling, which varies by endpoint (best-effort discover,
 * bot-access 400→400 else→502, importUrl JSON-or-text upstream body, etc.).
 *
 * @param {string} path - engine path beginning with '/', e.g. '/api/score'
 * @param {object} [opts]
 * @param {string} [opts.method='POST'] - HTTP method
 * @param {object} [opts.body] - JSON body (stringified here; omit for none)
 * @param {number} [opts.timeoutMs=DEFAULT_TIMEOUT_MS] - AbortSignal.timeout duration in ms
 * @param {string} [opts.preset] - model preset → X-Model-Preset header
 * @param {object} [opts.headers] - extra headers (merged after the preset header)
 * @param {AbortSignal} [opts.signal] - caller signal; used instead of the timeout when set
 * @returns {Promise<Response>}
 */
function engineFetch(path, { method = 'POST', body, timeoutMs = DEFAULT_TIMEOUT_MS, preset, headers, signal } = {}) {
  const extra = { ...(preset ? { 'X-Model-Preset': preset } : {}), ...headers };
  return fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: engineHeaders(extra),
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
}

module.exports = { engineFetch, ENGINE_URL };
