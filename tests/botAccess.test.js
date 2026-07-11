/**
 * Rec 7 — AI crawler access audit endpoint. Site model + global.fetch are
 * monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Site = require('../src/models/Site');
const { getBotAccess } = require('../src/controllers/analysisController');

const realFindOne = Site.findOne;
const realFetch = global.fetch;
after(() => {
  Site.findOne = realFindOne;
  global.fetch = realFetch;
});

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// Raw engine report (snake_case) — this is what the engine returns and what we
// persist on the Site unchanged.
const REPORT = {
  robots_url: 'https://example.com/robots.txt',
  robots_status: 200,
  verdicts: [{ bot: 'GPTBot', allowed: false, source: 'robots_group' }],
  cdn_block: { normal_status: 200, bot_ua_status: 403, blocked: true },
  guidance: ['GPTBot is blocked in robots.txt — ...'],
};

// Curated camelCase shape (curateBotAccess output) — the API's response
// contract. Storage stays REPORT; only the response is remapped.
const CURATED = {
  robotsUrl: 'https://example.com/robots.txt',
  robotsStatus: 200,
  verdicts: [{ bot: 'GPTBot', allowed: false, source: 'robots_group' }],
  cdnBlock: { normalStatus: 200, botUaStatus: 403, blocked: true },
  guidance: ['GPTBot is blocked in robots.txt — ...'],
};

function makeSite(overrides = {}) {
  return {
    _id: 's1',
    url: 'https://example.com',
    botAccess: null,
    botAccessCheckedAt: null,
    saved: false,
    markModified() {},
    async save() { this.saved = true; },
    ...overrides,
  };
}

describe('getBotAccess', () => {
  let site; let fetchCalls;
  beforeEach(() => {
    fetchCalls = [];
    site = makeSite();
    Site.findOne = async () => site;
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => REPORT };
    };
  });

  it('404s when the workspace has no site', async () => {
    Site.findOne = async () => null;
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(r.statusCode, 404);
  });

  it('fresh check: calls the engine, persists, returns cached:false', async () => {
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/api\/bot-access$/);
    assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), { url: 'https://example.com' });
    assert.equal(r.body.cached, false);
    assert.deepEqual(r.body.botAccess, CURATED, 'response is curated to camelCase');
    assert.equal(site.saved, true, 'report persisted to the Site');
    assert.deepEqual(site.botAccess, REPORT, 'storage stays raw engine snake_case');
    assert.ok(site.botAccessCheckedAt instanceof Date);
  });

  it('cache hit within 7 days: no engine call, cached:true', async () => {
    site.botAccess = REPORT;
    site.botAccessCheckedAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day old
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(fetchCalls.length, 0, 'must not hit the engine');
    assert.equal(r.body.cached, true);
    assert.deepEqual(r.body.botAccess, CURATED, 'cached path is curated too');
  });

  it('stale cache (>7 days): re-checks', async () => {
    site.botAccess = REPORT;
    site.botAccessCheckedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(fetchCalls.length, 1);
    assert.equal(r.body.cached, false);
  });

  it('refresh=1 bypasses a fresh cache', async () => {
    site.botAccess = REPORT;
    site.botAccessCheckedAt = new Date();
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: { refresh: '1' } }, r);
    assert.equal(fetchCalls.length, 1);
    assert.equal(r.body.cached, false);
  });

  it('engine 500 → 502', async () => {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(r.statusCode, 502);
  });

  it('engine 400 (bad site URL) → 400', async () => {
    global.fetch = async () => ({ ok: false, status: 400, text: async () => 'url host is not allowed' });
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(r.statusCode, 400);
  });

  it('engine timeout → 504', async () => {
    global.fetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(r.statusCode, 504);
  });

  it('engine unreachable (TypeError) → 502', async () => {
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    const r = res();
    await getBotAccess({ workspace: { _id: 'ws1' }, query: {} }, r);
    assert.equal(r.statusCode, 502);
  });
});
