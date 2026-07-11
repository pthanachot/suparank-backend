const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Workspace = require('../src/models/Workspace');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const { resolveWorkspaceWithRole, resolveWorkspaceRole } = require('../src/middleware/permissions');

const { ObjectId } = mongoose.Types;

// ─── Model stubs (no DB) ─────────────────────────────────────────

const originals = {
  wsFindOne: Workspace.findOne,
  orgFindById: Organization.findById,
  findMembershipByOrg: OrgMember.findMembershipByOrg,
  findMembership: OrgMember.findMembership,
  wmFindMembership: WorkspaceMember.findMembership,
};

let state;

beforeEach(() => {
  state = {
    workspace: null, // returned by Workspace.findOne
    org: null, // returned by Organization.findById().lean()
    orgMembership: null, // returned by OrgMember.findMembershipByOrg
    ownerMembership: null, // returned by OrgMember.findMembership
    workspaceGrant: null, // returned by WorkspaceMember.findMembership
  };
  Workspace.findOne = async () => state.workspace;
  Organization.findById = () => ({ lean: async () => state.org });
  OrgMember.findMembershipByOrg = async () => state.orgMembership;
  OrgMember.findMembership = async () => state.ownerMembership;
  WorkspaceMember.findMembership = async () => state.workspaceGrant;
});

afterEach(() => {
  Workspace.findOne = originals.wsFindOne;
  Organization.findById = originals.orgFindById;
  OrgMember.findMembershipByOrg = originals.findMembershipByOrg;
  OrgMember.findMembership = originals.findMembership;
  WorkspaceMember.findMembership = originals.wmFindMembership;
});

// ─── req/res helpers ─────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function run(userId, method = 'GET') {
  const req = { params: { workspaceNumber: '123456' }, user: { userId }, method };
  const res = mockRes();
  let nextCalled = false;
  await resolveWorkspaceWithRole(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

// ─── Fixtures ────────────────────────────────────────────────────

const ownerId = new ObjectId();
const memberId = new ObjectId();
const strangerId = new ObjectId();
const orgId = new ObjectId();
const wsId = new ObjectId();

function orgWorkspace(extra = {}) {
  return {
    _id: wsId,
    workspaceNumber: 123456,
    userId: ownerId,
    organizationId: orgId,
    members: [],
    ...extra,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('resolveWorkspaceWithRole — basics', () => {
  it('404s when the workspace does not exist', async () => {
    state.workspace = null;
    const { res, nextCalled } = await run(ownerId);
    assert.equal(res.statusCode, 404);
    assert.equal(nextCalled, false);
  });

  it('org owner resolves as owner', async () => {
    state.workspace = orgWorkspace();
    state.org = { _id: orgId, ownerId };
    const { req, nextCalled } = await run(ownerId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'owner');
  });

  it('personal workspace creator resolves as owner', async () => {
    state.workspace = orgWorkspace({ organizationId: null, userId: memberId });
    const { req, nextCalled } = await run(memberId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'owner');
  });

  it('non-member gets 403', async () => {
    state.workspace = orgWorkspace();
    state.org = { _id: orgId, ownerId };
    const { res, nextCalled } = await run(strangerId);
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });
});

// B4: a downgrade-locked workspace is inaccessible until upgrade. The gate lives
// in rwr AFTER role resolution (so non-members still get generic "no access"),
// and exempts DELETE (mirroring lockGuard — a member can still erase/clean up a
// locked workspace to free a slot).
describe('resolveWorkspaceWithRole — workspace.locked (B4)', () => {
  it('403s a member on a locked workspace with the locked contract', async () => {
    state.workspace = orgWorkspace({ locked: true });
    state.org = { _id: orgId, ownerId };
    const { res, nextCalled } = await run(ownerId); // owner, but workspace locked
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.locked, true);
    assert.equal(res.body.code, 'WORKSPACE_LOCKED');
    assert.equal(nextCalled, false);
  });

  it('DELETE is exempt — a locked workspace still resolves for a member', async () => {
    state.workspace = orgWorkspace({ locked: true });
    state.org = { _id: orgId, ownerId };
    const { req, res, nextCalled } = await run(ownerId, 'DELETE');
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'owner');
    assert.equal(res.statusCode, 200);
  });

  it('a stranger on a locked workspace gets generic "no access", never learns it is locked', async () => {
    state.workspace = orgWorkspace({ locked: true });
    state.org = { _id: orgId, ownerId };
    const { res, nextCalled } = await run(strangerId);
    assert.equal(res.statusCode, 403);
    assert.notEqual(res.body.code, 'WORKSPACE_LOCKED'); // role check fires first
    assert.notEqual(res.body.locked, true);
    assert.equal(nextCalled, false);
  });

  it('an unlocked workspace passes through unchanged', async () => {
    state.workspace = orgWorkspace({ locked: false });
    state.org = { _id: orgId, ownerId };
    const { req, nextCalled } = await run(ownerId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'owner');
  });

  it('403s a member on a clientLocked workspace with a distinct billing code', async () => {
    state.workspace = orgWorkspace({ clientLocked: true });
    state.org = { _id: orgId, ownerId };
    const { res, nextCalled } = await run(ownerId);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.locked, true);
    assert.equal(res.body.code, 'WORKSPACE_CLIENT_LOCKED');
    assert.equal(nextCalled, false);
  });

  it('DELETE is exempt for a clientLocked workspace too', async () => {
    state.workspace = orgWorkspace({ clientLocked: true });
    state.org = { _id: orgId, ownerId };
    const { req, nextCalled } = await run(ownerId, 'DELETE');
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'owner');
  });

  it('downgrade lock takes precedence when BOTH flags are set', async () => {
    state.workspace = orgWorkspace({ locked: true, clientLocked: true });
    state.org = { _id: orgId, ownerId };
    const { res } = await run(ownerId);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'WORKSPACE_LOCKED'); // locked checked first
  });
});

