/**
 * B1 — route-level access gate for GET /workspaces/:workspaceId/members.
 *
 * The helper (resolveWorkspaceRole) is unit-tested in
 * resolveWorkspaceWithRole.test.js; this pins the getMembers WIRING: that the
 * route now admits org-scoped teammates (the F1 fix), denies strangers with
 * 404, and short-circuits a missing workspace before touching the helper.
 *
 * Model-stubbed (no DB), mirroring resolveWorkspaceWithRole.test.js.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Workspace = require('../src/models/Workspace');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const User = require('../src/models/User');
const workspaceController = require('../src/controllers/workspaceController');

const { ObjectId } = mongoose.Types;

// Organization.findById is called with BOTH .lean() (in the helper) and
// .select('ownerId').lean() (in getMembers' owner-resolution); User.findById
// with .select().lean(). One chainable stub covers all shapes.
const chainLean = (val) => ({ lean: async () => val, select: () => ({ lean: async () => val }) });

const originals = {};
beforeEach(() => {
  originals.wsFindById = Workspace.findById;
  originals.orgFindById = Organization.findById;
  originals.omByOrg = OrgMember.findMembershipByOrg;
  originals.omFind = OrgMember.findMembership;
  originals.wmFind = WorkspaceMember.findMembership;
  originals.userFindById = User.findById;
});
afterEach(() => {
  Workspace.findById = originals.wsFindById;
  Organization.findById = originals.orgFindById;
  OrgMember.findMembershipByOrg = originals.omByOrg;
  OrgMember.findMembership = originals.omFind;
  WorkspaceMember.findMembership = originals.wmFind;
  User.findById = originals.userFindById;
});

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const ownerId = new ObjectId();
const memberId = new ObjectId();
const strangerId = new ObjectId();
const orgId = new ObjectId();
const wsId = new ObjectId();

async function call(userId) {
  const req = { params: { workspaceId: String(wsId) }, user: { userId } };
  const res = mockRes();
  await workspaceController.getMembers(req, res);
  return res;
}

describe('getMembers — access gate (F1/B1)', () => {
  it('org member ABSENT from members[] can now read the member list (the fix)', async () => {
    // Empty members[] — the old `members[] OR userId` re-query returned nothing.
    Workspace.findById = async () => ({ _id: wsId, organizationId: orgId, userId: ownerId, members: [] });
    Organization.findById = () => chainLean({ _id: orgId, ownerId });
    OrgMember.findMembershipByOrg = async () => ({ userId: memberId, role: 'editor' }); // accessScope 'all'
    User.findById = () => chainLean({ email: 'owner@x.z', profile: { name: 'Owner' } });

    const res = await call(memberId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.owner.email, 'owner@x.z');
    assert.equal(res.body.isOwner, false);
    assert.deepEqual(res.body.members, []);
  });

  it('a true stranger gets 404 (deny)', async () => {
    Workspace.findById = async () => ({ _id: wsId, organizationId: orgId, userId: ownerId, members: [] });
    Organization.findById = () => chainLean({ _id: orgId, ownerId });
    OrgMember.findMembershipByOrg = async () => null;

    const res = await call(strangerId);
    assert.equal(res.statusCode, 404);
  });

  it('a missing workspace 404s WITHOUT invoking the helper', async () => {
    Workspace.findById = async () => null;
    // If the helper were reached it would throw on a null workspace — proving
    // the `!workspace ||` short-circuit, this must still cleanly 404.
    Organization.findById = () => { throw new Error('helper must not run on a null workspace'); };

    const res = await call(memberId);
    assert.equal(res.statusCode, 404);
  });

  it('an assigned-scope member WITHOUT a grant for this workspace is denied (404)', async () => {
    Workspace.findById = async () => ({ _id: wsId, organizationId: orgId, userId: ownerId, members: [] });
    Organization.findById = () => chainLean({ _id: orgId, ownerId });
    OrgMember.findMembershipByOrg = async () => ({ userId: memberId, role: 'admin', accessScope: 'assigned' });
    WorkspaceMember.findMembership = async () => null; // no grant for THIS workspace

    const res = await call(memberId);
    assert.equal(res.statusCode, 404);
  });
});
