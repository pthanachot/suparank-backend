/**
 * Phase 3 — the feed read API. No database; the model query methods and
 * domainService.resolveOrgByHost are stubbed. The load-bearing test is the
 * white-label isolation one: a tenant-host request must query ONLY that org's
 * announcements and NEVER platform ones. The rest pin the scheduled/expired
 * window, the client-role exclusion, the new-user badge clamp, and markSeen.
 *
 * IMPORTANT: resolveOrgByHost is stubbed to SIMULATE the customDomains flag
 * being live. In the real v1 it returns null for every host (flag dark), so an
 * end-to-end test would show every request as platform — a false green. These
 * tests drive the isolation logic directly by controlling that resolution.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Notification = require('../src/models/Notification');
const Announcement = require('../src/models/Announcement');
const User = require('../src/models/User');
const OrgMember = require('../src/models/OrgMember');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const domainService = require('../src/services/domainService');
const controller = require('../src/controllers/notificationController');

const { ObjectId } = mongoose.Types;

// Chainable query stub: .sort().limit().lean() → resolves to `val`.
function q(val) {
  const chain = { sort: () => chain, limit: () => chain, lean: async () => val };
  return chain;
}
function findByIdStub(val) {
  const chain = { select: () => chain, lean: async () => val };
  return chain;
}
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const userId = new ObjectId();
function req(headers = {}) {
  return { user: { userId }, headers };
}

const saved = {};
beforeEach(() => {
  saved.userFind = User.findById;
  saved.userUpd = User.findByIdAndUpdate;
  saved.notifFind = Notification.find;
  saved.annFind = Announcement.find;
  saved.orgExists = OrgMember.exists;
  saved.wsExists = WorkspaceMember.exists;
  saved.resolve = domainService.resolveOrgByHost;

  // Defaults: an old account, no announcements, no notifications, not a client,
  // platform host. Individual tests override what they exercise.
  User.findById = () => findByIdStub({ createdAt: new Date('2020-01-01'), notificationsSeenAt: null });
  Notification.find = () => q([]);
  Announcement.find = () => q([]);
  OrgMember.exists = async () => false;
  WorkspaceMember.exists = async () => false;
  domainService.resolveOrgByHost = async () => null; // platform host
});
afterEach(() => {
  User.findById = saved.userFind;
  User.findByIdAndUpdate = saved.userUpd;
  Notification.find = saved.notifFind;
  Announcement.find = saved.annFind;
  OrgMember.exists = saved.orgExists;
  WorkspaceMember.exists = saved.wsExists;
  domainService.resolveOrgByHost = saved.resolve;
});

describe('getFeed — white-label isolation (the linchpin)', () => {
  it('a TENANT host queries only that org and NEVER platform announcements', async () => {
    const tenantOrgId = new ObjectId();
    domainService.resolveOrgByHost = async () => ({ _id: tenantOrgId });
    let captured = null;
    Announcement.find = (filter) => { captured = filter; return q([]); };

    await controller.getFeed(req({ 'x-tenant-host': 'agency.com' }), mockRes());

    assert.equal(captured.authorScope, 'org', 'tenant host must scope to org announcements');
    assert.equal(String(captured.authorOrgId), String(tenantOrgId));
    assert.notEqual(captured.authorScope, 'platform', 'tenant host must NEVER receive platform announcements');
  });

  it('a PLATFORM host queries only platform announcements', async () => {
    let captured = null;
    Announcement.find = (filter) => { captured = filter; return q([]); };

    await controller.getFeed(req({ host: 'app.suparank.ai' }), mockRes());

    assert.equal(captured.authorScope, 'platform');
    assert.equal(captured.authorOrgId, undefined);
  });
});

describe('getFeed — the live-window query (scheduled/expired excluded)', () => {
  it('constrains status=published and the publishAt/expiresAt window', async () => {
    let captured = null;
    Announcement.find = (filter) => { captured = filter; return q([]); };

    await controller.getFeed(req(), mockRes());

    assert.equal(captured.status, 'published');
    // publishAt <= now (or null) AND expiresAt >= now (or null)
    const [pub, exp] = captured.$and;
    assert.ok(pub.$or.some((c) => c.publishAt && c.publishAt.$lte instanceof Date), 'publishAt <= now');
    assert.ok(pub.$or.some((c) => c.publishAt === null), 'or publishAt null');
    assert.ok(exp.$or.some((c) => c.expiresAt && c.expiresAt.$gte instanceof Date), 'expiresAt >= now');
    assert.ok(exp.$or.some((c) => c.expiresAt === null), 'or expiresAt null');
  });
});

describe('getFeed — audience: client-role exclusion', () => {
  const ann = {
    _id: new ObjectId(), title: 'Platform news', body: '', link: '',
    publishAt: new Date('2026-07-01'), createdAt: new Date('2026-07-01'),
    audience: { excludeRoles: ['client'], tiers: [] },
  };

  it('hides an excludeRoles:[client] announcement from a client-role user', async () => {
    Announcement.find = () => q([ann]);
    OrgMember.exists = async () => true; // this user is a client somewhere
    const res = mockRes();
    await controller.getFeed(req(), res);
    assert.equal(res.body.items.length, 0, 'a client must not see client-excluded platform news');
  });

  it('shows the same announcement to a non-client user', async () => {
    Announcement.find = () => q([ann]);
    // OrgMember/WorkspaceMember.exists default false → not a client
    const res = mockRes();
    await controller.getFeed(req(), res);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].kind, 'announcement');
  });

  it('a workspace-level client is also excluded (not only org-level)', async () => {
    Announcement.find = () => q([ann]);
    OrgMember.exists = async () => false;
    WorkspaceMember.exists = async () => true; // client via a workspace membership
    const res = mockRes();
    await controller.getFeed(req(), res);
    assert.equal(res.body.items.length, 0);
  });

  it('skips the client-role lookup entirely when there are no live announcements', async () => {
    let checked = false;
    OrgMember.exists = async () => { checked = true; return false; };
    WorkspaceMember.exists = async () => { checked = true; return false; };
    // Announcement.find defaults to [] → nothing to filter → no reason to query role.
    await controller.getFeed(req(), mockRes());
    assert.equal(checked, false, 'the role query must not run on the common empty-feed poll');
  });
});

describe('getFeed — merge + unread clamp', () => {
  it('merges announcements and notifications newest-first', async () => {
    Announcement.find = () => q([
      { _id: new ObjectId(), title: 'A', publishAt: new Date('2026-07-10'), createdAt: new Date('2026-07-10'), audience: {} },
    ]);
    Notification.find = () => q([
      { _id: new ObjectId(), type: 'analysis.ready', title: 'N', createdAt: new Date('2026-07-20') },
    ]);
    const res = mockRes();
    await controller.getFeed(req(), res);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.items[0].title, 'N', 'the newer notification sorts first');
    assert.equal(res.body.items[1].title, 'A');
  });

  it('a brand-new user does NOT see an old announcement as unread', async () => {
    // Account created today; the announcement predates it.
    User.findById = () => findByIdStub({ createdAt: new Date('2026-07-24'), notificationsSeenAt: null });
    Announcement.find = () => q([
      { _id: new ObjectId(), title: 'Old news', publishAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01'), audience: {} },
    ]);
    const res = mockRes();
    await controller.getFeed(req(), res);
    assert.equal(res.body.items.length, 1, 'the item is still shown in the list');
    assert.equal(res.body.unreadCount, 0, 'but it is not unread — clamped to the account birthday');
  });

  it('counts a fresh notification as unread past the seen marker', async () => {
    User.findById = () => findByIdStub({ createdAt: new Date('2026-01-01'), notificationsSeenAt: new Date('2026-07-20') });
    Notification.find = () => q([
      { _id: new ObjectId(), type: 'analysis.ready', title: 'After seen', createdAt: new Date('2026-07-23') },
      { _id: new ObjectId(), type: 'analysis.ready', title: 'Before seen', createdAt: new Date('2026-07-10') },
    ]);
    const res = mockRes();
    await controller.getFeed(req(), res);
    assert.equal(res.body.unreadCount, 1, 'only the post-seen notification is unread');
  });
});

describe('markSeen', () => {
  it('advances notificationsSeenAt to now', async () => {
    let captured = null;
    User.findByIdAndUpdate = async (id, update) => { captured = { id, update }; };
    const res = mockRes();
    await controller.markSeen(req(), res);
    assert.equal(String(captured.id), String(userId));
    assert.ok(captured.update.$set.notificationsSeenAt instanceof Date);
    assert.deepEqual(res.body, { ok: true });
  });
});
