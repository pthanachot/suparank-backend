/**
 * Phase B review addition — K5 applied to EVERY handler, not just the two
 * that call vendors.
 *
 * The review found K5 (no raw error text in 5xx bodies) had been applied to
 * searchKeywords, getKeywordDetail and deleteSearchHistory, but NOT to
 * getSearchHistory or getCachedResults — those still returned
 * `err.message` straight to the client. The original failure matrix missed
 * it because it only ever drove the two vendor-calling handlers.
 *
 * This sweeps all five: force the first DB call in each to throw an error
 * carrying a sentinel, then assert the sentinel never reaches the client.
 * A handler added later without the guard fails here.
 *
 * Run: node --test tests/keywords/error-leak-sweep.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const db = require('../aiTracker/helpers/db');
const vendorMock = require('../aiTracker/helpers/vendorMock');
const { seedWorld, seedTierConfigs, buildReq, makeRes } = require('./helpers/world');

const KeywordSearch = require('../../src/models/KeywordSearch');
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');
const keywordController = require('../../src/controllers/keywordController');

/**
 * A Mongoose-shaped message of the kind that actually leaks: it names the
 * model, the field path and echoes the caller's raw input.
 */
const SENTINEL = 'Cast to ObjectId failed for value "SEKRIT-INTERNAL-VALUE" at path "workspaceId" for model "KeywordResearchHistory"';

/** Every handler that can 500, with the model call to poison. */
const HANDLERS = [
  { name: 'getSearchHistory', model: KeywordResearchHistory, method: 'find', call: (req, res) => keywordController.getSearchHistory(req, res) },
  {
    // Poison the K1 own-workspace history lookup: it is the FIRST db call,
    // ahead of the KeywordSearch cache read.
    name: 'getCachedResults',
    model: KeywordResearchHistory,
    method: 'findOne',
    call: (req, res) => keywordController.getCachedResults(
      { ...req, query: { kw: 'anything', country: 'United States' } }, res,
    ),
  },
  {
    name: 'deleteSearchHistory',
    model: KeywordResearchHistory,
    method: 'findOneAndDelete',
    call: (req, res) => keywordController.deleteSearchHistory(
      { ...req, params: { ...req.params, historyId: '507f1f77bcf86cd799439011' } }, res,
    ),
  },
];

before(async () => {
  await db.connect();
  await db.clear();
  await seedTierConfigs();
  vendorMock.install();
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

beforeEach(async () => {
  vendorMock.script({});
  await KeywordSearch.deleteMany({});
  await KeywordResearchHistory.deleteMany({});
});

describe('K5 leak sweep — no handler returns raw error text', () => {
  for (const h of HANDLERS) {
    it(`${h.name}: a DB error yields a generic 500`, { timeout: 60_000 }, async () => {
      const world = await seedWorld();
      const req = await buildReq(world, { body: {} });
      const res = makeRes();

      const original = h.model[h.method];
      h.model[h.method] = () => { throw new Error(SENTINEL); };
      try {
        await h.call(req, res);
      } finally {
        h.model[h.method] = original;
      }

      assert.equal(res.statusCode, 500, `${h.name}: expected a 500`);
      const serialized = JSON.stringify(res.body);
      assert.ok(
        !serialized.includes('SEKRIT-INTERNAL-VALUE'),
        `${h.name}: echoed the caller's raw input back — ${serialized}`,
      );
      for (const leak of ['Cast to ObjectId', 'at path', 'for model', 'KeywordResearchHistory']) {
        assert.ok(!serialized.includes(leak), `${h.name}: leaked schema internals ("${leak}") — ${serialized}`);
      }
      assert.ok(res.body.error.startsWith('Failed to'), `${h.name}: expected a "Failed to …" message, got ${res.body.error}`);
    });
  }
});
