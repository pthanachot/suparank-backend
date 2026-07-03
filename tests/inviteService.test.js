const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Invite = require('../src/models/Invite');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const Workspace = require('../src/models/Workspace');
const User = require('../src/models/User');
const inviteService = require('../src/services/inviteService');

const { ObjectId } = mongoose.Types;

// ─── Token hashing ───────────────────────────────────────────────

describe('Invite.hashToken', () => {
  it('is deterministic and does not store the raw token', () => {
    const raw = 'a'.repeat(64);
    const h1 = Invite.hashToken(raw);
    const h2 = Invite.hashToken(raw);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // sha256 hex
    assert.notEqual(h1, raw);
  });

  it('different tokens hash differently', () => {
    assert.notEqual(Invite.hashToken('token-a'), Invite.hashToken('token-b'));
  });
});

// ─── acceptInvite (stubbed models, no DB) ────────────────────────

const originals = {
  orgFindById: Organization.findById,
  orgMemberCreate: OrgMember.create,
  wmInsertMany: WorkspaceMember.insertMany,
  wsFind: Workspace.find,
  wsFindOne: Workspace.findOne,
  userUpdateOne: User.updateOne,
  inviteDeleteOne: Invite.deleteOne,
};

let state;

beforeEach(() => {
  state = {
    org: null,
    orgWorkspaces: [], // returned by Workspace.find (assigned validation)
    defaultWorkspace: null, // returned by Workspace.findOne
    createdOrgMembers: [],
    createdGrants: [],
    userUpdates: [],
    deletedInvites: [],
    orgMemberCreateError: null,
  };
  Organization.findById = () => ({ lean: async () => state.org });
  OrgMember.create = async (doc) => {
    if (state.orgMemberCreateError) throw state.orgMemberCreateError;
    state.createdOrgMembers.push(doc);
    return doc;
  };
  WorkspaceMember.insertMany = async (docs) => {
    state.createdGrants.push(...docs);
    return docs;
  };
  Workspace.find = () => ({
    select: () => ({ lean: async () => state.orgWorkspaces }),
  });
  Workspace.findOne = () => ({
    select: () => ({ lean: async () => state.defaultWorkspace }),
  });
  User.updateOne = async (filter, update) => {
    state.userUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  };
  Invite.deleteOne = async (filter) => {
    state.deletedInvites.push(filter);
    return { deletedCount: 1 };
  };
});

afterEach(() => {
  Organization.findById = originals.orgFindById;
  OrgMember.create = originals.orgMemberCreate;
  WorkspaceMember.insertMany = originals.wmInsertMany;
  Workspace.find = originals.wsFind;
  Workspace.findOne = originals.wsFindOne;
  User.updateOne = originals.userUpdateOne;
  Invite.deleteOne = originals.inviteDeleteOne;
});

const orgId = new ObjectId();
const ownerId = new ObjectId();
const userId = new ObjectId();
const wsA = new ObjectId();
const wsB = new ObjectId();

function makeInvite(extra = {}) {
  return {
    _id: new ObjectId(),
    email: 'client@acme.com',
    organizationId: orgId,
    role: 'client',
    accessScope: 'assigned',
    workspaceIds: [wsA, wsB],
    invitedBy: ownerId,
    createdAt: new Date(),
    ...extra,
  };
}

const user = { _id: userId, email: 'client@acme.com', activeWorkspaceId: null };

describe('inviteService.acceptInvite', () => {
  it("assigned-scope client invite → viewer OrgMember + client grants + active workspace", async () => {
    state.org = { _id: orgId, ownerId };
    state.orgWorkspaces = [{ _id: wsA }, { _id: wsB }];

    const result = await inviteService.acceptInvite(makeInvite(), user);

    assert.equal(result.alreadyMember, false);
    assert.equal(state.createdOrgMembers.length, 1);
    // 'client' is workspace-level only; org row floors to viewer + assigned
    assert.equal(state.createdOrgMembers[0].role, 'viewer');
    assert.equal(state.createdOrgMembers[0].accessScope, 'assigned');
    assert.equal(state.createdGrants.length, 2);
    assert.equal(state.createdGrants[0].role, 'client');
    // Active workspace points at the first granted workspace
    assert.equal(result.workspace._id.toString(), wsA.toString());
    assert.equal(state.userUpdates.length, 1);
    // Invite consumed
    assert.equal(state.deletedInvites.length, 1);
  });

  it("all-scope invite keeps the invited role and sets the org's default workspace", async () => {
    state.org = { _id: orgId, ownerId };
    state.defaultWorkspace = { _id: wsA };

    const invite = makeInvite({ role: 'editor', accessScope: 'all', workspaceIds: [] });
    const result = await inviteService.acceptInvite(invite, user);

    assert.equal(state.createdOrgMembers[0].role, 'editor');
    assert.equal(state.createdOrgMembers[0].accessScope, 'all');
    assert.equal(state.createdGrants.length, 0);
    assert.equal(result.workspace._id.toString(), wsA.toString());
  });

  it('duplicate membership (11000) → alreadyMember, no grants created', async () => {
    state.org = { _id: orgId, ownerId };
    const dup = new Error('duplicate');
    dup.code = 11000;
    state.orgMemberCreateError = dup;

    const result = await inviteService.acceptInvite(makeInvite(), user);

    assert.equal(result.alreadyMember, true);
    assert.equal(state.createdGrants.length, 0);
    assert.equal(state.deletedInvites.length, 1); // still consumed
  });

  it('org owner accepting their own invite is a no-op (invite consumed)', async () => {
    state.org = { _id: orgId, ownerId: userId }; // user IS the owner

    const result = await inviteService.acceptInvite(makeInvite(), user);

    assert.equal(result.alreadyMember, true);
    assert.equal(state.createdOrgMembers.length, 0);
    assert.equal(state.deletedInvites.length, 1);
  });

  it('deleted org → INVITE_ORG_GONE and the invite is cleaned up', async () => {
    state.org = null;

    await assert.rejects(
      () => inviteService.acceptInvite(makeInvite(), user),
      (err) => err.code === 'INVITE_ORG_GONE'
    );
    assert.equal(state.deletedInvites.length, 1);
  });

  it('grants are limited to workspaces still in the org', async () => {
    state.org = { _id: orgId, ownerId };
    state.orgWorkspaces = [{ _id: wsA }]; // wsB was deleted/moved

    const result = await inviteService.acceptInvite(makeInvite(), user);

    assert.equal(state.createdGrants.length, 1);
    assert.equal(state.createdGrants[0].workspaceId.toString(), wsA.toString());
    assert.equal(result.workspace._id.toString(), wsA.toString());
  });
});
