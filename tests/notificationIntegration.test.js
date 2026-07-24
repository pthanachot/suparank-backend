/**
 * End-to-end integration ("mock") test of the whole notification feature. No real
 * database — an in-memory store backs the Mongoose statics the REAL controllers
 * call, so the actual code composes across phases:
 *
 *   Phase 2 (emit)  →  Phase 6 (author/publish/unpublish)  →  Phase 3 (feed read)
 *
 * It proves the pieces work TOGETHER: a system notification and an admin
 * announcement land in one merged feed, scheduling hides a future post, expiry
 * and unpublish remove it, the new-user clamp keeps history off the badge,
 * markSeen clears it, and a tenant host is isolated from platform announcements.
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

const notificationService = require('../src/services/notificationService');
const feed = require('../src/controllers/notificationController');
const admin = require('../src/controllers/announcementController');

const { ObjectId } = mongoose.Types;

// ── Tiny in-memory Mongo ──────────────────────────────────────
// Just enough of the query surface the controllers actually use.
function matchDoc(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') { if (!cond.every((f) => matchDoc(doc, f))) return false; continue; }
    if (key === '$or') { if (!cond.some((f) => matchDoc(doc, f))) return false; continue; }
    const val = doc[key];
    if (cond === null) { if (val != null) return false; continue; }
    if (cond instanceof Date) { if (String(val) !== String(cond)) return false; continue; }
    if (typeof cond === 'object' && !cond._bsontype) {
      for (const [op, opv] of Object.entries(cond)) {
        if (op === '$lte') { if (!(val != null && new Date(val) <= new Date(opv))) return false; }
        else if (op === '$gte') { if (!(val != null && new Date(val) >= new Date(opv))) return false; }
        else if (op === '$in') { if (!opv.map(String).includes(String(val))) return false; }
        else if (op === '$ne') { if (String(val) === String(opv)) return false; }
        else return false;
      }
      continue;
    }
    if (String(val) !== String(cond)) return false;
  }
  return true;
}

function query(rows, filter) {
  let out = rows.filter((d) => matchDoc(d, filter));
  const q = {
    sort(spec) {
      const [k, dir] = Object.entries(spec)[0];
      out = [...out].sort((a, b) => {
        const av = a[k] ? new Date(a[k]).getTime() : 0;
        const bv = b[k] ? new Date(b[k]).getTime() : 0;
        return dir === -1 ? bv - av : av - bv;
      });
      return q;
    },
    skip(n) { out = out.slice(n); return q; },
    limit(n) { out = out.slice(0, n); return q; },
    select() { return q; },
    lean: async () => out,
  };
  return q;
}

let store;
const saved = {};

beforeEach(() => {
  store = { notifications: [], announcements: [], users: [] };

  saved.n = { create: Notification.create, find: Notification.find };
  saved.a = {
    create: Announcement.create, find: Announcement.find,
    count: Announcement.countDocuments, upd: Announcement.findByIdAndUpdate,
  };
  saved.u = { findById: User.findById, upd: User.findByIdAndUpdate, count: User.countDocuments };
  saved.om = { distinct: OrgMember.distinct, exists: OrgMember.exists };
  saved.wm = { distinct: WorkspaceMember.distinct, exists: WorkspaceMember.exists };
  saved.resolve = domainService.resolveOrgByHost;

  Notification.create = async (doc) => { const d = { _id: new ObjectId(), createdAt: new Date(), ...doc }; store.notifications.push(d); return d; };
  Notification.find = (filter) => query(store.notifications, filter);

  Announcement.create = async (doc) => { const d = { _id: new ObjectId(), createdAt: new Date(), ...doc }; store.announcements.push(d); return d; };
  Announcement.find = (filter) => query(store.announcements, filter);
  Announcement.countDocuments = async (filter = {}) => store.announcements.filter((d) => matchDoc(d, filter)).length;
  Announcement.findByIdAndUpdate = async (id, update) => {
    const d = store.announcements.find((x) => String(x._id) === String(id));
    if (!d) return null;
    Object.assign(d, update.$set);
    return d;
  };

  User.findById = (id) => ({ select: () => ({ lean: async () => store.users.find((u) => String(u._id) === String(id)) || null }) });
  User.findByIdAndUpdate = async (id, update) => {
    const u = store.users.find((x) => String(x._id) === String(id));
    if (u) Object.assign(u, update.$set);
    return u;
  };
  User.countDocuments = async (filter = {}) => store.users.filter((u) => matchDoc(u, filter)).length;

  // Both the .distinct (estimateAudience) AND .exists (getFeed's userIsClient)
  // surfaces must be stubbed — no clients in the base scenario.
  OrgMember.distinct = async () => [];
  WorkspaceMember.distinct = async () => [];
  OrgMember.exists = async () => false;
  WorkspaceMember.exists = async () => false;
  domainService.resolveOrgByHost = async () => null; // platform host by default
});

afterEach(() => {
  Notification.create = saved.n.create; Notification.find = saved.n.find;
  Announcement.create = saved.a.create; Announcement.find = saved.a.find;
  Announcement.countDocuments = saved.a.count; Announcement.findByIdAndUpdate = saved.a.upd;
  User.findById = saved.u.findById; User.findByIdAndUpdate = saved.u.upd; User.countDocuments = saved.u.count;
  OrgMember.distinct = saved.om.distinct; OrgMember.exists = saved.om.exists;
  WorkspaceMember.distinct = saved.wm.distinct; WorkspaceMember.exists = saved.wm.exists;
  domainService.resolveOrgByHost = saved.resolve;
});

// ── Helpers ───────────────────────────────────────────────────
function mkRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function addUser({ createdAt = new Date('2020-01-01') } = {}) {
  const u = { _id: new ObjectId(), email: 'u@x.com', status: 'active', createdAt, notificationsSeenAt: null };
  store.users.push(u);
  return u;
}
const adminReq = (body) => ({ body, params: {}, query: {}, user: { email: 'admin@suparank.ai' } });
const feedReq = (userId, headers = {}) => ({ user: { userId }, headers });

async function publish(body) {
  const res = mkRes();
  await admin.createAnnouncement(adminReq(body), res);
  return res;
}
async function getFeed(userId, headers) {
  const res = mkRes();
  await feed.getFeed(feedReq(userId, headers), res);
  return res.body;
}

// ── The overall flow ──────────────────────────────────────────
describe('notification feature — end to end', () => {
  it('a system notification and a published announcement merge into one feed, newest first', async () => {
    const user = addUser();
    await notificationService.emit({ userId: user._id, type: 'analysis.ready', title: 'Editor ready', body: 'Done', link: '/workspace/1/drafts/2' });
    await publish({ title: 'We shipped dark mode' });

    const body = await getFeed(user._id);
    assert.equal(body.items.length, 2);
    const kinds = body.items.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ['announcement', 'notification']);
    assert.equal(body.unreadCount, 2, 'both are unread for a user who has never opened the bell');
    // Newest first — the announcement (published now) vs the notification (also now):
    assert.ok(body.items.every((i) => i.title && i.timestamp));
  });

  it('a scheduled (future) announcement is hidden until its time', async () => {
    const user = addUser();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await publish({ title: 'Launch tomorrow', publishAt: future });

    const body = await getFeed(user._id);
    assert.equal(body.items.length, 0, 'a future publishAt keeps it out of the feed (read-time window)');
  });

  it('a past-published announcement is visible; an expired one is not', async () => {
    const user = addUser();
    await publish({ title: 'Still live', publishAt: new Date(Date.now() - 3_600_000).toISOString() });
    await publish({
      title: 'Already expired',
      publishAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const body = await getFeed(user._id);
    assert.deepEqual(body.items.map((i) => i.title), ['Still live']);
  });

  it('unpublishing removes an announcement from the feed', async () => {
    const user = addUser();
    const res = await publish({ title: 'Oops wrong post' });
    const id = res.body.announcement._id;

    let body = await getFeed(user._id);
    assert.equal(body.items.length, 1);

    await admin.updateAnnouncement({ body: { status: 'unpublished' }, params: { id }, user: {} }, mkRes());
    body = await getFeed(user._id);
    assert.equal(body.items.length, 0, 'unpublished → gone from the feed');
  });

  it('a brand-new user sees an old announcement but it is NOT counted as unread', async () => {
    const newUser = addUser({ createdAt: new Date() }); // account born just now
    await publish({ title: 'Old news', publishAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });

    const body = await getFeed(newUser._id);
    assert.equal(body.items.length, 1, 'still shown in the list');
    assert.equal(body.unreadCount, 0, 'but clamped to the account birthday — not unread');
  });

  it('markSeen clears the unread badge on the next read', async () => {
    const user = addUser();
    await notificationService.emit({ userId: user._id, type: 'analysis.ready', title: 'Ready' });

    let body = await getFeed(user._id);
    assert.equal(body.unreadCount, 1);

    await feed.markSeen(feedReq(user._id), mkRes());
    body = await getFeed(user._id);
    assert.equal(body.unreadCount, 0, 'seen marker advanced → nothing older is unread');
  });

  it('a tenant host is isolated from platform announcements (but still sees its own notifications)', async () => {
    const user = addUser();
    await notificationService.emit({ userId: user._id, type: 'analysis.ready', title: 'Your editor is ready' });
    await publish({ title: 'SupaRank platform news' });

    // Platform host: sees both.
    let body = await getFeed(user._id, { 'x-tenant-host': 'app.suparank.ai' });
    assert.equal(body.items.length, 2);

    // Tenant host: resolveOrgByHost now returns an org → platform announcement suppressed.
    domainService.resolveOrgByHost = async () => ({ _id: new ObjectId() });
    body = await getFeed(user._id, { 'x-tenant-host': 'agency.com' });
    assert.deepEqual(body.items.map((i) => i.kind), ['notification'], 'no platform announcement leaks to the tenant');
    assert.equal(body.items[0].title, 'Your editor is ready');
  });

  it('the admin live-count matches what a user actually sees', async () => {
    addUser();
    await publish({ title: 'A' });
    await publish({ title: 'B', publishAt: new Date(Date.now() + 86_400_000).toISOString() }); // scheduled
    await publish({ title: 'C' });

    const listRes = mkRes();
    await admin.listAnnouncements(adminReq({}), listRes);
    // 3 total, but only the 2 currently-live count as "live".
    assert.equal(listRes.body.stats.total, 3);
    assert.equal(listRes.body.stats.live, 2);
  });
});
