/**
 * Phase 6 — admin announcement authoring. No database; the model + count queries
 * are stubbed. Pins the things that carry risk: publish stores the row as the
 * audit record (status/publishedBy/audienceCount/publishAt), scheduling is a
 * future publishAt on a 'published' row (NOT a separate status — the feed's
 * publishAt window hides it until then), link safety rejects absolute/protocol-
 * relative paths, and the audience estimate subtracts excluded clients.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Announcement = require('../src/models/Announcement');
const User = require('../src/models/User');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const controller = require('../src/controllers/announcementController');

const { ObjectId } = mongoose.Types;

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function mockReq(body = {}, params = {}) {
  return { body, params, query: {}, user: { email: 'admin@suparank.ai' } };
}

const saved = {};
beforeEach(() => {
  saved.create = Announcement.create;
  saved.userCount = User.countDocuments;
  saved.orgDistinct = OrgMember.distinct;
  saved.wsDistinct = WorkspaceMember.distinct;
  saved.findUpd = Announcement.findByIdAndUpdate;

  Announcement.create = async (doc) => ({ _id: new ObjectId(), ...doc });
  User.countDocuments = async () => 1000;
  OrgMember.distinct = async () => [];
  WorkspaceMember.distinct = async () => [];
});
afterEach(() => {
  Announcement.create = saved.create;
  User.countDocuments = saved.userCount;
  OrgMember.distinct = saved.orgDistinct;
  WorkspaceMember.distinct = saved.wsDistinct;
  Announcement.findByIdAndUpdate = saved.findUpd;
});

describe('isSafePath', () => {
  it('accepts a relative path, rejects absolute, protocol-relative, and backslash bypasses', () => {
    assert.equal(controller.isSafePath('/workspace/1/x'), true);
    assert.equal(controller.isSafePath('https://evil.com'), false);
    assert.equal(controller.isSafePath('//evil.com'), false);
    // Backslash variants some browsers normalize to //evil.com — must be rejected.
    assert.equal(controller.isSafePath('/\\evil.com'), false);
    assert.equal(controller.isSafePath('/\\/evil.com'), false);
  });
});

describe('estimateAudience', () => {
  it('returns all active users when clients are not excluded', async () => {
    assert.equal(await controller.estimateAudience({ excludeRoles: [] }), 1000);
  });

  it('subtracts distinct client users when clients are excluded', async () => {
    const shared = new ObjectId();
    OrgMember.distinct = async () => [shared, new ObjectId()];
    WorkspaceMember.distinct = async () => [shared]; // overlap deduped
    assert.equal(await controller.estimateAudience({ excludeRoles: ['client'] }), 1000 - 2);
  });
});

describe('createAnnouncement', () => {
  it('publishes now: stores it as the audit record', async () => {
    let created = null;
    Announcement.create = async (doc) => { created = doc; return { _id: new ObjectId(), ...doc }; };
    const res = mockRes();
    await controller.createAnnouncement(mockReq({ title: '  Hello  ', body: 'Hi', link: '/x' }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(created.title, 'Hello', 'title trimmed');
    assert.equal(created.status, 'published');
    assert.equal(created.authorScope, 'platform');
    assert.equal(created.class, 'product');
    assert.equal(created.publishedBy, 'admin@suparank.ai');
    assert.equal(created.audienceCount, 1000);
    assert.ok(created.publishAt instanceof Date);
    assert.deepEqual(created.audience.excludeRoles, ['client'], 'excludes clients by default');
  });

  it('schedules via a future publishAt on a still-"published" row (no separate status)', async () => {
    let created = null;
    Announcement.create = async (doc) => { created = doc; return { _id: new ObjectId(), ...doc }; };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await controller.createAnnouncement(mockReq({ title: 'Later', publishAt: future }), mockRes());

    assert.equal(created.status, 'published', 'scheduling is a publishAt window, not a status');
    assert.equal(created.publishAt.toISOString(), future);
  });

  it('rejects a missing title', async () => {
    const res = mockRes();
    await controller.createAnnouncement(mockReq({ title: '   ' }), res);
    assert.equal(res.statusCode, 400);
  });

  it('rejects an absolute link', async () => {
    const res = mockRes();
    await controller.createAnnouncement(mockReq({ title: 't', link: 'https://evil.com' }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /relative path/);
  });

  it('rejects an expiry at or before the publish time', async () => {
    const now = Date.now();
    const res = mockRes();
    await controller.createAnnouncement(mockReq({
      title: 't',
      publishAt: new Date(now + 86_400_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /after the publish/);
  });

  it('respects excludeClients:false (no client exclusion)', async () => {
    let created = null;
    Announcement.create = async (doc) => { created = doc; return { _id: new ObjectId(), ...doc }; };
    await controller.createAnnouncement(mockReq({ title: 't', excludeClients: false }), mockRes());
    assert.deepEqual(created.audience.excludeRoles, []);
  });
});

describe('listAnnouncements', () => {
  const realFind = Announcement.find;
  const realCount = Announcement.countDocuments;
  afterEach(() => {
    Announcement.find = realFind;
    Announcement.countDocuments = realCount;
  });

  it('returns items + pagination + a live count computed from the publish window', async () => {
    const items = [{ _id: new ObjectId(), title: 'A' }];
    Announcement.find = () => ({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => items }) }) }),
    });
    let liveFilter = null;
    Announcement.countDocuments = async (filter) => {
      if (filter && filter.status === 'published') { liveFilter = filter; return 3; }
      return 10; // total
    };

    const res = mockRes();
    await controller.listAnnouncements(mockReq(), res);

    assert.equal(res.body.stats.total, 10);
    assert.equal(res.body.stats.live, 3);
    assert.equal(res.body.pagination.total, 10);
    assert.equal(res.body.announcements.length, 1);
    // The live count must use the same status+publishAt+expiresAt window as the
    // feed read query, or the admin's "live" number would disagree with reality.
    assert.equal(liveFilter.status, 'published');
    assert.ok(Array.isArray(liveFilter.$and), 'live count constrains the publish/expiry window');
  });
});

describe('updateAnnouncement', () => {
  it('unpublishes', async () => {
    let update = null;
    Announcement.findByIdAndUpdate = async (id, u) => { update = u; return { _id: id, ...u.$set }; };
    const res = mockRes();
    await controller.updateAnnouncement(mockReq({ status: 'unpublished' }, { id: 'a1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(update.$set.status, 'unpublished');
  });

  it('rejects an absolute link on edit', async () => {
    const res = mockRes();
    await controller.updateAnnouncement(mockReq({ link: '//evil.com' }, { id: 'a1' }), res);
    assert.equal(res.statusCode, 400);
  });

  it('404s an unknown id', async () => {
    Announcement.findByIdAndUpdate = async () => null;
    const res = mockRes();
    await controller.updateAnnouncement(mockReq({ status: 'unpublished' }, { id: 'nope' }), res);
    assert.equal(res.statusCode, 404);
  });

  it('rejects an empty update', async () => {
    const res = mockRes();
    await controller.updateAnnouncement(mockReq({}, { id: 'a1' }), res);
    assert.equal(res.statusCode, 400);
  });
});
