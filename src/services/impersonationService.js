/**
 * Impersonation ("login as") — Phase 19B. Lets a PLATFORM ADMIN obtain a short-
 * lived token acting as an agency's OWNER, to reproduce/support what the tenant
 * sees. This is the single most dangerous capability in the app, so every guard
 * is explicit and every start/stop is audited against the tenant's org.
 *
 * SAFETY MODEL:
 *   - Opt-in: the controller only routes here when IMPERSONATION_ENABLED==='true'
 *     (dark by default).
 *   - Only a platform admin can reach start/stop (adminMiddleware).
 *   - We REFUSE to impersonate a platform admin (no lateral admin capture) or
 *     oneself, and only an ACTIVE target.
 *   - The minted token (jwt.generateImpersonationToken) is short-lived, carries
 *     an `impersonatedBy` claim, and has NO refresh token → it cannot be renewed.
 *   - It is backed by a real Session under the TARGET's userId, so it shows in
 *     the target's sessions and dies on "revoke all sessions" or on stop().
 *   - validateAdmin hard-blocks any impersonated session from admin routes, so
 *     the token can act as the owner but can NEVER act as the platform admin.
 *
 * Service methods return {error: '<code>'} for expected refusals (the controller
 * maps codes → HTTP); they throw only on unexpected failures.
 */

const Organization = require('../models/Organization');
const User = require('../models/User');
const Session = require('../models/Session');
const auditService = require('./auditService');
const { isAdminEmail } = require('../utils/adminEmails');
const { generateImpersonationToken } = require('../utils/jwt');

function _ttlMinutes() {
  const n = parseInt(process.env.IMPERSONATION_TTL_MIN, 10);
  return Number.isFinite(n) && n > 0 && n <= 240 ? n : 30; // clamp 1..240m, default 30m
}

/**
 * Start impersonating the OWNER of `orgId`. Returns the token + session on
 * success, or {error} for a refusal.
 */
// Phase 18 transient states — the org is mid-mutation (teardown/purge/restore);
// minting a live owner session would race those writes on half-deleted data.
const BUSY_LIFECYCLE = ['suspending', 'purging', 'restoring'];

async function startImpersonation({ adminUser, orgId, ip = null, userAgent = null }) {
  const org = await Organization.findById(orgId).select('ownerId name lifecycleStatus').lean();
  if (!org) return { error: 'org_not_found' };
  if (!org.ownerId) return { error: 'no_owner' };
  if (BUSY_LIFECYCLE.includes(org.lifecycleStatus)) return { error: 'org_busy' };

  const target = await User.findById(org.ownerId).select('email roles tokenVersion status');
  if (!target) return { error: 'no_owner' };
  if (String(target._id) === String(adminUser.userId)) return { error: 'self' };
  if (isAdminEmail(target.email)) return { error: 'target_is_admin' };
  if (target.status !== 'active') return { error: 'target_inactive' };

  const ttl = _ttlMinutes();
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);
  const session = await Session.create({
    userId: target._id,
    impersonatorId: adminUser.userId,
    organizationId: orgId,
    expiresAt,
    userAgent: userAgent || 'impersonation',
    ip,
  });

  const token = generateImpersonationToken(target, session._id, adminUser.userId, ttl);

  await auditService.record({
    organizationId: orgId,
    userId: adminUser.userId,
    actorEmail: adminUser.email,
    action: 'admin.impersonate.start',
    resourceId: target._id,
    meta: {
      targetUserId: String(target._id),
      targetEmail: target.email,
      sessionId: String(session._id),
      expiresAt,
    },
    ip,
  });

  return {
    token,
    sessionId: session._id,
    expiresAt,
    ttlMinutes: ttl,
    organization: { id: String(orgId), name: org.name },
    target: { userId: target._id, email: target.email },
  };
}

/**
 * End an impersonation session. Any platform admin may stop any impersonation
 * (de-escalation is always safe); the stopper is recorded. Idempotent.
 */
async function stopImpersonation({ adminUser, sessionId, ip = null }) {
  const session = await Session.findById(sessionId);
  if (!session || !session.impersonatorId) return { error: 'not_found' }; // not an impersonation session

  const already = session.status === 'ended';
  if (!already) await session.end();

  await auditService.record({
    organizationId: session.organizationId,
    userId: adminUser.userId,
    actorEmail: adminUser.email,
    action: 'admin.impersonate.stop',
    resourceId: session.userId,
    meta: {
      targetUserId: String(session.userId),
      sessionId: String(session._id),
      impersonatorId: String(session.impersonatorId),
      alreadyEnded: already,
    },
    ip,
  });

  return { ended: true, alreadyEnded: already };
}

/**
 * List currently-live impersonation sessions (for the admin UI). Filters out
 * expired-but-not-yet-ended sessions — their tokens are already dead.
 */
async function listActiveImpersonations() {
  const sessions = await Session.find({
    impersonatorId: { $ne: null },
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  if (!sessions.length) return [];

  const userIds = [...new Set(sessions.flatMap((s) => [String(s.userId), String(s.impersonatorId)]))];
  const users = await User.find({ _id: { $in: userIds } }).select('email').lean();
  const emailById = new Map(users.map((u) => [String(u._id), u.email]));

  return sessions.map((s) => ({
    sessionId: s._id,
    targetUserId: s.userId,
    targetEmail: emailById.get(String(s.userId)) || null,
    impersonatorId: s.impersonatorId,
    impersonatorEmail: emailById.get(String(s.impersonatorId)) || null,
    organizationId: s.organizationId || null,
    startedAt: s.createdAt,
    expiresAt: s.expiresAt || null,
  }));
}

module.exports = { startImpersonation, stopImpersonation, listActiveImpersonations, _ttlMinutes };
