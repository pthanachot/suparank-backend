/**
 * Phase B review addition — two things the original suite left open.
 *
 * 1. HARNESS FIDELITY. Every money assertion in this tier runs against a
 *    request built by `helpers/world.js#buildReq`. If the real middleware
 *    ever attaches a different shape, that helper would keep lying and the
 *    whole tier would prove nothing about production. So: run the REAL
 *    `requireQuota` / `requireCredits` middleware and assert the helper's
 *    output matches field-for-field.
 *
 * 2. quotaSource:'free' — a PAID user spending their free lifetime slot.
 *    It is in the B3 scenario list and in buildReq's signature, but was
 *    never exercised; it is also the one path where quota and credits are
 *    resolved from DIFFERENT tiers.
 *
 * Run: node --test tests/keywords/harness-fidelity.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';
process.env.SERPER_API_KEY = 'test-serper-key';

const db = require('../aiTracker/helpers/db');
const vendorMock = require('../aiTracker/helpers/vendorMock');
const ledger = require('../aiTracker/helpers/ledger');
const fx = require('./helpers/fixtures');
const { seedWorld, seedTierConfigs, buildReq, makeRes } = require('./helpers/world');

const { requireQuota } = require('../../src/middleware/tierEnforcement');
const { requireCredits } = require('../../src/middleware/creditGate');
const { resolveCredits } = require('../../src/config/creditRules');
const KeywordSearch = require('../../src/models/KeywordSearch');
const KeywordResearchHistory = require('../../src/models/KeywordResearchHistory');
const UsageTracker = require('../../src/models/UsageTracker');
const UserUsageTracker = require('../../src/models/UserUsageTracker');
const keywordController = require('../../src/controllers/keywordController');

/** Drive the real middleware chain the keyword search route declares. */
async function runRealMiddleware(world, { body = {} } = {}) {
  const req = {
    workspace: world.ws,
    user: { userId: world.userId },
    body,
    query: {},
    params: { workspaceNumber: String(world.ws.workspaceNumber) },
  };
  const res = makeRes();
  const quota = requireQuota('keywordSearches', 'maxKeywordLookupsPerMonth', 'keywordLimitType');
  const credits = requireCredits('keywordLookup', (_req, { tier }) => resolveCredits('keywordLookup', { tier, rows: 50 }));
  await new Promise((resolve) => quota(req, res, resolve));
  await new Promise((resolve) => credits(req, res, resolve));
  return req;
}

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

describe('harness fidelity — buildReq matches the REAL middleware', () => {
  it('creditContext: same fields, same values (paid org)', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    const real = await runRealMiddleware(world, { body: { keyword: 'shape check' } });
    const fake = await buildReq(world, { body: { keyword: 'shape check' } });

    assert.deepEqual(
      Object.keys(real.creditContext).sort(),
      Object.keys(fake.creditContext).sort(),
      'creditContext field set drifted — update helpers/world.js#buildReq',
    );
    for (const k of ['orgId', 'featureKey', 'deductionEnabled', 'tier', 'estimatedCredits']) {
      assert.deepEqual(String(real.creditContext[k]), String(fake.creditContext[k]), `creditContext.${k}`);
    }
    assert.equal(real.creditContext.deductionEnabled, true);
  });

  it('tierQuota: same fields, same values (paid org → monthly period)', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    const real = await runRealMiddleware(world, { body: { keyword: 'shape check 2' } });
    const fake = await buildReq(world, { body: { keyword: 'shape check 2' } });

    assert.deepEqual(
      Object.keys(real.tierQuota).sort(),
      Object.keys(fake.tierQuota).sort(),
      'tierQuota field set drifted — update helpers/world.js#buildReq',
    );
    for (const k of ['counterKey', 'period', 'limit', 'isUserLevel']) {
      assert.deepEqual(real.tierQuota[k], fake.tierQuota[k], `tierQuota.${k}`);
    }
    assert.equal(real.tierQuota.counterKey, 'keywordSearches');
  });

  it('free tier resolves to a LIFETIME, user-level quota in both', { timeout: 60_000 }, async () => {
    const world = await seedWorld({ tier: 'free' });
    const real = await runRealMiddleware(world, { body: { keyword: 'free shape' } });
    const fake = await buildReq(world, { body: { keyword: 'free shape' } });

    assert.equal(real.tierQuota.period, 'lifetime');
    assert.equal(real.tierQuota.isUserLevel, true);
    assert.equal(fake.tierQuota.period, real.tierQuota.period);
    assert.equal(fake.tierQuota.isUserLevel, real.tierQuota.isUserLevel);
    assert.equal(real.creditContext.tier, 'free');
    assert.equal(real.creditContext.estimatedCredits, 0, 'free bundle pre-flight estimate is 0');
  });

  it('an org-less workspace disables deduction in both', { timeout: 60_000 }, async () => {
    const world = await seedWorld({ orgless: true, credits: 0 });
    const real = await runRealMiddleware(world, { body: { keyword: 'orgless shape' } });
    const fake = await buildReq(world, { body: { keyword: 'orgless shape' } });
    assert.equal(real.creditContext.deductionEnabled, false);
    assert.equal(fake.creditContext.deductionEnabled, false);
  });
});

