/**
 * Phase 7 RBAC — GET /org/tier-info must NOT leak the org credit balance to
 * viewers/clients. tier-info also serves usage info to those roles, so it does
 * NOT 403 them; instead it redacts the org subscription/general balance while
 * still returning the user's own user_free pool. Editor+ see the real balance.
 * Models + tierService monkey-patched; no DB.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const tierController = require('../src/controllers/tierController');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const Subscription = require('../src/models/Subscription');
const Workspace = require('../src/models/Workspace');
const Avatar = require('../src/models/Avatar');
const BrandVoice = require('../src/models/BrandVoice');
const UsageTracker = require('../src/models/UsageTracker');
const Credit = require('../src/models/Credit');
const UserCredit = require('../src/models/UserCredit');
const UserUsageTracker = require('../src/models/UserUsageTracker');
const tierService = require('../src/services/tierService');
const seatService = require('../src/services/seatService');

const real = {};
for (const [k, o, m] of [
  ['orgFindById', Organization, 'findById'], ['orgFindOne', Organization, 'findOne'],
  ['memberFindOne', OrgMember, 'findOne'], ['memberCount', OrgMember, 'countDocuments'],
  ['subFindOne', Subscription, 'findOne'],
  ['wsFind', Workspace, 'find'], ['wsCount', Workspace, 'countDocuments'],
  ['avCount', Avatar, 'countDocuments'], ['bvCount', BrandVoice, 'countDocuments'],
  ['usage', UsageTracker, 'getUsage'], ['userUsage', UserUsageTracker, 'getUsage'],
  ['creditFindOne', Credit, 'findOne'], ['userCreditFindOne', UserCredit, 'findOne'],
  ['getOrgTierConfig', tierService, 'getOrgTierConfig'], ['getTierConfig', tierService, 'getTierConfig'],
  ['seatUsage', seatService, 'getSeatUsage'],
]) real[k] = [o, m, o[m]];
after(() => { for (const k in real) { const [o, m, fn] = real[k]; o[m] = fn; } });

const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const OWNER = 'owner1';
const CONFIG = { creditsPerMonth: 3000, creditLimitType: 'monthly', maxSeats: 5, maxBrandVoices: 3, maxAvatars: 3, maxWorkspaces: 3 };

let member;
beforeEach(() => {
  member = null;
  Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
  OrgMember.findOne = () => lean(member);
  OrgMember.countDocuments = async () => 1;
  seatService.getSeatUsage = async () => ({ seatsUsed: 1, viewersUsed: 0 });
  Subscription.findOne = () => lean({ purchasedExtraSeats: 0 });
  Workspace.find = () => ({ distinct: async () => [] });
  Workspace.countDocuments = async () => 0;
  Avatar.countDocuments = async () => 0;
  BrandVoice.countDocuments = async () => 0;
  UsageTracker.getUsage = async () => ({});
  UserUsageTracker.getUsage = async () => ({});
  Credit.findOne = () => lean({ subscriptionCredits: 2500, generalCredits: 100, subscriptionCreditsExpireAt: null });
  UserCredit.findOne = () => lean({ freeCredits: 200 });
  tierService.getOrgTierConfig = async () => ({ tier: 'standard', config: CONFIG });
  tierService.getTierConfig = async () => ({ maxArticlesPerMonth: 3, maxKeywordLookupsPerMonth: 50, maxAiTrackerPromptsPerMonth: 5, maxAuditsPerMonth: 5 });
});

const reqFor = (userId) => ({ user: { userId }, query: { orgId: 'org1' } });

describe('getTierInfo — org credit balance redaction', () => {
  it('owner sees the real org balance', async () => {
    const r = res();
    await tierController.getTierInfo(reqFor(OWNER), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.creditBalance.subscription, 2500);
    assert.equal(r.body.creditBalance.general, 100);
    assert.equal(r.body.creditBalance.userFree, 200);
  });

  it('admin sees the real org balance', async () => {
    member = { role: 'admin', status: 'active' };
    const r = res();
    await tierController.getTierInfo(reqFor('adminU'), r);
    assert.equal(r.body.creditBalance.subscription, 2500);
  });

  it('editor sees the real org balance', async () => {
    member = { role: 'editor', status: 'active' };
    const r = res();
    await tierController.getTierInfo(reqFor('editorU'), r);
    assert.equal(r.body.creditBalance.subscription, 2500);
  });

  it('VIEWER: org balance redacted (null), own userFree still shown', async () => {
    member = { role: 'viewer', status: 'active' };
    const r = res();
    await tierController.getTierInfo(reqFor('viewerU'), r);
    assert.equal(r.statusCode, 200, 'not 403 — viewers still get tier/usage');
    assert.equal(r.body.creditBalance.subscription, null, 'org subscription balance hidden');
    assert.equal(r.body.creditBalance.general, null, 'org general balance hidden');
    assert.equal(r.body.creditBalance.userFree, 200, 'own sample pool still visible');
    assert.equal(r.body.creditBalance.total, 200, 'total reflects only own userFree');
  });

  it('CLIENT: org balance redacted (null)', async () => {
    member = { role: 'client', status: 'active' };
    const r = res();
    await tierController.getTierInfo(reqFor('clientU'), r);
    assert.equal(r.body.creditBalance.subscription, null);
    assert.equal(r.body.creditBalance.general, null);
  });

  it('INACTIVE admin (invited/suspended): org balance redacted', async () => {
    member = { role: 'admin', status: 'invited' };
    const r = res();
    await tierController.getTierInfo(reqFor('pendingAdmin'), r);
    assert.equal(r.body.creditBalance.subscription, null, 'non-active member does not see balance');
  });

  it('non-member → 403', async () => {
    member = null;
    const r = res();
    await tierController.getTierInfo(reqFor('strangerU'), r);
    assert.equal(r.statusCode, 403);
  });
});

// ─── Phase 3: the per-image price shape reaches the client ───────
//
// The editor gates /image on creditCostShapes.imageGenerate.worstCase. If the
// field never made it into the response the UI would silently fall back to the
// flat per-image number and start runs the deduction refuses with a 402 — so
// the arithmetic being right elsewhere is not enough; it has to be PUBLISHED.
describe('getTierInfo — credit cost shapes', () => {
  it('publishes the /image run shape alongside the flat cost map', async () => {
    const r = res();
    await tierController.getTierInfo(reqFor(OWNER), r);
    const shape = r.body.creditCostShapes?.imageGenerate;
    assert.ok(shape, 'creditCostShapes.imageGenerate must be published');
    assert.equal(shape.unit, 'image');
    assert.equal(shape.worstCase, shape.base + shape.perUnit * shape.max);
    // The flat map still carries the per-image price for the one-shot endpoint.
    assert.equal(r.body.creditCosts.imageGenerate, shape.perUnit);
  });

  it('publishes no shape for flat-priced actions', async () => {
    const r = res();
    await tierController.getTierInfo(reqFor(OWNER), r);
    for (const flat of ['articleGenerate', 'fullDocPass', 'inlineAction']) {
      assert.equal(r.body.creditCostShapes[flat], undefined,
        `${flat} prices as one number and must not publish a shape`);
    }
  });
});
