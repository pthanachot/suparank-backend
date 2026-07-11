/**
 * Phase 9 — seats vs free client viewers.
 *  - seatService.getSeatUsage: org-wide members (accessScope 'all') = editor
 *    seats (+owner, +pending seat invites); assigned members = free client
 *    viewers (+pending viewer invites).
 *  - inviteMember: an org-wide invite is capped by maxSeats (+extra); an assigned
 *    invite is capped by clientViewers and does NOT consume an editor seat.
 *  - downgradeService.lockMembers: locks excess per class independently.
 * Models/services monkey-patched; no DB.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const seatService = require('../src/services/seatService');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const Invite = require('../src/models/Invite');

// ─── seatService.getSeatUsage ───────────────────────────────────────────────
describe('seatService.getSeatUsage', () => {
  const realFind = OrgMember.find;
  const realWs = WorkspaceMember.find;
  const realInv = Invite.countDocuments;
  after(() => { OrgMember.find = realFind; WorkspaceMember.find = realWs; Invite.countDocuments = realInv; });

  const mock = (members, wsEditorIds, seatInvites, viewerInvites) => {
    OrgMember.find = () => ({ select: () => ({ lean: async () => members }) });
    WorkspaceMember.find = () => ({ distinct: async () => wsEditorIds });
    Invite.countDocuments = async (q) => (q.role && q.role.$nin ? viewerInvites : seatInvites);
  };

  it('counts edit-capable members as seats and view-only as viewers (+owner, +pending)', async () => {
    mock(
      [{ userId: 'u1', role: 'editor' }, { userId: 'u2', role: 'admin' }, { userId: 'u3', role: 'viewer' }, { userId: 'u4', role: 'viewer' }],
      [], // no workspace-editor grants
      1, 1,
    );
    const { seatsUsed, viewersUsed } = await seatService.getSeatUsage('org1');
    assert.equal(seatsUsed, 2 + 1 + 1, 'editor+admin members + pending seat invite + owner');
    assert.equal(viewersUsed, 2 + 1, '2 viewer members + pending viewer invite');
  });

  it('a viewer OrgMember with a workspace-EDITOR grant counts as a SEAT (bypass closed)', async () => {
    mock(
      [{ userId: 'u1', role: 'editor' }, { userId: 'u3', role: 'viewer' }],
      ['u3'], // u3 is org-viewer but has a WorkspaceMember editor grant → edit-capable
      0, 0,
    );
    const { seatsUsed, viewersUsed } = await seatService.getSeatUsage('org1');
    assert.equal(seatsUsed, 2 + 1, 'u1 (editor) + u3 (ws-editor) + owner');
    assert.equal(viewersUsed, 0, 'u3 is NOT a free viewer — they can edit');
  });

  it('owner alone = 1 seat, 0 viewers', async () => {
    mock([], [], 0, 0);
    const u = await seatService.getSeatUsage('org1');
    assert.equal(u.seatsUsed, 1);
    assert.equal(u.viewersUsed, 0);
  });
});

// ─── inviteMember enforcement ───────────────────────────────────────────────
const orgMemberController = require('../src/controllers/orgMemberController');
const Organization = require('../src/models/Organization');
const Subscription = require('../src/models/Subscription');
const Workspace = require('../src/models/Workspace');
const User = require('../src/models/User');
const tierService = require('../src/services/tierService');
const inviteService = require('../src/services/inviteService');
const auditService = require('../src/services/auditService');

const real = {
  orgFindById: Organization.findById,
  subFindOne: Subscription.findOne,
  wsFind: Workspace.find,
  userFindOne: User.findOne,
  userFindById: User.findById,
  getCfg: tierService.getOrgTierConfig,
  seatUsage: seatService.getSeatUsage,
  createInvite: inviteService.createInvite,
  auditRecord: auditService.record,
};
after(() => {
  Organization.findById = real.orgFindById;
  Subscription.findOne = real.subFindOne;
  Workspace.find = real.wsFind;
  User.findOne = real.userFindOne;
  User.findById = real.userFindById;
  tierService.getOrgTierConfig = real.getCfg;
  seatService.getSeatUsage = real.seatUsage;
  inviteService.createInvite = real.createInvite;
  auditService.record = real.auditRecord;
});

const OWNER = 'owner1';
const lean = (v) => ({ lean: async () => v });
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const reqFor = (body) => ({ params: { orgId: 'org1' }, user: { userId: OWNER, email: 'o@x.com' }, ip: '127.0.0.1', body });

let usage, config;

describe('inviteMember — seat vs viewer caps', () => {
  beforeEach(() => {
    usage = { seatsUsed: 1, viewersUsed: 0 };
    config = { displayName: 'Standard', maxSeats: 2, clientViewers: 3 };
    Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
    Subscription.findOne = () => lean({ purchasedExtraSeats: 0 });
    Workspace.find = () => ({ select: () => ({ lean: async () => [{ _id: 'ws1' }] }) });
    tierService.getOrgTierConfig = async () => ({ config, tier: 'standard' });
    seatService.getSeatUsage = async () => usage;
    User.findOne = async () => null; // no existing account → invite path
    User.findById = () => ({ select: () => ({ lean: async () => ({ profile: { name: 'Owner' }, email: 'o@x.com' }) }) });
    inviteService.createInvite = async ({ email, role, accessScope }) => ({ _id: 'inv1', email, role, accessScope, workspaceIds: [], expiresAt: new Date() });
    auditService.record = () => {};
  });

  it('org-wide editor invite past maxSeats → 429 maxSeats', async () => {
    usage = { seatsUsed: 2, viewersUsed: 0 }; // == maxSeats (owner + 1)
    const r = res();
    await orgMemberController.inviteMember(reqFor({ email: 'e@x.com', role: 'editor', accessScope: 'all' }), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.limitKey, 'maxSeats');
  });

  it('org-wide editor invite adds extra seats to the cap', async () => {
    usage = { seatsUsed: 2, viewersUsed: 0 };
    Subscription.findOne = () => lean({ purchasedExtraSeats: 1 }); // effective cap 3 → 2 < 3 ok
    const r = res();
    await orgMemberController.inviteMember(reqFor({ email: 'e@x.com', role: 'editor', accessScope: 'all' }), r);
    assert.equal(r.statusCode, 201, 'within base+extra seats → invite created, not 429');
  });

  it('client-viewer invite past clientViewers → 429 clientViewers', async () => {
    usage = { seatsUsed: 1, viewersUsed: 3 }; // == clientViewers
    const r = res();
    await orgMemberController.inviteMember(reqFor({ email: 'c@x.com', role: 'client', accessScope: 'assigned', workspaceIds: ['ws1'] }), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.limitKey, 'clientViewers');
  });

  it('client viewer does NOT consume an editor seat (seats full, viewer still invitable)', async () => {
    usage = { seatsUsed: 2, viewersUsed: 0 }; // editor seats FULL (maxSeats 2)
    const r = res();
    await orgMemberController.inviteMember(reqFor({ email: 'c@x.com', role: 'client', accessScope: 'assigned', workspaceIds: ['ws1'] }), r);
    assert.equal(r.statusCode, 201, 'viewer checked against clientViewers, not the full seat cap');
  });

  it('an ASSIGNED editor DOES consume a seat (no free-editor bypass)', async () => {
    // role editor + accessScope assigned: can edit → must be a SEAT, not a free
    // viewer. Seats full (2/2) → 429 maxSeats even though viewers have room.
    usage = { seatsUsed: 2, viewersUsed: 0 };
    const r = res();
    await orgMemberController.inviteMember(reqFor({ email: 'ae@x.com', role: 'editor', accessScope: 'assigned', workspaceIds: ['ws1'] }), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.limitKey, 'maxSeats');
  });

  it('unlimited client viewers (Agency, clientViewers null) → always invitable', async () => {
    config = { displayName: 'Agency', maxSeats: 15, clientViewers: null };
    usage = { seatsUsed: 5, viewersUsed: 999 };
    const r = res();
    await orgMemberController.inviteMember(reqFor({ email: 'c@x.com', role: 'client', accessScope: 'assigned', workspaceIds: ['ws1'] }), r);
    assert.equal(r.statusCode, 201);
  });
});

// ─── changeRole — promotion must not bypass the seat cap ────────────────────
describe('changeRole — viewer→editor consumes a seat', () => {
  const realFindOne = OrgMember.findOne;
  after(() => { OrgMember.findOne = realFindOne; });

  let member, saved;
  beforeEach(() => {
    saved = false;
    member = { _id: 'm1', role: 'viewer', locked: false, save: async () => { saved = true; } };
    Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
    OrgMember.findOne = () => member; // changeRole loads a live doc (no .lean)
    tierService.getOrgTierConfig = async () => ({ config: { displayName: 'Standard', maxSeats: 2 }, tier: 'standard' });
    Subscription.findOne = () => lean({ purchasedExtraSeats: 0 });
    seatService.getSeatUsage = async () => ({ seatsUsed: 2, viewersUsed: 1 }); // seats FULL
    auditService.record = () => {};
  });
  const changeReq = (role) => ({ params: { orgId: 'org1', memberId: 'm1' }, user: { userId: OWNER, email: 'o@x.com' }, ip: '1', body: { role } });

  it('promote viewer→editor when seats FULL → 429 (no free-seat bypass)', async () => {
    const r = res();
    await orgMemberController.changeRole(changeReq('editor'), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.limitKey, 'maxSeats');
    assert.equal(saved, false, 'role not saved when over cap');
  });

  it('promote viewer→editor when a seat is free → saved', async () => {
    seatService.getSeatUsage = async () => ({ seatsUsed: 1, viewersUsed: 1 }); // room for 1 more
    const r = res();
    await orgMemberController.changeRole(changeReq('editor'), r);
    assert.equal(saved, true);
    assert.equal(r.body.member.role, 'editor');
  });

  it('demote editor→viewer is NOT seat-checked (always allowed)', async () => {
    member.role = 'editor';
    seatService.getSeatUsage = async () => ({ seatsUsed: 2, viewersUsed: 1 }); // seats full but demoting
    const r = res();
    await orgMemberController.changeRole(changeReq('viewer'), r);
    assert.equal(saved, true);
  });

  it('lateral editor→admin (both seats) is NOT re-checked', async () => {
    member.role = 'editor';
    seatService.getSeatUsage = async () => ({ seatsUsed: 2, viewersUsed: 0 });
    const r = res();
    await orgMemberController.changeRole(changeReq('admin'), r);
    assert.equal(saved, true);
  });
});

// ─── setMemberWorkspaces — workspace-editor grant consumes a seat ───────────
describe('setMemberWorkspaces — seat sync on workspace-editor grant', () => {
  const realFindOne = OrgMember.findOne;
  const realDel = WorkspaceMember.deleteMany;
  const realUpd = WorkspaceMember.updateOne;
  after(() => { OrgMember.findOne = realFindOne; WorkspaceMember.deleteMany = realDel; WorkspaceMember.updateOne = realUpd; });

  let member, saved;
  beforeEach(() => {
    saved = false;
    member = { _id: 'm1', userId: 'u1', role: 'viewer', accessScope: 'assigned', locked: false, email: 'c@x.com', save: async () => { saved = true; } };
    Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
    OrgMember.findOne = () => member;
    Workspace.find = () => ({ select: () => ({ lean: async () => [{ _id: 'ws1' }] }) });
    tierService.getOrgTierConfig = async () => ({ config: { displayName: 'Standard', maxSeats: 2, clientViewers: 3 }, tier: 'standard' });
    Subscription.findOne = () => lean({ purchasedExtraSeats: 0 });
    seatService.getSeatUsage = async () => ({ seatsUsed: 2, viewersUsed: 1 }); // seats FULL
    WorkspaceMember.deleteMany = async () => ({});
    WorkspaceMember.updateOne = async () => ({});
    auditService.record = () => {};
  });
  const wsReq = (assignments) => ({ params: { orgId: 'org1', memberId: 'm1' }, user: { userId: OWNER, email: 'o@x.com' }, ip: '1', body: { assignments } });

  it('granting a workspace-EDITOR role to a free viewer when seats FULL → 429', async () => {
    const r = res();
    await orgMemberController.setMemberWorkspaces(wsReq([{ workspaceId: 'ws1', role: 'editor' }]), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.quota.limitKey, 'maxSeats');
    assert.equal(saved, false, 'no workspace grant persisted when over cap');
  });

  it('granting a workspace-EDITOR role when a seat is free → OrgMember.role synced to editor', async () => {
    seatService.getSeatUsage = async () => ({ seatsUsed: 1, viewersUsed: 1 }); // room
    const r = res();
    await orgMemberController.setMemberWorkspaces(wsReq([{ workspaceId: 'ws1', role: 'editor' }]), r);
    assert.equal(saved, true);
    assert.equal(member.role, 'editor', 'promoted to a seat so counting stays accurate');
  });

  it('granting only VIEWER/CLIENT workspace roles stays a free viewer (no seat check)', async () => {
    const r = res();
    await orgMemberController.setMemberWorkspaces(wsReq([{ workspaceId: 'ws1', role: 'client' }]), r);
    assert.notEqual(r.statusCode, 429);
    assert.equal(member.role, 'viewer');
  });

  it('removing edit grants from a seat member demotes them to viewer (frees the seat)', async () => {
    member.role = 'editor';
    const r = res();
    await orgMemberController.setMemberWorkspaces(wsReq([{ workspaceId: 'ws1', role: 'viewer' }]), r);
    assert.equal(saved, true);
    assert.equal(member.role, 'viewer');
  });
});

// ─── downgradeService.lockMembers ───────────────────────────────────────────
const downgradeService = require('../src/services/downgradeService');

describe('downgradeService.lockMembers — per-class locking', () => {
  const realFind = OrgMember.find;
  const realBulk = OrgMember.bulkWrite;
  const realUpdateMany = OrgMember.updateMany;
  after(() => { OrgMember.find = realFind; OrgMember.bulkWrite = realBulk; OrgMember.updateMany = realUpdateMany; });

  function collectLocks(seats, viewers) {
    const locked = new Set();
    // seat query: role $in [admin,editor]; viewer query: role $nin [...]
    const isViewerQuery = (q) => !!(q.role && q.role.$nin);
    OrgMember.find = (q) => ({
      sort: () => ({ select: () => ({ lean: async () => (isViewerQuery(q) ? viewers : seats) }) }),
    });
    OrgMember.updateMany = async () => ({});
    OrgMember.bulkWrite = async (ops) => {
      for (const op of ops) {
        if (op.updateMany.update.$set.locked === true) {
          for (const id of op.updateMany.filter._id.$in) locked.add(id);
        }
      }
      return {};
    };
    return locked;
  }

  it('locks editors past maxSeats-1 and viewers past clientViewers, independently', async () => {
    const seats = [{ _id: 's1' }, { _id: 's2' }, { _id: 's3' }]; // 3 org-wide members
    const viewers = [{ _id: 'v1' }, { _id: 'v2' }];               // 2 client viewers
    const locked = collectLocks(seats, viewers);
    // maxSeats 2 → memberSlots 1 (owner takes 1) → lock s2,s3. clientViewers 1 → lock v2.
    await downgradeService.lockMembers('org1', 2, 1);
    assert.ok(locked.has('s2') && locked.has('s3'), 'editor seats past cap locked');
    assert.ok(!locked.has('s1'), 'first editor stays unlocked');
    assert.ok(locked.has('v2') && !locked.has('v1'), 'viewer past cap locked, first stays');
  });

  it('a full editor downgrade does not lock client viewers as seats', async () => {
    const seats = [{ _id: 's1' }, { _id: 's2' }];
    const viewers = [{ _id: 'v1' }, { _id: 'v2' }, { _id: 'v3' }];
    const locked = collectLocks(seats, viewers);
    // maxSeats 1 → memberSlots 0 → lock s1,s2. clientViewers 10 → viewers all fit → none locked.
    await downgradeService.lockMembers('org1', 1, 10);
    assert.ok(locked.has('s1') && locked.has('s2'), 'all non-owner editors locked');
    assert.ok(!locked.has('v1') && !locked.has('v2') && !locked.has('v3'), 'viewers untouched by seat cap');
  });
});
