/**
 * Scriptable global-fetch stub for every AI-vendor endpoint the tracker
 * scan engine calls.
 *
 * Mechanism: replaces `globalThis.fetch` directly. The backend has zero
 * axios/node-fetch usage — everything goes through Node's global fetch —
 * and stubbing the global avoids the npm-undici MockAgent gotcha where
 * `setGlobalDispatcher` may not intercept Node's *bundled* fetch.
 *
 * Usage:
 *   const vendorMock = require('./helpers/vendorMock');
 *   vendorMock.install();
 *   vendorMock.script({
 *     chatgpt: [vendorMock.jsonReply(fixture), { status: 500, text: 'boom' }],
 *     kimi:    [vendorMock.jsonReply(analyzerFixture)],
 *   });
 *   ... run code under test ...
 *   vendorMock.calls  // → [{ vendor, url, method, body }] for assertions
 *   vendorMock.uninstall();
 *
 * Unmatched hosts THROW by default — a test that reaches a real vendor is
 * a broken test, and the throw doubles as a hermeticity proof.
 *
 * Step shape: { status=200, json, text, headers={}, delayMs, error }
 *   - `error`: an Error to reject the fetch promise with (network failure).
 *   - `delayMs`: latency before responding.
 *   - a step may also be a function (url, init) => step, for dynamic replies.
 * When a vendor's queue runs dry: if the last step had `repeat: true` it is
 * reused forever; otherwise the call throws (script exhausted).
 */

const HOSTS = {
  chatgpt: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  claude: 'api.anthropic.com',
  perplexity: 'api.perplexity.ai',
  kimi: 'openrouter.ai', // analyzer — moonshotai/kimi-k2 via OpenRouter
  geminiRedirect: 'vertexaisearch.cloud.google.com',
  // Keyword Research licensed-data vendors (Phase B). Same scripting API —
  // one mock covers both features so hermeticity rules stay identical.
  dataforseo: 'api.dataforseo.com',
  serper: 'google.serper.dev',
};

const HOST_TO_VENDOR = Object.fromEntries(Object.entries(HOSTS).map(([v, h]) => [h, v]));

let realFetch = null;
let queues = {};
let installed = false;

const calls = [];

function jsonReply(obj, extra = {}) {
  return { status: 200, json: obj, ...extra };
}

function script(perVendor) {
  queues = {};
  for (const [vendor, steps] of Object.entries(perVendor)) {
    if (!HOSTS[vendor]) throw new Error(`vendorMock.script: unknown vendor '${vendor}'`);
    queues[vendor] = [...steps];
  }
  calls.length = 0;
}

function makeResponse(step) {
  const headers = new Map(Object.entries(step.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const bodyText = step.json !== undefined ? JSON.stringify(step.json) : (step.text ?? '');
  return {
    ok: (step.status ?? 200) >= 200 && (step.status ?? 200) < 300,
    status: step.status ?? 200,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
  };
}

async function fakeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const host = new URL(url).hostname;
  const vendor = HOST_TO_VENDOR[host];

  if (!vendor) {
    throw new Error(`vendorMock: unmocked fetch to ${host} (${url}) — tests must script every host they reach`);
  }

  calls.push({ vendor, url, method: init.method || 'GET', body: init.body ? String(init.body) : null });

  const queue = queues[vendor];
  if (!queue || queue.length === 0) {
    throw new Error(`vendorMock: script exhausted for '${vendor}' (call #${calls.filter((c) => c.vendor === vendor).length} to ${url})`);
  }

  let step = queue[0].repeat ? queue[0] : queue.shift();
  if (typeof step === 'function') step = step(url, init);

  if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
  if (step.error) throw step.error;
  return makeResponse(step);
}

function install() {
  if (installed) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  installed = true;
}

function uninstall() {
  if (!installed) return;
  globalThis.fetch = realFetch;
  realFetch = null;
  installed = false;
}

module.exports = { HOSTS, install, uninstall, script, jsonReply, calls };
