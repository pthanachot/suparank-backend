const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Workspace = require('../src/models/Workspace');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const { resolveWorkspaceWithRole } = require('../src/middleware/permissions');

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

async function run(userId) {
  const req = { params: { workspaceNumber: '123456' }, user: { userId } };
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