describe("resolveWorkspaceWithRole — accessScope 'all' (org-wide, legacy behavior)", () => {
  it('resolves the org-wide role', async () => {
    state.workspace = orgWorkspace();
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'editor', accessScope: 'all' };
    const { req, nextCalled } = await run(memberId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'editor');
  });

  it('treats a missing accessScope as org-wide (pre-migration rows)', async () => {
    state.workspace = orgWorkspace();
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'viewer' }; // no accessScope field
    const { req, nextCalled } = await run(memberId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'viewer');
  });
});

describe("resolveWorkspaceWithRole — accessScope 'assigned'", () => {
  it('resolves the per-workspace grant role, not the org role', async () => {
    state.workspace = orgWorkspace();
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'viewer', accessScope: 'assigned' };
    state.workspaceGrant = { workspaceId: wsId, userId: memberId, role: 'client' };
    const { req, nextCalled } = await run(memberId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'client');
  });

  it('403s on a workspace with no grant', async () => {
    state.workspace = orgWorkspace();
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'viewer', accessScope: 'assigned' };
    state.workspaceGrant = null;
    const { res, nextCalled } = await run(memberId);
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('does NOT fall through to legacy members[] when the grant is missing', async () => {
    // The assigned member also appears in the legacy members[] array —
    // must still be denied: scoped access is exactly the grants.
    state.workspace = orgWorkspace({
      members: [{ userId: memberId, email: 'x@y.z' }],
    });
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'viewer', accessScope: 'assigned' };
    state.workspaceGrant = null;
    const { res, nextCalled } = await run(memberId);
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });
});

describe('resolveWorkspaceWithRole — legacy fallbacks', () => {
  it('legacy members[] array grants editor (non-members of the org)', async () => {
    state.workspace = orgWorkspace({
      members: [{ userId: strangerId, email: 'x@y.z' }],
    });
    state.org = { _id: orgId, ownerId };
    const { req, nextCalled } = await run(strangerId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'editor');
  });

  it('owner-based membership resolves for non-org workspaces', async () => {
    state.workspace = orgWorkspace({ organizationId: null });
    state.ownerMembership = { userId: memberId, role: 'editor' };
    const { req, nextCalled } = await run(memberId);
    assert.equal(nextCalled, true);
    assert.equal(req.workspaceRole, 'editor');
  });
});

// F1/B1: the extracted helper is what non-workspaceNumber routes (getMembers,
// keyed by _id) now share. Pin its contract directly — especially the fix:
// an OrgMember with an EMPTY members[] array must still resolve (the legacy
// `members[] OR userId` re-query returned nothing for these org teammates).
describe('resolveWorkspaceRole — extracted helper (F1/B1 fix)', () => {
  it('org member absent from members[] STILL resolves (the lockout fix)', async () => {
    // members[] is empty — the legacy $or would have found nothing here.
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'editor' }; // accessScope 'all' (default)
    const role = await resolveWorkspaceRole(orgWorkspace({ members: [] }), memberId);
    assert.equal(role, 'editor');
  });

  it('org owner resolves as owner', async () => {
    state.org = { _id: orgId, ownerId };
    const role = await resolveWorkspaceRole(orgWorkspace(), ownerId);
    assert.equal(role, 'owner');
  });

  it('assigned-scope member with a per-workspace grant resolves to the grant role', async () => {
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'admin', accessScope: 'assigned' };
    state.workspaceGrant = { userId: memberId, role: 'viewer' };
    const role = await resolveWorkspaceRole(orgWorkspace(), memberId);
    assert.equal(role, 'viewer');
  });

  it('assigned-scope member with NO grant returns null (no legacy widening)', async () => {
    // Even with a legacy members[] entry, an assigned member with no grant
    // must be denied — the security property the middleware guarantees.
    state.org = { _id: orgId, ownerId };
    state.orgMembership = { userId: memberId, role: 'admin', accessScope: 'assigned' };
    state.workspaceGrant = null;
    const role = await resolveWorkspaceRole(
      orgWorkspace({ members: [{ userId: memberId, email: 'x@y.z' }] }),
      memberId,
    );
    assert.equal(role, null);
  });

  it('a true stranger returns null (deny)', async () => {
    state.org = { _id: orgId, ownerId };
    const role = await resolveWorkspaceRole(orgWorkspace({ members: [] }), strangerId);
    assert.equal(role, null);
  });

  it('personal-workspace creator resolves as owner', async () => {
    const role = await resolveWorkspaceRole(
      orgWorkspace({ organizationId: null, userId: memberId }),
      memberId,
    );
    assert.equal(role, 'owner');
  });
});
