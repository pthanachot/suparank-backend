const Notification = require('../models/Notification');
const Announcement = require('../models/Announcement');
const User = require('../models/User');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
// NOT destructured on purpose: the read handler calls domainService.resolveOrgByHost
// so tests can stub it. A destructured reference captured at module load can't be
// swapped, and this is the one function whose behaviour the isolation test must vary.
const domainService = require('../services/domainService');

const FEED_LIMIT = 30;

// The unified feed-item shape the bell renders. `timestamp` is what the merge
// sort and the unread comparison both use.
function notificationItem(n) {
  return {
    id: String(n._id),
    kind: 'notification',
    type: n.type,
    title: n.title,
    body: n.body || '',
    link: n.link || '',
    timestamp: n.createdAt,
  };
}
function announcementItem(a) {
  return {
    id: String(a._id),
    kind: 'announcement',
    type: 'announcement',
    title: a.title,
    body: a.body || '',
    link: a.link || '',
    // When it became visible to users — what "new since I last looked" measures
    // against. publishAt is set at publish; fall back to createdAt defensively.
    timestamp: a.publishAt || a.createdAt,
  };
}

// An external agency client is a 'client'-role member in some org or workspace.
// Dormant in v1 (no clients exist yet); the query is indexed and only runs when
// a live announcement actually excludes that role.
async function userIsClient(userId) {
  const [inOrg, inWs] = await Promise.all([
    OrgMember.exists({ userId, role: 'client', status: 'active' }),
    WorkspaceMember.exists({ userId, role: 'client', status: 'active' }),
  ]);
  return !!(inOrg || inWs);
}

// GET /api/notifications — merged feed + unread badge count.
const getFeed = async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId).select('createdAt notificationsSeenAt').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // The reader's own per-user notifications, newest first.
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(FEED_LIMIT)
      .lean();

    // ── Brand scope: the white-label isolation linchpin ──
    // Resolved SERVER-SIDE from the forwarded host — a client-asserted brand is
    // spoofable, so nothing but this is trusted. resolveOrgByHost returns null
    // for every host until the customDomains flag is live, so in v1 all traffic
    // is platform: platform announcements reach everyone and org announcements
    // (never authored yet) never appear. When the flag goes live, this same code
    // isolates tenant traffic unchanged. Isolation is exactly as strong as
    // resolveOrgByHost — never assume it is unconditional.
    const hostOrg = await domainService.resolveOrgByHost(
      req.headers['x-tenant-host'] || req.headers.host || ''
    );

    const now = new Date();
    const liveWindow = {
      status: 'published',
      $and: [
        { $or: [{ publishAt: null }, { publishAt: { $lte: now } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
      ],
    };
    // Platform host → ONLY platform announcements. Tenant host → ONLY that org's
    // announcements, NEVER platform — that cross-brand leak is the whole reason
    // scope is resolved server-side.
    const scope = hostOrg
      ? { authorScope: 'org', authorOrgId: hostOrg._id }
      : { authorScope: 'platform' };

    let announcements = await Announcement.find({ ...liveWindow, ...scope })
      .sort({ publishAt: -1 })
      .limit(FEED_LIMIT)
      .lean();

    // ── Audience filter (lazy: only resolve the reader's role if a live
    // announcement actually filters on it) ──
    if (announcements.length) {
      const needsClientCheck = announcements.some((a) => a.audience?.excludeRoles?.length);
      const isClient = needsClientCheck ? await userIsClient(userId) : false;
      announcements = announcements.filter((a) => {
        const excluded = a.audience?.excludeRoles || [];
        if (excluded.includes('client') && isClient) return false;
        // DEFERRED (tier targeting): a.audience.tiers matching is implemented WITH
        // the Phase 6 authoring UI that produces tiered announcements — resolving
        // "the reader's tier" is ambiguous across a user's several orgs and is not
        // worth building against data no author yet creates. v1 authors leave
        // tiers empty (= all tiers), so this is a no-op today.
        return true;
      });
    }

    // ── Merge, sort newest-first, cap ──
    const items = [...announcements.map(announcementItem), ...notifications.map(notificationItem)]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, FEED_LIMIT);

    // Unread = items newer than the seen marker, clamped to the account's birth
    // so a brand-new user never opens the bell onto historical announcements.
    // (Counted over the capped list — a badge only needs "some/many", not exact.)
    const clampMs = Math.max(
      new Date(user.createdAt || 0).getTime(),
      user.notificationsSeenAt ? new Date(user.notificationsSeenAt).getTime() : 0
    );
    const unreadCount = items.filter((it) => new Date(it.timestamp).getTime() > clampMs).length;

    res.json({ items, unreadCount });
  } catch (err) {
    console.error('[notifications] getFeed error:', err.message);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
};

// POST /api/notifications/seen — advance the seen marker (clears the badge).
const markSeen = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.userId, { $set: { notificationsSeenAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] markSeen error:', err.message);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
};

module.exports = { getFeed, markSeen, userIsClient };
