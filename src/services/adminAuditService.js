/**
 * adminAuditService — fire-and-forget recorder for platform-admin actions into
 * AdminAuditLog (Phase 13). NEVER throws and NEVER blocks the calling request —
 * a broken audit write must not break the admin operation it records.
 *
 * Usage (in an admin controller, after the mutation succeeds — NOT awaited):
 *   const adminAudit = require('../services/adminAuditService');
 *   const A = require('../services/adminAuditActions');
 *   adminAudit.fromReq(req, {
 *     action: A.USER_CREDITS, targetType: 'user', targetId: user.userId,
 *     ...adminAudit.withDiff({ freeCredits: prev }, { freeCredits: next }),
 *   });
 *
 * No dedupe (unlike auditService): admin actions are low-volume, and every one
 * matters for the trail.
 */

const AdminAuditLog = require('../models/AdminAuditLog');
const ACTIONS = require('./adminAuditActions');

/**
 * Build a minimal { before, after } diff containing ONLY the keys that changed,
 * so the trail stores deltas, not whole documents. Non-object inputs pass through
 * as scalar snapshots. Returns nulls when nothing changed.
 */
function withDiff(before, after) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(before) || !isObj(after)) {
    // scalar (or array) snapshot — only record if they actually differ
    if (JSON.stringify(before) === JSON.stringify(after)) return { before: null, after: null };
    return { before: before ?? null, after: after ?? null };
  }
  const b = {};
  const a = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k] ?? null;
      a[k] = after[k] ?? null;
    }
  }
  return {
    before: Object.keys(b).length ? b : null,
    after: Object.keys(a).length ? a : null,
  };
}

async function record({
  actorUserId = null,
  actorEmail = '',
  action,
  targetType,
  targetId = null,
  before = null,
  after = null,
  meta = null,
  ip = null,
  impersonated = false,
}) {
  try {
    // action + targetType are the model's required fields; skip silently rather
    // than throw (fire-and-forget).
    if (!action || !targetType) return;
    await AdminAuditLog.create({
      actorUserId,
      actorEmail,
      action,
      targetType,
      targetId: targetId != null ? String(targetId) : null,
      before,
      after,
      meta,
      ip,
      impersonated,
    });
  } catch (err) {
    console.error(`[adminAudit] failed to record ${action}:`, err.message);
  }
}

/**
 * Convenience wrapper — pulls the actor/ip/impersonation flag from req. Fire-and-
 * forget: intentionally NOT awaited by callers.
 */
function fromReq(req, { action, targetType, targetId = null, before = null, after = null, meta = null }) {
  return record({
    actorUserId: req.user?.userId || null,
    actorEmail: req.user?.email || '',
    action,
    targetType,
    targetId,
    before,
    after,
    meta,
    ip: req.ip || null,
    impersonated: !!req.user?.impersonatedBy,
  });
}

module.exports = { record, fromReq, withDiff, ACTIONS };