describe("quotaSource:'free' — a paid user spending their free lifetime slot", () => {
  it('quota is drawn from the FREE lifetime bundle (user-level), not the org month', { timeout: 60_000 }, async () => {
    const world = await seedWorld(); // paid org
    const real = await runRealMiddleware(world, { body: { keyword: 'opt in', quotaSource: 'free' } });

    assert.equal(real.tierQuota.period, 'lifetime', 'opting in switches the quota to the free bundle');
    assert.equal(real.tierQuota.isUserLevel, true, 'and it is counted against the USER, not the org');
    assert.equal(real.tierQuota.limit, 50, 'the free tier lifetime cap');
  });

  it('end-to-end: the lookup consumes the user lifetime slot and stamps history createdOnPlan=free', { timeout: 60_000 }, async () => {
    const world = await seedWorld();
    vendorMock.script({ dataforseo: [vendorMock.jsonReply(fx.dfsOk(4))] });
    const before = await ledger.snapshot(world.orgId);

    const req = await buildReq(world, { body: { keyword: 'free slot keyword' }, quotaSource: 'free' });
    // Mirror what requireQuota does for an opted-in request.
    req.tierQuota = { ...req.tierQuota, period: 'lifetime', isUserLevel: true, limit: 50 };
    const res = makeRes();
    await keywordController.searchKeywords(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 4);

    const userUsage = await UserUsageTracker.findOne({ userId: world.userId }).lean();
    assert.equal(userUsage?.keywordSearches, 1, 'the free lifetime slot was spent');
    // The org tracker doc still appears — credits are always org-scoped — but the
    // QUOTA counter must stay at zero, otherwise opting in would be billed twice
    // against the month AND the lifetime slot.
    const orgUsage = await UsageTracker.findOne({ organizationId: world.orgId }).lean();
    assert.equal(orgUsage.keywordSearches, 0, 'the org monthly quota counter was NOT consumed');
    assert.equal(orgUsage.creditsUsed, 4, 'credits are still tracked org-side');

    const hist = await KeywordResearchHistory.findOne({}).lean();
    assert.equal(hist.createdOnPlan, 'free', 'history records which pool paid — drives downgrade locking');

    // PINNED BEHAVIOUR: the CREDIT gate still resolves the ORG's real tier, so
    // an opted-in paid user is charged credits AND spends a free slot. The
    // quota switch is not mirrored on the credit side. Documented here rather
    // than assumed — if the product decides opting in should also be
    // credit-free, this assertion is the one to change.
    const charged = before.total - (await ledger.snapshot(world.orgId)).total;
    assert.equal(charged, 4, 'credits are still charged at the org tier (see comment)');
  });
});
