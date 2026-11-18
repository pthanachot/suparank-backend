/**
 * QA Nov 2026 (B24) — the article allowance is CHECKED at create and COUNTED
 * once, when the article is first put to work. Models stubbed; no DB.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const articleQuota = require('../src/services/articleQuotaService');
const contentController = require('../src/controllers/contentController');
const analysisController = require('../src/controllers/analysisController');
const tierService = require('../src/services/tierService');
const Content = require('../src/models/Content');
const UsageTracker = require('../src/models/UsageTracker');
const UserUsageTracker = require('../src/models/UserUsageTracker');

function withStubs(fn) {
  const saved = [];
  const stub = (o, k, v) => { saved.push([o, k, o[k]]); o[k] = v; };
  return Promise.resolve(fn(stub)).finally(() => {
    for (let i = saved.length - 1; i >= 0; i--) { const [o, k, v] = saved[i]; o[k] = v; }
  });
}

const FREE_CTX = { orgId: 'org1', userId: 'u1', isUserLevel: true, orgCounted: true, lifetime: true, quotaSource: null, workspaceId: null };

test('quotaCtxFromReq keeps what the count needs, drops periods', () => {
  const ctx = articleQuota.quotaCtxFromReq(
    { orgId: 'o', userId: 'u', counterKey: 'articlesCreated', period: '2026-11', isUserLevel: false, workspaceId: 'w', workspacePeriod: '2026-11' },
    'free',
  );
  assert.deepEqual(ctx, { orgId: 'o', userId: 'u', isUserLevel: false, orgCounted: true, lifetime: false, quotaSource: 'free', workspaceId: 'w' });
  assert.equal(articleQuota.quotaCtxFromReq(null), null);
  assert.equal(articleQuota.quotaCtxFromReq({ counterKey: 'auditsRun' }), null, 'only the article counter');
});

test('tierQuotaFromCtx recomputes the CURRENT period', () => {
  const q = articleQuota.tierQuotaFromCtx({ ...FREE_CTX, lifetime: false, isUserLevel: false, workspaceId: 'w' });
  assert.equal(q.period, tierService.getPeriod('monthly'));
  assert.equal(q.workspacePeriod, tierService.getPeriod('monthly'));
  assert.equal(articleQuota.tierQuotaFromCtx({ ...FREE_CTX, orgCounted: false }).period, null, 'unlimited org: nothing org-level to count');
});

test('claimArticleSlot: legacy (no state), counted and exempt docs are never counted', () => withStubs(async (stub) => {
  let writes = 0;
  stub(Content, 'findOneAndUpdate', async () => { writes++; return {}; });
  stub(tierService, 'incrementQuota', async () => { throw new Error('must not count'); });
  for (const state of [undefined, 'counted', 'exempt']) {
    const r = await articleQuota.claimArticleSlot({ _id: 'c', articleQuotaState: state });
    assert.deepEqual(r, { ok: true, counted: false }, String(state));
  }
  assert.equal(writes, 0, 'no claim attempted for docs counted before this change');
}));

test('claimArticleSlot: a pending doc is counted once; a lost race counts nothing', () => withStubs(async (stub) => {
  let state = 'pending';
  const increments = [];
  stub(Content, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.articleQuotaState, 'pending');
    if (state !== 'pending') return null;
    state = update.$set.articleQuotaState;
    return { _id: 'c' };
  });
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'free', config: { maxArticlesPerMonth: 3, articleLimitType: 'lifetime' } }));
  stub(UserUsageTracker, 'getCount', async () => 1);
  stub(tierService, 'incrementQuota', async (q) => { increments.push(q); });
  const doc = { _id: 'c', articleQuotaState: 'pending', articleQuotaCtx: FREE_CTX };
  assert.deepEqual(await articleQuota.claimArticleSlot(doc), { ok: true, counted: true });
  assert.deepEqual(await articleQuota.claimArticleSlot(doc), { ok: true, counted: false }, 'second caller loses the atomic claim');
  assert.equal(increments.length, 1);
  assert.equal(increments[0].isUserLevel, true);
  assert.equal(increments[0].counterKey, 'articlesCreated');
}));

test('claimArticleSlot re-checks the limit (drafts created under it, started over it)', () => withStubs(async (stub) => {
  let claimed = false;
  stub(Content, 'findOneAndUpdate', async () => { claimed = true; return {}; });
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'free', config: { maxArticlesPerMonth: 3, articleLimitType: 'lifetime' } }));
  stub(UserUsageTracker, 'getCount', async () => 3);
  const r = await articleQuota.claimArticleSlot({ _id: 'c', articleQuotaState: 'pending', articleQuotaCtx: FREE_CTX });
  assert.equal(r.ok, false);
  assert.equal(r.payload.code, 'ARTICLE_LIMIT_REACHED');
  assert.doesNotMatch(r.payload.error, /—/);
  assert.equal(claimed, false, 'refused before the claim: the doc stays pending');
  // enforce:false (the post-run commit) skips the re-check
  const r2 = await articleQuota.claimArticleSlot({ _id: 'c', articleQuotaState: 'pending', articleQuotaCtx: FREE_CTX }, { enforce: false });
  assert.equal(r2.ok, true);
}));

test('claimArticleSlot with quotaSource free checks the FREE tier limit', () => withStubs(async (stub) => {
  stub(Content, 'findOneAndUpdate', async () => ({}));
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'standard', config: { maxArticlesPerMonth: 20, articleLimitType: 'monthly' } }));
  stub(tierService, 'getTierConfig', async () => ({ maxArticlesPerMonth: 3, articleLimitType: 'lifetime' }));
  stub(UserUsageTracker, 'getCount', async () => 3);
  stub(UsageTracker, 'getCount', async () => 0);
  stub(tierService, 'incrementQuota', async () => {});
  const r = await articleQuota.claimArticleSlot({ _id: 'c', articleQuotaState: 'pending', articleQuotaCtx: { ...FREE_CTX, quotaSource: 'free' } });
  assert.equal(r.ok, false);
}));

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('createContent with deferred analysis: limit checked, NOT counted, doc marked pending', () => withStubs(async (stub) => {
  let created;
  stub(Content, 'getNextContentNumber', async () => 77);
  stub(Content, 'create', async (doc) => { created = doc; return { ...doc, _id: 'c77', toObject() { return { ...doc, _id: 'c77' }; } }; });
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'free', config: {} }));
  stub(tierService, 'incrementQuota', async () => { throw new Error('createContent must not count the article any more'); });
  const req = {
    workspace: { _id: 'w1', organizationId: 'org1' },
    user: { userId: 'u1' },
    body: { title: 'Draft', targetKeywords: ['k'], deferAnalysis: true },
    tierQuota: { orgId: 'org1', userId: 'u1', counterKey: 'articlesCreated', period: 'lifetime', isUserLevel: true },
  };
  const res = mkRes();
  await contentController.createContent(req, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(created.articleQuotaState, 'pending');
  assert.equal(created.articleQuotaCtx.userId, 'u1');
  assert.equal(res.body.content.articleQuotaCtx, undefined, 'internal bookkeeping never leaves the API');
}));

test('createContent without a quota context marks the doc exempt', () => withStubs(async (stub) => {
  let created;
  stub(Content, 'getNextContentNumber', async () => 78);
  stub(Content, 'create', async (doc) => { created = doc; return { ...doc, _id: 'c78' }; });
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'free', config: {} }));
  const res = mkRes();
  await contentController.createContent({ workspace: { _id: 'w1', organizationId: 'org1' }, user: { userId: 'u1' }, body: { title: 'x' } }, res);
  assert.equal(created.articleQuotaState, 'exempt');
}));

test('POST /analyze on a pending doc over the limit → 429, analysis not started', () => withStubs(async (stub) => {
  const updates = [];
  stub(Content, 'findByNumber', async () => ({
    _id: 'c1', contentNumber: 5, locked: false, analysisStatus: 'idle', targetKeywords: ['k'],
    articleQuotaState: 'pending', articleQuotaCtx: FREE_CTX,
  }));
  stub(Content, 'findByIdAndUpdate', async (_id, u) => { updates.push(u); return {}; });
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'free', config: { maxArticlesPerMonth: 3, articleLimitType: 'lifetime' } }));
  stub(UserUsageTracker, 'getCount', async () => 3);
  const res = mkRes();
  await analysisController.triggerAnalysis({ params: { contentNumber: 5 }, workspace: { _id: 'w1' }, user: { userId: 'u1' } }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'ARTICLE_LIMIT_REACHED');
  assert.equal(updates.length, 0, 'status untouched');
}));
