/**
 * Phase 6 — the monitoring view for /image.
 *
 * Images are the only thing the engine buys per UNIT rather than per token, so
 * a single tenant can run up real money without moving any token-based
 * dashboard. This is the view an operator checks after switching /image on, and
 * the one that says whether to switch it back off.
 *
 * Two halves, tested separately:
 *  - the ledger RECORDS the image count (it previously only fed the price, so
 *    the count was unqueryable);
 *  - the endpoint AGGREGATES it per org, clamped so a hostile query cannot turn
 *    it into a full-table scan.
 *
 * AiCostLedger.create/aggregate are monkey-patched — no DB, matching
 * aiCostLedger.test.js.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AiCostLedger = require('../src/models/AiCostLedger');
const costLedger = require('../src/services/costLedgerService');

let created = [];
AiCostLedger.create = async (doc) => { created.push(doc); return { ...doc, _id: 'test' }; };
beforeEach(() => { created = []; });

// ─── The count reaches the permanent record ──────────────────

test('an image row records the COUNT, not just the cost', async () => {
  // Before this the count fed costFor() and was thrown away, so "how many
  // images did this org generate" was answerable only as costUsd ÷ unit price
  // — which breaks the moment the price changes.
  await costLedger.record({
    action: 'image',
    model: 'google/gemini-2.5-flash-image',
    images: 4,
    organizationId: 'org1',
    tier: 'professional',
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].images, 4);
  assert.ok(created[0].costUsd > 0, 'the count must still drive the price');
});

test('a non-image row records zero images rather than undefined', async () => {
  await costLedger.record({ action: 'chat', model: 'google/gemini-2.5-flash', tokensIn: 10, tokensOut: 5 });
  assert.equal(created[0].images, 0);
});

test('a hostile or broken count cannot corrupt the totals', async () => {
  // The agent path's count originates in an SSE payload. The controller clamps
  // it, but this value is summed into per-org figures an operator acts on, so
  // it is clamped here too.
  for (const bad of [-5, Number.NaN, Infinity, -Infinity, 'many', null, undefined, {}, []]) {
    created = [];
    await costLedger.record({ action: 'image', model: 'google/gemini-2.5-flash-image', images: bad });
    const got = created[0].images;
    assert.ok(Number.isFinite(got) && got >= 0,
      `images=${JSON.stringify(bad)} recorded as ${got}`);
  }
});

test('a fractional count is rounded, never stored as a fraction', async () => {
  await costLedger.record({ action: 'image', model: 'google/gemini-2.5-flash-image', images: 2.6 });
  assert.equal(created[0].images, 3);
});

// ─── The aggregation ─────────────────────────────────────────

function captureAggregate() {
  const calls = [];
  AiCostLedger.aggregate = async (pipeline) => { calls.push(pipeline); return []; };
  return calls;
}

test('imageSpendByOrg looks only at image rows, grouped by org', async () => {
  const calls = captureAggregate();
  await AiCostLedger.imageSpendByOrg({ sinceMs: 1000 });

  const [pipeline] = calls;
  const match = pipeline.find((s) => s.$match);
  assert.equal(match.$match.action, 'image',
    'without this the query sums every action and image spend hides inside the article total');
  assert.ok(match.$match.createdAt.$gte instanceof Date, 'must be time-bounded');

  const group = pipeline.find((s) => s.$group);
  assert.equal(group.$group._id, '$organizationId');
  assert.deepEqual(group.$group.images, { $sum: '$images' });
  assert.deepEqual(group.$group.costUsd, { $sum: '$costUsd' });

  const sort = pipeline.find((s) => s.$sort);
  assert.equal(sort.$sort.costUsd, -1, 'worst spender first — that is the whole point of the view');
});

test('imageSpendByOrg always caps the result set', async () => {
  const calls = captureAggregate();
  // A caller asking for everything must not get an unbounded scan back.
  await AiCostLedger.imageSpendByOrg({ limit: 10_000 });
  await AiCostLedger.imageSpendByOrg({ limit: 0 });
  await AiCostLedger.imageSpendByOrg({ limit: -1 });
  await AiCostLedger.imageSpendByOrg({ limit: 'lots' });

  for (const pipeline of calls) {
    const limit = pipeline.find((s) => s.$limit);
    assert.ok(limit, 'every query must carry a $limit');
    assert.ok(limit.$limit >= 1 && limit.$limit <= 100, `$limit was ${limit.$limit}`);
  }
});

test('imageSpendByOrg projects a named org field, not a bare _id', async () => {
  const calls = captureAggregate();
  await AiCostLedger.imageSpendByOrg({});
  const project = calls[0].find((s) => s.$project);
  assert.ok(project, 'callers should not have to know the group key was _id');
  assert.equal(project.$project.organizationId, '$_id');
  assert.equal(project.$project._id, 0);
});

// ─── The endpoint ────────────────────────────────────────────

const controller = require('../src/controllers/adminSettingsController');

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('the endpoint totals what it returns', async () => {
  AiCostLedger.imageSpendByOrg = async () => ([
    { organizationId: 'a', costUsd: 1.5, images: 30, rows: 8 },
    { organizationId: 'b', costUsd: 0.5, images: 10, rows: 3 },
  ]);
  const res = mockRes();
  await controller.getImageSpend({ query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totals.costUsd, 2);
  assert.equal(res.body.totals.images, 40);
  assert.equal(res.body.orgs.length, 2);
  // The recording gap is stated in the payload, so a low count over an old
  // window reads as "not recorded yet" rather than "a quiet month".
  assert.match(res.body.note, /before the images column/i);
});

test('the endpoint clamps days and limit before querying', async () => {
  const seen = [];
  AiCostLedger.imageSpendByOrg = async (opts) => { seen.push(opts); return []; };

  await controller.getImageSpend({ query: { days: '9999', limit: '9999' } }, mockRes());
  await controller.getImageSpend({ query: { days: '-3', limit: '-3' } }, mockRes());
  await controller.getImageSpend({ query: { days: 'abc', limit: 'abc' } }, mockRes());

  for (const opts of seen) {
    const days = opts.sinceMs / (24 * 60 * 60 * 1000);
    assert.ok(days >= 1 && days <= 90, `days resolved to ${days}`);
    assert.ok(opts.limit >= 1 && opts.limit <= 100, `limit resolved to ${opts.limit}`);
  }
});

test('a failed query is a 500, not a crash or a silent empty list', async () => {
  // An empty list would read as "no image spend", which is the opposite of
  // what an operator needs to conclude when the query is broken.
  AiCostLedger.imageSpendByOrg = async () => { throw new Error('mongo down'); };
  const res = mockRes();
  await controller.getImageSpend({ query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.ok(!Array.isArray(res.body.orgs));
});
