/**
 * Fire-and-forget audit recording. NEVER throws and never blocks the
 * calling request — a broken audit write must not break the operation.
 *
 * Usage (workspace-scoped route, after resolveWorkspaceWithRole):
 *   auditService.fromReq(req, { action: 'content.create', resourceId: id, meta: { title } });
 *
 * Usage (org-scoped or system):
 *   auditService.record({ organizationId, userId, actorEmail, action, resourceId, meta, ip });
 *
 * `resource` is derived from the action's dot-prefix ('content.create' →
 * 'content') unless passed explicitly — keeps the action/resource pair
 * coherent across all call sites.
 *
 * Personal (org-less) workspaces are INTENTIONALLY unaudited: the audit
 * trail is an organization feature, and record() silently no-ops without
 * an organizationId. If you instrument a route and see no rows, check
 * that the workspace belongs to an org.
 *
 * Noisy actions (content autosave) pass dedupeMinutes — a repeat of the
 * same {org, action, resourceId, userId} with UNCHANGED meta within the
 * window is skipped. Dedupe is a process-local cache (no DB read on the
 * hot path); a changed meta (e.g. a rename) always writes.
 */

const AuditLog = require('../models/AuditLog');

// ─── Process-local dedupe cache ─────────────────────────────────
// key → { expiresAt, metaSig }. Best-effort: resets on restart and is
// per-instance, which only means an occasional extra entry — acceptable
// for noise suppression, and atomic within the process (no read-then-
// write race like a DB exists() check would have).

const _dedupe = new Map();
const DEDUPE_MAX_ENTRIES = 10_000;

function _dedupeKey({ organizationId, action, resourceId, userId }) {
  return `${organizationId}:${action}:${resourceId}:${userId}`;
}

function _metaSig(meta) {
  try {
    return JSON.stringify(meta ?? null);
  } catch {
    return String(meta);
  }
}

function _pruneDedupe() {
  if (_dedupe.size <= DEDUPE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of _dedupe) {
    if (entry.expiresAt <= now) _dedupe.delete(key);
  }
  // Still over cap after expiry pruning → drop oldest-inserted
  while (_dedupe.size > DEDUPE_MAX_ENTRIES) {
    _dedupe.delete(_dedupe.keys().next().value);
  }
}

/** Test hook — clears the dedupe cache. */
function clearDedupeCache() {
  _dedupe.clear();
}

async function record({
  organizationId,
  workspaceId = null,
  userId = null,
  actorEmail = '',
  action,
  resource,
  resourceId = null,
  meta = null,
  ip = null,
  dedupeMinutes = 0,
}) {
  try {
    if (!organizationId || !action) return;
    const resolvedResource = resource || action.split('.')[0];

    if (dedupeMinutes > 0) {
      const key = _dedupeKey({ organizationId, action, resourceId, userId });
      const sig = _metaSig(meta);
      const cached = _dedupe.get(key);
      if (cached && cached.expiresAt > Date.now() && cached.metaSig === sig) {
        return; // same event, unchanged content, inside the window — skip
      }
      _dedupe.set(key, {
        expiresAt: Date.now() + dedupeMinutes * 60 * 1000,
        metaSig: sig,
      });
      _pruneDedupe();
    }

    await AuditLog.create({
      organizationId,
      workspaceId,
      userId,
      actorEmail,
      action,
      resource: resolvedResource,
      resourceId: resourceId != null ? String(resourceId) : null,
      meta,
      ip,
    });
  } catch (err) {
    console.error(`[audit] failed to record ${action}:`, err.message);
  }
}

/**
 * Convenience wrapper for workspace-scoped routes — pulls org/workspace
 * from req.workspace (set by resolveWorkspaceWithRole) and the actor
 * from req.user. Fire-and-forget: intentionally not awaited by callers.
 */
function fromReq(req, { action, resource, resourceId, meta, dedupeMinutes }) {
  const workspace = req.workspace;
  return record({
    organizationId: workspace?.organizationId || null,
    workspaceId: workspace?._id || null,
    userId: req.user?.userId || null,
    actorEmail: req.user?.email || '',
    action,
    resource,
    resourceId,
    meta,
    ip: req.ip || null,
    dedupeMinutes,
  });
}

module.exports = { record, fromReq, clearDedupeCache };
