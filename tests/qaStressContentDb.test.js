/**
 * QA Nov 2026 stress pass — content revision (B03) and article quota (B24)
 * against a REAL (in-memory) MongoDB, where atomicity actually lives:
 *   - concurrent PUTs with the same baseRevision: exactly one wins;
 *   - legacy rows (no revision field) and legacy clients (no baseRevision);
 *   - partial PUTs bump the revision;
 *   - concurrent analysis starts count an article slot exactly once;
 *   - a failed analysis keeps its slot and the free retry does not recount.
 * The analysis engine is never reached: globalThis.fetch is stubbed to fail.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');
const UserUsageTracker = require('../src/models/UserUsageTracker');
const UsageTracker = require('../src/models/UsageTracker');
const contentController = require('../src/controllers/contentController');
const analysisController = require('../src/controllers/analysisController');
const articleQuota = require('../src/services/articleQuotaService');
const tierService = require('../src/services/tierService');
const imageStorage = require('../src/services/imageStorage');

const realFetch = globalThis.fetch;
const saved = [];
const stub = (o, k, v) => { saved.push([o, k, o[k]]); o[k] = v; };

before(async () => {
  await connect();
  await Content.init();
  process.env.ANALYZE_RETRY_BACKOFF_MS = '0';
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  stub(imageStorage, 'isEnabled', () => false);
});
after(async () => {
  for (let i = saved.length - 1; i >= 0; i--) { const [o, k, v] = saved[i]; o[k] = v; }
  globalThis.fetch = realFetch;
  delete process.env.ANALYZE_RETRY_BACKOFF_MS;
  await disconnect();
});
beforeEach(async () => { await clear(); });

const WS = new mongoose.Types.ObjectId();
const ORG = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
let seq = 1000;

async function makeDoc(fields = {}, { legacy = false } = {}) {
  const contentNumber = seq++;
  const doc = {
    userId: USER, workspaceId: WS, contentNumber, title: 'orig',
    blocks: [{ id: 'b1', type: 'p', text: 'hello' }], ...fields,
  };
  if (legacy) {
    // Pre-change row: written without `revision` (bypass mongoose defaults).
    await Content.collection.insertOne({ ...doc, createdAt: new Date(), updatedAt: new Date() });
  } else {
    await Content.create(doc);
  }
  return contentNumber;
}

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function put(contentNumber, body) {
  const res = mkRes();
  await contentController.updateContent({
    workspace: { _id: WS, organizationId: null }, params: { contentNumber: String(contentNumber) },
    body, user: { userId: String(USER) },
  }, res);
  return res;
}

// ─── revision ───────────────────────────────────────────────

test('legacy row + legacy client (no baseRevision) still saves, and the revision starts counting', async () => {
  const n = await makeDoc({}, { legacy: true });
  const raw = await Content.collection.findOne({ contentNumber: n });
  assert.equal('revision' in raw, false, 'precondition: legacy row has no field');
  const r = await put(n, { title: 'legacy client' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.content.revision, 1);
});

test('legacy row: baseRevision 0 matches the missing field', async () => {
  const n = await makeDoc({}, { legacy: true });
  const r = await put(n, { title: 'a', baseRevision: 0 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.content.revision, 1);
});

test('two concurrent PUTs with the same base: exactly one wins, the loser gets the winner', async () => {
  const n = await makeDoc();
  const [a, b] = await Promise.all([
    put(n, { title: 'tab A', baseRevision: 0 }),
    put(n, { title: 'tab B', baseRevision: 0 }),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409]);
  const winner = a.statusCode === 200 ? a : b;
  const loser = a.statusCode === 409 ? a : b;
  assert.equal(loser.body.error, 'revision_conflict');
  assert.equal(loser.body.revision, 1);
  assert.equal(loser.body.content.title, winner.body.content.title);
  const stored = await Content.findOne({ contentNumber: n }).lean();
  assert.equal(stored.title, winner.body.content.title);
  assert.equal(stored.revision, 1);
});

test('20 concurrent PUTs on a legacy row with base 0: exactly one write lands', async () => {
  const n = await makeDoc({}, { legacy: true });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => put(n, { title: `t${i}`, baseRevision: 0 })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 409).length, 19);
  assert.equal((await Content.findOne({ contentNumber: n }).lean()).revision, 1);
});

test('stale base → 409 carrying the server copy; resubmitting on its revision succeeds', async () => {
  const n = await makeDoc();
  assert.equal((await put(n, { title: 'v1', baseRevision: 0 })).statusCode, 200);
  const stale = await put(n, { title: 'mine', baseRevision: 0 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.content.title, 'v1');
  assert.equal(stale.body.content.favoritedBy, undefined);
  const retry = await put(n, { title: 'mine', baseRevision: stale.body.revision });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.content.revision, 2);
});

test('a base AHEAD of the server is a conflict too, never a silent write', async () => {
  const n = await makeDoc();
  const r = await put(n, { title: 'x', baseRevision: 7 });
  assert.equal(r.statusCode, 409);
  assert.equal((await Content.findOne({ contentNumber: n }).lean()).title, 'orig');
});

test('partial PUTs (publishedUrl, versions, outline approval) bump the revision', async () => {
  const n = await makeDoc();
  let rev = 0;
  for (const body of [
    { publishedUrl: 'https://example.com/a' },
    { versions: [{ id: 'v1', timestamp: 1, blocks: [{ id: 'b', type: 'p', text: 'snap' }] }] },
    { approvedOutline: { sections: [] }, outlineEdit: { depth: 'unedited' } },
    { status: 'done' },
  ]) {
    const r = await put(n, body);
    assert.equal(r.statusCode, 200, JSON.stringify(body));
    assert.equal(r.body.content.revision, ++rev);
  }
  // An editor that did not adopt those revisions now conflicts (by contract).
  assert.equal((await put(n, { title: 'stale editor', baseRevision: 0 })).statusCode, 409);
});

test('a missing doc with a baseRevision is still 404 (no conflict, no leak)', async () => {
  const r = await put(999999, { title: 'x', baseRevision: 3 });
  assert.equal(r.statusCode, 404);
});

test('a doc in ANOTHER workspace is 404 even with a matching revision', async () => {
  const n = await makeDoc({ workspaceId: new mongoose.Types.ObjectId() });
  assert.equal((await put(n, { title: 'x', baseRevision: 0 })).statusCode, 404);
});

test('stored payload is sanitized through the real schema (blocks + versions)', async () => {
  const n = await makeDoc();
  const r = await put(n, {
    baseRevision: 0,
    blocks: [{ id: 'b1', type: 'p', text: '<img src=x onerror=alert(1)><b>ok</b>' }],
    versions: [{ id: 'v', timestamp: 1, blocks: [{ id: 'b0', type: 'p', text: '<svg onload=alert(1)></svg>v' }, { id: 'b1', type: 'faq', faqItems: [{ question: '<img src=x onerror=alert(1)>q', answer: 'a' }] }] }],
  });
  assert.equal(r.statusCode, 200);
  const stored = await Content.findOne({ contentNumber: n }).lean();
  assert.equal(stored.blocks[0].text, '<b>ok</b>');
  // FAQ fields are plain text (escaped at render), so they are stored as typed.
  assert.equal(stored.versions[0].blocks[0].text, 'v');
  assert.equal(stored.versions[0].blocks[1].faqItems[0].question, '<img src=x onerror=alert(1)>q');
});

test('GET returns the revision, POST returns revision 0', async () => {
  const n = await makeDoc();
  await put(n, { title: 'x' });
  const g = mkRes();
  await contentController.getContent({ workspace: { _id: WS }, params: { contentNumber: String(n) } }, g);
  assert.equal(g.body.content.revision, 1);
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'free', config: {} }));
  const c = mkRes();
  await contentController.createContent({
    workspace: { _id: WS, organizationId: null }, user: { userId: String(USER) },
    body: { title: 'new', blocks: [{ id: 'b', type: 'p', text: '<script>x</script>hi' }] },
  }, c);
  assert.equal(c.statusCode, 201, JSON.stringify(c.body));
  assert.equal(c.body.content.revision, 0);
  assert.equal(c.body.content.blocks[0].text, 'hi');
});

// ─── article quota ───────────────────────────────────────────

const FREE = { tier: 'free', config: { maxArticlesPerMonth: 3, articleLimitType: 'lifetime' } };
const FREE_CTX = { orgId: String(ORG), userId: String(USER), isUserLevel: true, orgCounted: true, lifetime: true, quotaSource: null, workspaceId: null };

async function pendingDoc(fields = {}) {
  const n = await makeDoc({ targetKeywords: ['kw'], articleQuotaState: 'pending', articleQuotaCtx: FREE_CTX, ...fields });
  return Content.findOne({ contentNumber: n });
}

function useFreeTier() {
  stub(tierService, 'getOrgTierConfig', async () => FREE);
}

async function userArticles() {
  return UserUsageTracker.getCount(String(USER), 'articlesCreated');
}

async function settleAnalyses() {
  // Let the fire-and-forget runAnalysis calls fail against the stubbed fetch.
  for (let i = 0; i < 40; i++) {
    const busy = await Content.countDocuments({ analysisStatus: { $in: ['pending', 'analyzing'] } });
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const analyzeReq = (content) => ({
  params: { contentNumber: content.contentNumber }, workspace: { _id: WS }, user: { userId: String(USER) },
});

test('10 concurrent claims on one pending doc count it exactly once', async () => {
  useFreeTier();
  const doc = await pendingDoc();
  const results = await Promise.all(Array.from({ length: 10 }, () => articleQuota.claimArticleSlot(doc)));
  assert.equal(results.filter((r) => r.counted).length, 1);
  assert.ok(results.every((r) => r.ok));
  assert.equal(await userArticles(), 1);
  assert.equal((await Content.findById(doc._id).lean()).articleQuotaState, 'counted');
});

test('analyze → (fails) → free retry → reanalyze: one slot, never recounted', async () => {
  useFreeTier();
  const doc = await pendingDoc();
  const r1 = mkRes();
  await analysisController.triggerAnalysis(analyzeReq(doc), r1);
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  await settleAnalyses();
  const failed = await Content.findById(doc._id).lean();
  assert.equal(failed.analysisStatus, 'failed');
  assert.equal(failed.analysisErrorCode, 'engine_unavailable');
  assert.doesNotMatch(failed.analysisError, /fetch failed/, 'raw engine text never stored');
  assert.equal(await userArticles(), 1, 'the slot stays consumed after a failure');

  const r2 = mkRes();
  await analysisController.retryAnalysis(analyzeReq(doc), r2);
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  await settleAnalyses();
  const r3 = mkRes();
  await analysisController.reanalyze(analyzeReq(doc), r3);
  assert.equal(r3.statusCode, 200, JSON.stringify(r3.body));
  await settleAnalyses();
  assert.equal(await userArticles(), 1, 'retry and reanalyze never count the article again');
});

test('concurrent analyze on one pending doc counts once', async () => {
  useFreeTier();
  const doc = await pendingDoc();
  const rs = [mkRes(), mkRes(), mkRes()];
  await Promise.all(rs.map((r) => analysisController.triggerAnalysis(analyzeReq(doc), r)));
  await settleAnalyses();
  assert.equal(await userArticles(), 1);
});

test('drafts created under the limit cannot all be started over it (limit re-checked at claim)', async () => {
  useFreeTier();
  await UserUsageTracker.increment(String(USER), 'articlesCreated', 2);
  const a = await pendingDoc();
  const b = await pendingDoc();
  const ra = mkRes();
  await analysisController.triggerAnalysis(analyzeReq(a), ra);
  assert.equal(ra.statusCode, 200);
  const rb = mkRes();
  await analysisController.triggerAnalysis(analyzeReq(b), rb);
  assert.equal(rb.statusCode, 429);
  assert.equal(rb.body.code, 'ARTICLE_LIMIT_REACHED');
  assert.equal((await Content.findById(b._id).lean()).articleQuotaState, 'pending', 'still startable after an upgrade');
  await settleAnalyses();
  assert.equal(await userArticles(), 3);
});

test('PUT startAnalysis over the limit: save stands, analysisBlocked returned, nothing started', async () => {
  useFreeTier();
  await UserUsageTracker.increment(String(USER), 'articlesCreated', 3);
  const doc = await pendingDoc();
  const r = await put(doc.contentNumber, { contentType: 'blog-post', startAnalysis: true, baseRevision: 0 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.analysisBlocked.code, 'ARTICLE_LIMIT_REACHED');
  const stored = await Content.findById(doc._id).lean();
  assert.equal(stored.contentType, 'blog-post');
  assert.equal(stored.analysisStatus, 'idle');
  assert.equal(stored.articleQuotaState, 'pending');
});

test('PUT startAnalysis under the limit counts once; a double-click does not recount or double-start', async () => {
  useFreeTier();
  const doc = await pendingDoc();
  const [a, b] = await Promise.all([
    put(doc.contentNumber, { startAnalysis: true }),
    put(doc.contentNumber, { startAnalysis: true }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  await settleAnalyses();
  assert.equal(await userArticles(), 1);
});

test('POST with keywords over the limit: created, analysisBlocked, not counted', async () => {
  useFreeTier();
  await UserUsageTracker.increment(String(USER), 'articlesCreated', 3);
  stub(Content, 'getNextContentNumber', async () => seq++);
  const res = mkRes();
  await contentController.createContent({
    workspace: { _id: WS, organizationId: ORG }, user: { userId: String(USER) },
    body: { title: 'k', targetKeywords: ['kw'] },
    tierQuota: { orgId: ORG, userId: USER, counterKey: 'articlesCreated', period: 'lifetime', isUserLevel: true },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.analysisBlocked.code, 'ARTICLE_LIMIT_REACHED');
  assert.equal(res.body.content.analysisStatus, 'idle');
  assert.equal(await userArticles(), 3);
});

test('paid monthly tier: counted on the ORG monthly counter, not the user lifetime one', async () => {
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'standard', config: { maxArticlesPerMonth: 20, articleLimitType: 'monthly' } }));
  const doc = await pendingDoc({
    articleQuotaCtx: { orgId: String(ORG), userId: String(USER), isUserLevel: false, orgCounted: true, lifetime: false, quotaSource: null, workspaceId: null },
  });
  const r = await articleQuota.claimArticleSlot(doc);
  assert.equal(r.counted, true);
  assert.equal(await UsageTracker.getCount(String(ORG), 'articlesCreated', tierService.getPeriod('monthly')), 1);
  assert.equal(await userArticles(), 0);
});
