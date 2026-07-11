/**
 * Phase 10 — RBAC enforcement build + audit ledger.
 *
 *  A. REAL-ROUTE-SCAN CI GUARD (the Phase-2 guard only tested synthetic
 *     fixtures). Scans the actual src/routes/*.js source and fails if:
 *       A1. any credit-spending route (carries `rc('...')`) is not also gated
 *           by the granular `requirePermission('...')`;
 *       A2. any LIVE credit POLICY action lacks a requirePermission gate on
 *           some route;
 *       A3. a LIVE cash action's controller mutations aren't owner-gated +
 *           audited (org-scoped billing has no req.workspaceRole, so the gate
 *           is validateOrgOwner in the controller, not requirePermission).
 *  B. RBAC BEHAVIOR — "Admin grants ≤ Editor" and the assigned-admin
 *     org-isolation guard, driven through the real controllers.
 *  C. AUDIT — a gated role action writes an append-only AuditLog row.
 *
 * No DB/network: source is read from disk (A) and models/services are
 * monkey-patched (B/C), restored in after().
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { POLICY } = require('../src/middleware/permissions.policy');

const ROUTES_DIR = path.join(__dirname, '../src/routes');
const routeFiles = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
const routeSources = routeFiles.map((f) => ({ f, src: fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8') }));
const allRouteSource = routeSources.map((r) => r.src).join('\n');

// Split a route file into per-route chunks so a gate on one route can't be
// mistaken for a gate on a neighbour. Each chunk = one `router.<verb>(...)`
// definition (args may span multiple lines), comment lines stripped.
function routeChunks(src) {
  const active = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const parts = active.split(/router\.(?:get|post|put|patch|delete|all|use)\(/);
  return parts.slice(1); // drop the pre-first-route preamble
}

// ═══════════════════════════════════════════════════════════════════════
// A. Real-route-scan CI guard
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 10 route-gate guard', () => {
  it('A1: every credit-spending route (rc) is also policy-gated (requirePermission)', () => {
    const offenders = [];
    for (const { f, src } of routeSources) {
      for (const chunk of routeChunks(src)) {
        // Match ANY rc(...) form (quoted or a constant arg) so a non-literal
        // credit gate can't slip through un-gated.
        if (/\brc\(/.test(chunk) && !/requirePermission\(/.test(chunk)) {
          const firstLine = chunk.split('\n')[0].trim().slice(0, 80);
          offenders.push(`${f}: router...(${firstLine}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `credit routes missing requirePermission:\n${offenders.join('\n')}`);
  });

  it('A2: every LIVE credit action is gated on some route', () => {
    const liveCredit = Object.entries(POLICY)
      .filter(([, e]) => e.credit && !e.roadmap)
      .map(([a]) => a);
    // Sanity: the known live spenders are all present.
    for (const a of ['ai.generate', 'ai.audit', 'keywords.search', 'brandVoice.manage', 'tracker.refreshOne', 'tracker.refreshAll']) {
      assert.ok(liveCredit.includes(a), `${a} should be a live credit action`);
    }
    const ungated = liveCredit.filter((a) => {
      const re = new RegExp(`requirePermission\\(\\s*['"\`]${a.replace(/\./g, '\\.')}['"\`]`);
      return !re.test(allRouteSource);
    });
    assert.deepEqual(ungated, [], `LIVE credit actions with no requirePermission route gate: ${ungated.join(', ')}`);
  });

  it('A3: LIVE cash mutations are owner-gated AND audited in billingController', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/controllers/billingController.js'), 'utf8');
    // Slice each `const <name> = async (req, res) => { ... }` handler body,
    // stopping at the NEXT top-level declaration — const/function/async function
    // — so a following helper (e.g. notifyOwner) can't be folded into a handler's
    // body and mask a missing audit call.
    const bodyOf = (name) => {
      const decl = `const ${name} = async`;
      const start = src.indexOf(decl);
      if (start === -1) return null;
      const after = start + decl.length;
      const rel = src.slice(after).search(/\n(?:const \w+ =|async function |function )/);
      return rel === -1 ? src.slice(start) : src.slice(start, after + rel);
    };
    // The state-mutating cash handlers (billing.manage + members.addPaidSeat).
    const cashHandlers = [
      'createCheckoutSession',
      'createCustomerPortal',
      'cancelSubscription',
      'reactivateSubscription',
      'revokeScheduledChange',
      'updateExtraSeats',
      'createCreditPackCheckout',
    ];
    for (const name of cashHandlers) {
      const body = bodyOf(name);
      assert.ok(body, `handler ${name} not found`);
      assert.match(body, /validateOrgOwner\(/, `${name}: cash mutation must be owner-gated`);
      assert.match(body, /auditBilling\(|auditService/, `${name}: cash mutation must write an audit row`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B/C. RBAC behavior + audit — driven through the real controllers
// ═══════════════════════════════════════════════════════════════════════

const orgMemberController = require('../src/controllers/orgMemberController');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const seatService = require('../src/services/seatService');
const tierService = require('../src/services/tierService');
const Subscription = require('../src/models/Subscription');
const auditService = require('../src/services/auditService');

const OWNER = 'owner1';
const ADMIN = 'admin1';
const lean = (v) => ({ lean: async () => v });
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const real = {
  orgFindById: Organization.findById,
  findMembership: OrgMember.findMembershipByOrg,
  findOne: OrgMember.findOne,
  getCfg: tierService.getOrgTierConfig,
  seatUsage: seatService.getSeatUsage,
  subFindOne: Subscription.findOne,
  auditRecord: auditService.record,
};
after(() => {
  Organization.findById = real.orgFindById;
  OrgMember.findMembershipByOrg = real.findMembership;
  OrgMember.findOne = real.findOne;
  tierService.getOrgTierConfig = real.getCfg;
  seatService.getSeatUsage = real.seatUsage;
  Subscription.findOne = real.subFindOne;
  auditService.record = real.auditRecord;
});

// Caller identity is set per-test via `callerRole`/`callerScope`.
function mockOrgAccess(callerRole, callerScope = 'all') {
  Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
  OrgMember.findMembershipByOrg = async () => (callerRole === 'owner'
    ? { role: 'owner', accessScope: 'all' } // unused (owner short-circuits) but harmless
    : { role: callerRole, accessScope: callerScope });
}
const reqAs = (userId, body) => ({ params: { orgId: 'org1', memberId: 'm1' }, user: { userId, email: `${userId}@x.com` }, ip: '1', body });

describe('changeRole — Admin grants ≤ Editor (Owner-only admin management)', () => {
  let member, saved, audited;
  beforeEach(() => {
    saved = false; audited = null;
    member = { _id: 'm1', userId: 'u1', role: 'editor', locked: false, email: 'u1@x.com', save: async () => { saved = true; } };
    OrgMember.findOne = () => member;
    // Seat check should be a no-op for these role changes; provide safe stubs.
    tierService.getOrgTierConfig = async () => ({ config: { maxSeats: 5, displayName: 'Pro' }, tier: 'pro' });
    Subscription.findOne = () => lean({ purchasedExtraSeats: 0 });
    seatService.getSeatUsage = async () => ({ seatsUsed: 1, viewersUsed: 0 });
    auditService.record = (row) => { audited = row; };
  });

  it('ADMIN caller granting admin → 403 OWNER_ONLY (no escalation)', async () => {
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.changeRole(reqAs(ADMIN, { role: 'admin' }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(saved, false);
  });

  it('ADMIN caller modifying an EXISTING admin → 403 (admins are Owner-managed)', async () => {
    member.role = 'admin';
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.changeRole(reqAs(ADMIN, { role: 'viewer' }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(saved, false);
  });

  it('ADMIN caller granting editor → allowed', async () => {
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.changeRole(reqAs(ADMIN, { role: 'editor' }), r);
    assert.equal(saved, true);
    assert.equal(r.body.member.role, 'editor');
  });

  it('OWNER caller granting admin → allowed (owner administers admins)', async () => {
    mockOrgAccess('owner');
    const r = res();
    await orgMemberController.changeRole(reqAs(OWNER, { role: 'admin' }), r);
    assert.equal(saved, true);
    assert.equal(r.body.member.role, 'admin');
  });

  it('C: an allowed role change writes an append-only member.change_role audit row', async () => {
    mockOrgAccess('owner');
    const r = res();
    await orgMemberController.changeRole(reqAs(OWNER, { role: 'viewer' }), r);
    assert.ok(audited, 'auditService.record was called');
    assert.equal(audited.action, 'member.change_role');
    assert.equal(audited.organizationId, 'org1');
  });
});

const WorkspaceMember = require('../src/models/WorkspaceMember');

describe('only the Owner administers admins (removeMember / updateMemberScope / setMemberWorkspaces)', () => {
  const realWsDel = WorkspaceMember.deleteMany;
  after(() => { WorkspaceMember.deleteMany = realWsDel; });

  let member, deleted, saved;
  beforeEach(() => {
    deleted = false; saved = false;
    member = { _id: 'm1', userId: 'u1', role: 'admin', accessScope: 'all', email: 'a@x.com',
      deleteOne: async () => { deleted = true; }, save: async () => { saved = true; } };
    OrgMember.findOne = () => member;
    WorkspaceMember.deleteMany = async () => ({});
    auditService.record = () => {};
  });

  // M1 — removeMember
  it('ADMIN removing an ADMIN peer → 403 OWNER_ONLY (not deleted)', async () => {
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.removeMember(reqAs(ADMIN, {}), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(deleted, false);
  });
  it('ADMIN removing a non-admin → allowed', async () => {
    member.role = 'editor';
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.removeMember(reqAs(ADMIN, {}), r);
    assert.equal(deleted, true);
  });
  it('OWNER removing an ADMIN → allowed', async () => {
    mockOrgAccess('owner');
    const r = res();
    await orgMemberController.removeMember(reqAs(OWNER, {}), r);
    assert.equal(deleted, true);
  });

  // M2 — updateMemberScope (the escalation that would undo assigned-admin isolation)
  it('ADMIN re-scoping an ADMIN (assigned→all escalation) → 403 OWNER_ONLY', async () => {
    member.accessScope = 'assigned';
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.updateMemberScope(reqAs(ADMIN, { accessScope: 'all' }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(saved, false);
  });
  it('ADMIN re-scoping a non-admin → allowed', async () => {
    member.role = 'editor';
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.updateMemberScope(reqAs(ADMIN, { accessScope: 'assigned' }), r);
    assert.equal(saved, true);
  });

  // M3 — setMemberWorkspaces granting a per-workspace admin role
  it('ADMIN granting a workspace-ADMIN assignment → 403 OWNER_ONLY', async () => {
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.setMemberWorkspaces(reqAs(ADMIN, { assignments: [{ workspaceId: 'ws1', role: 'admin' }] }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
  });

  // M4 — Phase-14 review: setMemberWorkspaces must ALSO block when the TARGET is
  // an admin, even if the assignments carry no admin role. Otherwise a non-owner
  // admin passes an empty/viewer-only list for an assigned-scope admin, the seat
  // sync demotes OrgMember.role admin→viewer, and deleteMany strips every grant —
  // locking the admin peer out. (The M3 guard only inspects the assignments.)
  it('ADMIN setting an assigned-ADMIN peer\'s workspaces (empty list) → 403 OWNER_ONLY (no demotion/lockout)', async () => {
    member.accessScope = 'assigned'; // the state where the seat sync would demote admin→viewer
    let wsWiped = false;
    WorkspaceMember.deleteMany = async () => { wsWiped = true; return {}; };
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.setMemberWorkspaces(reqAs(ADMIN, { assignments: [] }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(saved, false);   // OrgMember.role not rewritten (not demoted)
    assert.equal(wsWiped, false); // workspace grants not stripped
  });
  it('OWNER setting an ADMIN peer\'s workspaces → allowed (past the owner guard)', async () => {
    mockOrgAccess('owner');
    const r = res();
    await orgMemberController.setMemberWorkspaces(reqAs(OWNER, { assignments: [] }), r);
    assert.notEqual(r.statusCode, 403);
  });
});

describe('inviteMember — admin-grant + assigned-admin isolation', () => {
  beforeEach(() => {
    tierService.getOrgTierConfig = async () => ({ config: { maxSeats: 5, clientViewers: 10, displayName: 'Pro' }, tier: 'pro' });
    seatService.getSeatUsage = async () => ({ seatsUsed: 1, viewersUsed: 0 });
    Subscription.findOne = () => lean({ purchasedExtraSeats: 0 });
    auditService.record = () => {};
  });

  it('ADMIN caller inviting an admin → 403 OWNER_ONLY', async () => {
    mockOrgAccess('admin');
    const r = res();
    await orgMemberController.inviteMember(reqAs(ADMIN, { email: 'x@x.com', role: 'admin', accessScope: 'all' }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
  });

  it('ASSIGNED-scope admin → 403 on org-wide invite (isolation guard)', async () => {
    mockOrgAccess('admin', 'assigned');
    const r = res();
    await orgMemberController.inviteMember(reqAs(ADMIN, { email: 'x@x.com', role: 'editor', accessScope: 'all' }), r);
    assert.equal(r.statusCode, 403);
    assert.match(r.body.error, /full-access admins/);
  });
});
