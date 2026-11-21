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

// ── QA B42 follow-up (Nov 21): the chat price the editor shows ──
const { resolveCredits } = require('../src/config/creditRules');
const { CHAT_RESERVE_TOKENS } = require('../src/config/creditCosts');
const { computeSettlement } = require('../src/services/billing/computeSettlement');

test('tier-info quotes chat at its reservation (2), not its floor (1)', async () => {
  for (const tier of ['free', 'standard']) {
    const res = await tierInfo({ tier, creditsPerMonth: 3000, creditLimitType: 'monthly' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const reserve = resolveCredits('aiChatMessage', { tier, tokens: CHAT_RESERVE_TOKENS });
    assert.equal(reserve, 2, 'the route reserves the >8K tier');
    assert.equal(res.body.creditCosts.aiChatMessage, reserve, `${tier}: menu price must equal what the route holds`);
  }
});

test('the chat route pre-flight uses the same shared reservation', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/workspaceRoutes.js'), 'utf8');
  assert.match(src, /const estChat = [^\n]*tokens: CHAT_RESERVE_TOKENS/);
  assert.doesNotMatch(src, /tokens: 8001/, 'no second copy of the reserve size');
});

test('"~2" is honest: every chat settles at or below the quoted price', () => {
  const quoted = resolveCredits('aiChatMessage', { tier: 'standard', tokens: CHAT_RESERVE_TOKENS });
  const runs = [
    { wrote: false, tokens: 30000 }, // answer only, e.g. /meta-description
    { wrote: true, tokens: 4000 },
    { wrote: true, tokens: 30000 },
    { wrote: true, tokens: 1e9 },
  ];
  for (const r of runs) {
    const { credits } = computeSettlement({ kind: 'chat', billingClass: 'aiChatMessage', reserved: quoted, tier: 'standard', ...r });
    assert.ok(credits <= quoted, `${JSON.stringify(r)} settled ${credits} > ${quoted}`);
  }
  assert.equal(computeSettlement({ kind: 'chat', billingClass: 'aiChatMessage', reserved: quoted, tier: 'standard', wrote: false, tokens: 30000 }).credits, 0);
});
