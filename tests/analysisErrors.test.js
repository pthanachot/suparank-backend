/**
 * QA Nov 2026 (B09, B40) — analysis failure classifier, stored fields and the
 * client view, plus the free-retry route accepting server-side failures.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ANALYSIS_ERROR_CODES, classifyAnalysisFailure, failureFields, presentAnalysisError,
} = require('../src/services/analysisErrors');
const analysisController = require('../src/controllers/analysisController');
const Content = require('../src/models/Content');

const free = (raw) => ANALYSIS_ERROR_CODES[classifyAnalysisFailure(raw)].retryFree;

test('server-side failures classify as free retries', () => {
  const cases = {
    'Engine returned 502: openrouter returned status 401: {"error":{"message":"User not found.","code":401}}': 'provider_auth',
    'Engine returned 502: openrouter returned status 401: {"error":{"message":"No auth credentials found","code":401}}': 'provider_auth',
    'Engine returned 503: pipeline not configured (need OPENROUTER_API_KEY)': 'provider_auth',
    'Engine returned 401: missing or invalid X-Internal-Key': 'provider_auth',
    'Engine returned 502: openrouter returned status 429: rate limited': 'provider_rate_limited',
    'Engine returned 502: openrouter returned status 402: requires more credits': 'provider_rate_limited',
    'Engine returned 502: openrouter returned status 503: upstream unavailable': 'server_error',
    'Engine returned 500: internal server error': 'server_error',
    'Engine returned 502: SERP fetch failed: serper returned status 500: oops': 'server_error',
    'Engine returned 503: server at analyze capacity; retry shortly': 'engine_busy',
    'engine analyze job did not finish within the polling budget': 'engine_busy',
    'structure synthesis: read response: context deadline exceeded': 'engine_timeout',
    'The operation was aborted due to timeout': 'engine_timeout',
    'fetch failed': 'engine_unavailable',
    'connect ECONNREFUSED 127.0.0.1:8080': 'engine_unavailable',
    'engine analyze job lost (engine restarted); retry the analysis': 'server_restart',
    'Analysis interrupted by server restart': 'server_restart',
  };
  for (const [raw, code] of Object.entries(cases)) {
    assert.equal(classifyAnalysisFailure(raw), code, raw);
    assert.equal(free(raw), true, `${raw} should be a free retry`);
  }
});

test('content problems stay paid (a retry with the same input cannot help)', () => {
  const cases = {
    'Engine returned 404: no SERP results found for any keyword': 'no_serp_results',
    'could not crawl any competitor pages': 'no_sources',
    'Engine returned 502: AI analysis failed — no citations or crawlable sources': 'no_sources',
    'Engine returned 400: keywords are required': 'invalid_request',
  };
  for (const [raw, code] of Object.entries(cases)) {
    assert.equal(classifyAnalysisFailure(raw), code, raw);
    assert.equal(free(raw), false, `${raw} should not be free`);
  }
});

test('a crawler "fetch failed with status" is not an engine-unreachable failure', () => {
  assert.notEqual(classifyAnalysisFailure('fetch failed with status 403 (no fallback fetch service configured)'), 'engine_unavailable');
});

test('failureFields stores code + copy, never the raw text, and prefixes free retries', () => {
  const raw = 'Engine returned 502: openrouter returned status 401: {"error":"User not found."}';
  const f = failureFields(raw);
  assert.equal(f.analysisStatus, 'failed');
  assert.equal(f.analysisErrorCode, 'provider_auth');
  assert.match(f.analysisError, /^transient: /);
  assert.doesNotMatch(f.analysisError, /openrouter|401|User not found/);
  const paid = failureFields('Engine returned 404: no SERP results found for any keyword');
  assert.doesNotMatch(paid.analysisError, /^transient:/);
  assert.equal(failureFields('x', 'server_error').analysisErrorCode, 'server_error', 'forced code wins');
});

test('all copy is friendly: no em dashes, no internals', () => {
  for (const [code, spec] of Object.entries(ANALYSIS_ERROR_CODES)) {
    assert.doesNotMatch(spec.message, /—/, `${code} uses an em dash`);
    assert.doesNotMatch(spec.message, /engine|openrouter|status \d/i, `${code} leaks internals`);
  }
});

test('presentAnalysisError: coded rows, legacy raw rows, and non-failed rows', () => {
  const coded = presentAnalysisError({ analysisStatus: 'failed', ...failureFields('fetch failed') });
  assert.deepEqual(Object.keys(coded).sort(), ['analysisError', 'analysisErrorCode', 'analysisErrorMessage', 'analysisRetryFree']);
  assert.equal(coded.analysisErrorCode, 'engine_unavailable');
  assert.equal(coded.analysisRetryFree, true);
  assert.equal(coded.analysisError, `transient: ${coded.analysisErrorMessage}`);

  // Legacy: raw provider 401 stored without the prefix → now free, copy replaced.
  const legacy = presentAnalysisError({ analysisStatus: 'failed', analysisError: 'Engine returned 502: openrouter returned status 401: nope' });
  assert.equal(legacy.analysisErrorCode, 'provider_auth');
  assert.equal(legacy.analysisRetryFree, true);
  assert.doesNotMatch(legacy.analysisError, /openrouter/);

  // Legacy transient row with unrecognised text stays free.
  const legacyTransient = presentAnalysisError({ analysisStatus: 'failed', analysisError: 'transient: weird thing' });
  assert.equal(legacyTransient.analysisRetryFree, true);

  const ready = presentAnalysisError({ analysisStatus: 'ready', analysisError: 'stale raw text' });
  assert.deepEqual(ready, { analysisError: '', analysisErrorCode: '', analysisErrorMessage: '', analysisRetryFree: false });
});

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function callRetry(row) {
  const saved = { findByNumber: Content.findByNumber, upd: Content.findByIdAndUpdate, findById: Content.findById };
  Content.findByNumber = async () => ({ _id: 'c1', contentNumber: 5, locked: false, targetKeywords: ['k'], ...row });
  Content.findByIdAndUpdate = async () => ({});
  Content.findById = async () => null;
  const res = mkRes();
  try {
    await analysisController.retryAnalysis({ params: { contentNumber: 5 }, workspace: { _id: 'w1' }, user: { userId: 'u1' } }, res);
  } finally {
    Content.findByNumber = saved.findByNumber;
    Content.findByIdAndUpdate = saved.upd;
    Content.findById = saved.findById;
  }
  return res;
}

test('retry-analysis is free for a provider 401, coded or legacy', async () => {
  const coded = await callRetry({ analysisStatus: 'failed', ...failureFields('Engine returned 502: openrouter returned status 401: x') });
  assert.equal(coded.statusCode, 200);
  const legacy = await callRetry({ analysisStatus: 'failed', analysisError: 'Engine returned 500: internal server error' });
  assert.equal(legacy.statusCode, 200, 'a pre-change raw 5xx row is now a free retry');
  const paid = await callRetry({ analysisStatus: 'failed', ...failureFields('Engine returned 404: no SERP results found for any keyword') });
  assert.equal(paid.statusCode, 409);
});

test('getBenchmark never sends the raw stored error', async () => {
  const saved = Content.findByNumber;
  Content.findByNumber = async () => ({
    _id: 'c1', contentNumber: 5, locked: false, analysisStatus: 'failed',
    analysisError: 'Engine returned 502: openrouter returned status 401: {"error":"User not found."}',
  });
  const res = mkRes();
  try {
    await analysisController.getBenchmark({ params: { contentNumber: 5 }, workspace: { _id: 'w1' }, user: { userId: 'u1' }, query: {} }, res);
  } finally {
    Content.findByNumber = saved;
  }
  assert.equal(res.body.analysisErrorCode, 'provider_auth');
  assert.equal(res.body.analysisRetryFree, true);
  assert.doesNotMatch(JSON.stringify(res.body), /openrouter|User not found/);
});

// ── QA B40 follow-up (Nov 21): an unclassifiable failure is ours ──

test('an unrecognised engine failure is a free retry, with no-em-dash copy', () => {
  for (const raw of ['something nobody anticipated', '', 'pipeline: unexpected state 7']) {
    assert.equal(classifyAnalysisFailure(raw), 'unknown', raw);
    assert.equal(free(raw), true, `${JSON.stringify(raw)} should be free`);
  }
  const msg = ANALYSIS_ERROR_CODES.unknown.message;
  assert.match(msg, /on our side/);
  assert.match(msg, /free/);
  assert.doesNotMatch(msg, /—/);
});

test('every customer-caused code stays paid, every other code is free', () => {
  const paid = Object.entries(ANALYSIS_ERROR_CODES).filter(([, s]) => !s.retryFree).map(([c]) => c).sort();
  assert.deepEqual(paid, ['invalid_request', 'no_serp_results', 'no_sources']);
});

test('stored unknown failure: client view offers the free retry, and the route accepts it', async () => {
  const fields = failureFields('pipeline: unexpected state 7');
  assert.equal(fields.analysisErrorCode, 'unknown');
  const view = presentAnalysisError({ analysisStatus: 'failed', ...fields });
  assert.equal(view.analysisRetryFree, true);
  assert.ok(view.analysisError.startsWith('transient:'), 'the sidebar keys "Retry (free)" off this prefix');
  const r = await callRetry({ analysisStatus: 'failed', ...fields });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.analysisStatus, 'pending');
});

test('a legacy row with unrecognised text (no code) is also a free retry', async () => {
  const r = await callRetry({ analysisStatus: 'failed', analysisError: 'weird legacy text' });
  assert.equal(r.statusCode, 200);
});
