/**
 * Phase 17 Part A — per-workspace quota ceilings (ships DARK behind saasMode).
 *
 * The load-bearing guarantee: with saasMode dark, requireQuota + incrementQuota
 * behave EXACTLY as pre-P17 (no workspace ceiling, no second counter). With the
 * flag live AND the workspace client-billed, a SECOND ceiling from the client's
 * AgencyPlan.limits applies on top of the org's wholesale tier.
 *
 * Models/services monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const flagService = require('../src/services/flagService');
const ClientSubscription = require('../src/models/ClientSubscription');
const AgencyPlan = require('../src/models/AgencyPlan');
const UsageTracker = require('../src/models/UsageTracker');
const UserUsageTracker = require('../src/models/UserUsageTracker');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');
const tierService = require('../src/services/tierService');
const { requireQuota } = require('../src/middleware/tierEnforcement');
const { resolveWorkspacePlanLimits } = require('../src/services/workspaceQuotaService');

const real = {
  isFlagLive: flagService.isFlagLive,
  csFindOne: ClientSubscription.findOne,
  planFBI: AgencyPlan.findById,
  utGet: UsageTracker.getCount,
  utInc: UsageTracker.increment,
  uutGet: UserUsageTracker.getCount,
  wutGet: WorkspaceUsageTracker.getCount,
  wutInc: WorkspaceUsageTracker.increment,
  getCfg: tierService.getOrgTierConfig,
};
after(() => {
  flagService.isFlagLive = real.isFlagLive;
  ClientSubscription.findOne = real.csFindOne;
  AgencyPlan.findById = real.planFBI;
  UsageTracker.getCount = real.utGet;
  UsageTracker.increment = real.utInc;
  UserUsageTracker.getCount = real.uutGet;
  WorkspaceUsageTracker.getCount = real.wutGet;
  WorkspaceUsageTracker.increment = real.wutInc;
  tierService.getOrgTierConfig = real.getCfg;
});

// ── shared harness ──
let flagLive, clientSub, agencyPlan, orgUsed, wsUsed, orgCfg, orgIncs, wsIncs;

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqFor = () => ({ workspace: { _id: 'ws1', organizationId: 'org1' }, user: { userId: 'u1' }, body: {} });

beforeEach(() => {
  flagLive = false;
  clientSub = { agencyPlanId: 'plan1' };
  agencyPlan = { limits: { maxArticlesPerMonth: 5 } };
  orgUsed = 0;
  wsUsed = 0;
  orgCfg = { tier: 'agency', config: { maxArticlesPerMonth: 100, displayName: 'Agency' } };
  orgIncs = [];
  wsIncs = [];

  flagService.isFlagLive = async () => flagLive;
  ClientSubscription.findOne = () => ({ sort: () => ({ select: () => ({ lean: async () => clientSub }) }) });
  AgencyPlan.findById = () => ({ select: () => ({ lean: async () => agencyPlan }) });
  UsageTracker.getCount = async () => orgUsed;
  UsageTracker.increment = async (o, k, p) => { orgIncs.push({ o, k, p }); };
  WorkspaceUsageTracker.getCount = async () => wsUsed;
  WorkspaceUsageTracker.increment = async (w, k, p) => { wsIncs.push({ w, k, p }); };
  tierService.getOrgTierConfig = async () => orgCfg;
});

// ── resolveWorkspacePlanLimits ──
describe('resolveWorkspacePlanLimits', () => {
  it('returns null when saasMode is dark (never queries)', async () => {
    flagLive = false;
    let queried = false;
    ClientSubscription.findOne = () => { queried = true; return { sort: () => ({ select: () => ({ lean: async () => clientSub }) }) }; };
    assert.equal(await resolveWorkspacePlanLimits('ws1'), null);
    assert.equal(queried, false, 'short-circuits before touching the DB');
  });

  it('returns null when the workspace has no active client subscription', async () => {
    flagLive = true; clientSub = null;
    assert.equal(await resolveWorkspacePlanLimits('ws1'), null);
  });

  it('returns the AgencyPlan limits for a client-billed workspace', async () => {
    flagLive = true;
    const limits = await resolveWorkspacePlanLimits('ws1');
    assert.deepEqual(limits, { maxArticlesPerMonth: 5 });
  });

  it('FAIL-SAFE: sub exists but agencyPlanId is missing → {} (billed, no caps), not null', async () => {
    flagLive = true;
    clientSub = { agencyPlanId: null }; // billed, but plan reference lost
    const limits = await resolveWorkspacePlanLimits('ws1');
    // Non-null → consumers still treat as client-billed (excludes user_free,
    // tracks the counter) rather than reverting to normal billing.
    assert.deepEqual(limits, {});
  });

  it('FAIL-SAFE: sub exists but the AgencyPlan doc is gone → {} (billed, no caps)', async () => {
    flagLive = true;
    agencyPlan = null; // AgencyPlan.findById(...).lean() → null
    const limits = await resolveWorkspacePlanLimits('ws1');
    assert.deepEqual(limits, {});
  });
});

// ── requireQuota: flag DARK = unchanged ──
describe('requireQuota — saasMode dark (byte-identical to pre-P17)', () => {
  const mw = requireQuota('articlesCreated', 'maxArticlesPerMonth', 'articleLimitType');

  it('passes with NO workspace context in req.tierQuota', async () => {
    flagLive = false; orgUsed = 3;
    const req = reqFor(); const r = res(); let nexted = false;
    await mw(req, r, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.tierQuota.workspaceId, undefined, 'no workspace ceiling attached');
    assert.equal(req.tierQuota.workspacePeriod, undefined);
    assert.equal(req.tierQuota.orgId, 'org1');
  });

  it('still 429s on the ORG ceiling exactly as before', async () => {
    flagLive = false; orgCfg = { tier: 'standard', config: { maxArticlesPerMonth: 3 } }; orgUsed = 3;
    const req = reqFor(); const r = res();
    await mw(req, r, () => {});
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.code, 'QUOTA_EXCEEDED');
    assert.equal(r.body.quota.scope, undefined, 'org-scope 429 has no workspace scope tag');
  });
});

// ── requireQuota: flag LIVE = second ceiling ──
describe('requireQuota — saasMode live (two ceilings)', () => {
  const mw = requireQuota('articlesCreated', 'maxArticlesPerMonth', 'articleLimitType');

  it('attaches workspace context and passes when both ceilings have room', async () => {
    flagLive = true; wsUsed = 2; orgUsed = 10;
    const req = reqFor(); const r = res(); let nexted = false;
    await mw(req, r, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.tierQuota.workspaceId, 'ws1');
    assert.ok(/^\d{4}-\d{2}$/.test(req.tierQuota.workspacePeriod), 'monthly period');
  });

  it('429s on the WORKSPACE ceiling with scope:workspace', async () => {
    flagLive = true; wsUsed = 5; orgUsed = 0; // ws at its plan limit of 5, org fine
    const req = reqFor(); const r = res();
    await mw(req, r, () => {});
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.scope, 'workspace');
    assert.equal(r.body.quota.limit, 5);
  });

  it('enforces the workspace ceiling EVEN WHEN the org limit is unlimited', async () => {
    flagLive = true; orgCfg = { tier: 'agency', config: { maxArticlesPerMonth: null } }; wsUsed = 5;
    const req = reqFor(); const r = res();
    await mw(req, r, () => {});
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.scope, 'workspace');
  });

  it('still 429s on the ORG ceiling when the org is the binding limit', async () => {
    flagLive = true; orgCfg = { tier: 'standard', config: { maxArticlesPerMonth: 3 } }; orgUsed = 3; wsUsed = 0;
    const req = reqFor(); const r = res();
    await mw(req, r, () => {});
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.scope, undefined, 'org ceiling, not workspace');
  });
});

// ── incrementQuota dual-bump ──
describe('incrementQuota — dual counter bump', () => {
  it('bumps ONLY the org counter when no workspace context', async () => {
    await tierService.incrementQuota({ orgId: 'org1', counterKey: 'articlesCreated', period: '2026-07' });
    assert.equal(orgIncs.length, 1);
    assert.equal(wsIncs.length, 0);
  });

  it('bumps BOTH counters for a client-billed workspace', async () => {
    await tierService.incrementQuota({
      orgId: 'org1', counterKey: 'articlesCreated', period: '2026-07',
      workspaceId: 'ws1', workspacePeriod: '2026-07',
    });
    assert.equal(orgIncs.length, 1);
    assert.equal(wsIncs.length, 1);
    assert.equal(wsIncs[0].w, 'ws1');
    assert.equal(wsIncs[0].k, 'articlesCreated');
  });
});
