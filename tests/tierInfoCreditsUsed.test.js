/**
 * QA Nov 2026 (B42) — tier-info reports real credit usage for a LIFETIME
 * credit limit (Free). Deductions land on the org UsageTracker row for
 * getPeriod('lifetime'); tier-info used to read the per-user tracker and so
 * always reported 0. Models monkey-patched; no DB.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tierController = require('../src/controllers/tierController');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const Subscription = require('../src/models/Subscription');
const Workspace = require('../src/models/Workspace');
const Avatar = require('../src/models/Avatar');
const BrandVoice = require('../src/models/BrandVoice');
const Site = require('../src/models/Site');
const Sitemap = require('../src/models/Sitemap');
const UsageTracker = require('../src/models/UsageTracker');
const Credit = require('../src/models/Credit');
const UserCredit = require('../src/models/UserCredit');
const UserUsageTracker = require('../src/models/UserUsageTracker');
const tierService = require('../src/services/tierService');
const seatService = require('../src/services/seatService');

const saved = [];
const stub = (o, k, fn) => { saved.push([o, k, o[k]]); o[k] = fn; };
after(() => { for (let i = saved.length - 1; i >= 0; i--) { const [o, k, v] = saved[i]; o[k] = v; } });

const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
const OWNER = 'owner1';

async function tierInfo(config) {
  stub(Organization, 'findById', () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } }));
  stub(OrgMember, 'findOne', () => lean(null));
  stub(OrgMember, 'countDocuments', async () => 1);
  stub(seatService, 'getSeatUsage', async () => ({ seatsUsed: 1, viewersUsed: 0 }));
  stub(Subscription, 'findOne', () => lean(null));
  stub(Workspace, 'find', () => ({ distinct: async () => [] }));
  stub(Workspace, 'countDocuments', async () => 0);
  stub(Avatar, 'countDocuments', async () => 0);
  stub(BrandVoice, 'countDocuments', async () => 0);
  stub(Site, 'countDocuments', async () => 0);
  stub(Sitemap, 'countDocuments', async () => 0);
  // The org's lifetime row carries the credits; the monthly row and the user
  // tracker deliberately carry different numbers so a wrong read is visible.
  stub(UsageTracker, 'getUsage', async (_org, period) => (period === 'lifetime'
    ? { creditsUsed: 37 } : { creditsUsed: 5, articlesCreated: 1 }));
  stub(UserUsageTracker, 'getUsage', async () => ({ creditsUsed: 0, articlesCreated: 2 }));
  stub(Credit, 'findOne', () => lean(null));
  stub(UserCredit, 'findOne', () => lean({ freeCredits: 163 }));
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: config.tier, config }));
  stub(tierService, 'getTierConfig', async () => ({}));
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await tierController.getTierInfo({ user: { userId: OWNER }, query: { orgId: 'org1' } }, res);
  return res;
}

test('Free (lifetime credit limit): creditsUsed comes from the org lifetime row', async () => {
  const res = await tierInfo({
    tier: 'free', creditsPerMonth: 200, creditLimitType: 'lifetime',
    maxArticlesPerMonth: 3, articleLimitType: 'lifetime',
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.usage.creditsUsed.used, 37);
  assert.equal(res.body.usage.creditsUsed.period, 'lifetime');
  // Other lifetime counters are still user-level.
  assert.equal(res.body.usage.articlesCreated.used, 2);
});

test('monthly credit limit still reads the month row', async () => {
  const res = await tierInfo({ tier: 'standard', creditsPerMonth: 3000, creditLimitType: 'monthly' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.usage.creditsUsed.used, 5);
});
