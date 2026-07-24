const Announcement = require('../models/Announcement');
const User = require('../models/User');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');

// Admin authoring for platform announcements (the "Notifications" tab). v1 only
// creates PLATFORM-scope, PRODUCT-class announcements; tenant-owner authoring and
// email delivery are deferred (see NOTIFICATION-SYSTEM-PLAN.md).

// Only same-origin relative paths are storable. An absolute or protocol-relative
// link would be an open-redirect surface once these render in the bell (and are
// eventually authored by tenant owners) — the bell also re-checks this, but we
// reject at the source too.
function isSafePath(link) {
  return link.startsWith('/') && !link.startsWith('//');
}

// Coarse reach estimate at publish time. v1 audience = the platform: active
// users, minus external agency clients when they're excluded (the default). Not
// tier-precise — tier targeting and its exact counting are deferred together.
async function estimateAudience(audience) {
  const activeUsers = await User.countDocuments({ status: 'active' });
  if (!audience?.excludeRoles?.includes('client')) return activeUsers;
  const [orgClients, wsClients] = await Promise.all([
    OrgMember.distinct('userId', { role: 'client', status: 'active' }),
    WorkspaceMember.distinct('userId', { role: 'client', status: 'active' }),
  ]);
  const clientIds = new Set([...orgClients, ...wsClients].map(String));
  return Math.max(0, activeUsers - clientIds.size);
}

// POST /api/admin/announcements — create + publish (now, or scheduled via a
// future publishAt). There is no separate "scheduled" persisted status: an
// announcement is stored 'published' and the feed read query's publishAt window
// decides when it actually appears (scheduling is a read-time predicate — no
// cron, and unpublish is instant).
const createAnnouncement = async (req, res) => {
  try {
    const { title, body, link, excludeClients, publishAt, expiresAt } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });

    const cleanLink = link ? String(link).trim() : '';
    if (cleanLink && !isSafePath(cleanLink)) {
      return res.status(400).json({ error: 'Link must be a relative path starting with "/"' });
    }

    const now = new Date();
    const pubAt = publishAt ? new Date(publishAt) : now;
    if (publishAt && Number.isNaN(pubAt.getTime())) return res.status(400).json({ error: 'Invalid publish date' });
    const expAt = expiresAt ? new Date(expiresAt) : null;
    if (expiresAt && Number.isNaN(expAt.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
    if (expAt && expAt <= pubAt) return res.status(400).json({ error: 'Expiry must be after the publish time' });

    const audience = { tiers: [], excludeRoles: excludeClients === false ? [] : ['client'] };
    const audienceCount = await estimateAudience(audience);

    const announcement = await Announcement.create({
      title: String(title).trim(),
      body: body ? String(body) : '',
      link: cleanLink,
      class: 'product', // v1: product-class only
      authorScope: 'platform', // v1: platform-scope only
      audience,
      publishAt: pubAt,
      expiresAt: expAt,
      status: 'published',
      publishedBy: req.user?.email || 'admin',
      audienceCount,
    });

    res.status(201).json({ announcement, audienceCount });
  } catch (err) {
    // A schema violation (over-length title/body, bad enum) is the caller's
    // fault → 400, not a server 500. The UI already caps lengths; this keeps a
    // direct API call honest too.
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    console.error('[admin] createAnnouncement error:', err.message);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
};

// GET /api/admin/announcements — paginated list + light stats.
const listAnnouncements = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;

    const [announcements, total] = await Promise.all([
      Announcement.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Announcement.countDocuments({}),
    ]);

    const now = new Date();
    const live = await Announcement.countDocuments({
      status: 'published',
      $and: [
        { $or: [{ publishAt: null }, { publishAt: { $lte: now } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
      ],
    });

    res.json({
      announcements,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      stats: { total, live },
    });
  } catch (err) {
    console.error('[admin] listAnnouncements error:', err.message);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
};

// PATCH /api/admin/announcements/:id — unpublish (or re-publish), or edit copy.
const updateAnnouncement = async (req, res) => {
  try {
    const update = {};
    if (req.body.status === 'unpublished' || req.body.status === 'published') {
      update.status = req.body.status;
    }
    if (req.body.title !== undefined) {
      if (!String(req.body.title).trim()) return res.status(400).json({ error: 'Title is required' });
      update.title = String(req.body.title).trim();
    }
    if (req.body.body !== undefined) update.body = String(req.body.body);
    if (req.body.link !== undefined) {
      const cleanLink = String(req.body.link).trim();
      if (cleanLink && !isSafePath(cleanLink)) {
        return res.status(400).json({ error: 'Link must be a relative path starting with "/"' });
      }
      update.link = cleanLink;
    }
    if (req.body.expiresAt !== undefined) {
      update.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    }

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const announcement = await Announcement.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    res.json({ announcement });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    console.error('[admin] updateAnnouncement error:', err.message);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
};

module.exports = { createAnnouncement, listAnnouncements, updateAnnouncement, estimateAudience, isSafePath };
