/**
 * Admin session management — list active sessions, revoke one session,
 * or revoke everything for a user (ends sessions + bumps tokenVersion so
 * all outstanding JWTs die on their next request).
 */
const Session = require('../models/Session');
const User = require('../models/User');

const listSessions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const filter = { status: 'active' };

    if (req.query.email) {
      // Partial, case-insensitive match (regex-escaped) — the UI filter is a
      // search box, not an exact-email lookup.
      const escaped = String(req.query.email).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const users = await User.find({ email: { $regex: escaped, $options: 'i' } })
        .select('_id')
        .limit(100)
        .lean();
      if (!users.length) return res.json({ sessions: [], pagination: { total: 0, pages: 0, page } });
      filter.userId = { $in: users.map((u) => u._id) };
    }

    const total = await Session.countDocuments(filter);
    const sessions = await Session.find(filter)
      .sort({ lastActivity: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const userIds = [...new Set(sessions.map((s) => s.userId?.toString()).filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('email profile.name userId')
      .lean();
    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    const mySessionId = req.user?.sessionId?.toString();

    res.json({
      sessions: sessions.map((s) => {
        const u = byId.get(s.userId?.toString());
        return {
          id: s._id,
          userId: u?.userId || null,
          email: u?.email || null,
          name: u?.profile?.name || null,
          ip: s.ip || null,
          userAgent: s.userAgent || null,
          createdAt: s.createdAt,
          lastActivity: s.lastActivity,
          isCurrentSession: mySessionId ? s._id.toString() === mySessionId : false,
        };
      }),
      pagination: { total, pages: Math.ceil(total / limit), page },
    });
  } catch (error) {
    console.error('[admin] listSessions error:', error.message);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
};

const revokeSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'ended') return res.json({ success: true, alreadyEnded: true });

    await session.end();
    const isCurrentSession = req.user?.sessionId
      ? session._id.toString() === req.user.sessionId.toString()
      : false;
    console.log(`[admin] Session ${session._id} revoked by ${req.user?.email}`);
    res.json({ success: true, isCurrentSession });
  } catch (error) {
    console.error('[admin] revokeSession error:', error.message);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
};

const revokeAllUserSessions = async (req, res) => {
  try {
    const user = await User.findOne({ userId: parseInt(req.params.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await Session.updateMany(
      { userId: user._id, status: 'active' },
      { $set: { status: 'ended' } }
    );
    // Bump tokenVersion so even tokens without a live session check die
    await user.invalidateTokens();

    const affectsYou = req.user?.userId?.toString() === user._id.toString();
    console.log(
      `[admin] All sessions revoked for ${user.email} by ${req.user?.email} (${result.modifiedCount} session(s))`
    );
    res.json({ success: true, sessionsEnded: result.modifiedCount, tokenVersionBumped: true, affectsYou });
  } catch (error) {
    console.error('[admin] revokeAllUserSessions error:', error.message);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
};

module.exports = { listSessions, revokeSession, revokeAllUserSessions };
