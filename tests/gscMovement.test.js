'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const Content = require('../src/models/Content');
const Site = require('../src/models/Site');
const gscService = require('../src/services/gscService');
const contentController = require('../src/controllers/contentController');

// Minimal res double capturing status + json.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const REQ = { workspace: { _id: 'w1', organizationId: 'org1' }, params: { contentNumber: '1' }, query: {} };
const validSiteId = new mongoose.Types.ObjectId().toString();

// Save/restore the mocked dependency methods around each test.
const orig = {};
test.beforeEach(() => {
  orig.findByNumber = Content.findByNumber;
  orig.siteFindOne = Site.findOne;
  orig.getKeywordPosition = gscService.getKeywordPosition;
});
test.afterEach(() => {
  Content.findByNumber = orig.findByNumber;
  Site.findOne = orig.siteFindOne;
  gscService.getKeywordPosition = orig.getKeywordPosition;
});

function stubContent(over = {}) {
  Content.findByNumber = async () => ({
    locked: false,
    targetKeywords: ['standing desk'],
    targetPageUrl: 'https://site.com/desks',
    strikingSnapshot: { positionAtStart: 11.2, siteId: validSiteId, dateRange: '28d', snapshotAt: new Date() },
    ...over,
  });
}

test('happy path: reports positive delta when the page moved up', async () => {
  stubContent();
  Site.findOne = async () => ({ locked: false, gscPropertyId: 'sc-domain:site.com' });
  let gotPage;
  gscService.getKeywordPosition = async (o, s, kw, dr, opts) => { gotPage = opts.page; return 6.4; };
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.positionAtStart, 11.2);
  assert.strictEqual(res.body.currentPosition, 6.4);
  assert.strictEqual(res.body.delta, 4.8); // 11.2 - 6.4, positive = improved
  assert.strictEqual(gotPage, 'https://site.com/desks'); // apples-to-apples page filter passed
});

test('negative delta when the page slipped', async () => {
  stubContent();
  Site.findOne = async () => ({ locked: false, gscPropertyId: 'x' });
  gscService.getKeywordPosition = async () => 15.0;
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.strictEqual(res.body.delta, -3.8); // 11.2 - 15.0
});

test('current position null (no longer ranking) -> delta null, still available', async () => {
  stubContent();
  Site.findOne = async () => ({ locked: false, gscPropertyId: 'x' });
  gscService.getKeywordPosition = async () => null;
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.currentPosition, null);
  assert.strictEqual(res.body.delta, null);
});

test('no snapshot -> available false', async () => {
  stubContent({ strikingSnapshot: null });
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.deepStrictEqual(res.body, { available: false });
});

test('malformed siteId -> available false (no CastError/500)', async () => {
  stubContent({ strikingSnapshot: { positionAtStart: 11, siteId: 'not-an-objectid', dateRange: '28d' } });
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { available: false });
});

test('locked content -> 403', async () => {
  stubContent({ locked: true });
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.strictEqual(res.statusCode, 403);
});

test('site not found / locked -> available false', async () => {
  stubContent();
  Site.findOne = async () => null;
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.deepStrictEqual(res.body, { available: false });
});

test('GSC disconnected -> available false with reason', async () => {
  stubContent();
  Site.findOne = async () => ({ locked: false, gscPropertyId: 'x' });
  gscService.getKeywordPosition = async () => { const e = new Error('revoked'); e.code = 'GSC_NOT_CONNECTED'; throw e; };
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.strictEqual(res.body.available, false);
  assert.strictEqual(res.body.reason, 'gsc_disconnected');
});

test('no keyword -> available false', async () => {
  stubContent({ targetKeywords: [] });
  const res = mockRes();
  await contentController.getMovement(REQ, res);
  assert.deepStrictEqual(res.body, { available: false });
});
