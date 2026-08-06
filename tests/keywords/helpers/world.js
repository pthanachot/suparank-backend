/**
 * Phase B — keyword test world: seeds a tenant and builds REQUESTS THAT MATCH
 * WHAT THE MIDDLEWARE ACTUALLY ATTACHES.
 *
 * The controller's billing/quota behaviour is driven entirely by
 * `req.creditContext` (creditGate.js:122-131) and `req.tierQuota`
 * (tierEnforcement.js:142). Hand-rolling those shapes wrongly would make
 * every money assertion meaningless, so they are constructed here once,
 * field-for-field, and derived from the REAL tier config.
 */

const mongoose = require('mongoose');

const Workspace = require('../../../src/models/Workspace');
const Subscription = require('../../../src/models/Subscription');
const TierConfig = require('../../../src/models/TierConfig');
const creditService = require('../../../src/services/creditService');
const tierService = require('../../../src/services/tierService');

let wsCounter = 981000;

/** Seed the tier rows the keyword paths read (free = 0-credit bundle). */
async function seedTierConfigs() {
  await TierConfig.deleteMany({});
  await TierConfig.create([
    {
      tier: 'free', displayName: 'Free',
      maxKeywordLookupsPerMonth: 50, keywordLimitType: 'lifetime',
      creditsPerMonth: 0, creditLimitType: 'lifetime',
    },
    {
      tier: 'standard', displayName: 'Standard',
      maxKeywordLookupsPerMonth: 1000, keywordLimitType: 'monthly',
      creditsPerMonth: 2000, creditLimitType: 'monthly',
    },
  ]);
  tierService.clearTierCache(); // 5-min TTL would otherwise hide these
}

/**
 * @param {'free'|'standard'} tier
 * @param {number} credits  general credits to grant the org
 */
async function seedWorld({ tier = 'standard', credits = 500, orgless = false } = {}) {
  const orgId = orgless ? null : new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  if (orgId && tier !== 'free') {
    // stripeSubscriptionId carries a UNIQUE index — a second `null` collides
    // (E11000), so every seeded subscription needs a distinct value.
    await Subscription.create({
      organizationId: orgId,
      planId: 'standard-monthly',
      status: 'active',
      stripeSubscriptionId: `sub_test_${orgId}`,
    });
  }
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId,
    organizationId: orgId,
    name: `Keyword WS ${wsCounter}`,
  });
  if (orgId && credits > 0) {
    await creditService.grantGeneralCredits(orgId.toString(), credits, 'phase B seed');
  }
  return { orgId: orgId ? orgId.toString() : null, orgObjectId: orgId, userId, ws, tier };
}

/**
 * Build a request exactly as the middleware chain would leave it.
 * `deductionEnabled:false` reproduces the documented fail-open path.
 */
async function buildReq(world, { body = {}, query = {}, params = {}, deductionEnabled = true, quotaSource } = {}) {
  const req = {
    workspace: world.ws,
    user: { userId: world.userId },
    body: { ...body, ...(quotaSource ? { quotaSource } : {}) },
    query,
    params: { workspaceNumber: String(world.ws.workspaceNumber), ...params },
  };

  if (!world.orgId || !deductionEnabled) {
    req.creditContext = { deductionEnabled: false };
  } else {
    const { tier, config } = await tierService.getOrgTierConfig(world.orgId);
    req.creditContext = {
      orgId: world.orgId,
      userId: world.userId,
      workspaceId: world.ws._id,
      estimatedCredits: 50, // the route's conservative pre-flight estimate
      featureKey: 'keywordLookup',
      deductionEnabled: true,
      config,
      tier,
    };
    const limitType = config?.keywordLimitType || 'monthly';
    const isUserLevel = limitType === 'lifetime';
    req.tierQuota = {
      orgId: world.orgId,
      userId: world.userId,
      counterKey: 'keywordSearches',
      period: tierService.getPeriod(limitType),
      limit: config?.maxKeywordLookupsPerMonth ?? null,
      used: 0,
      isUserLevel,
    };
  }
  return req;
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

module.exports = { seedWorld, seedTierConfigs, buildReq, makeRes };
