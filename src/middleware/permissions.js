/**
 * RBAC Permission & Feature Flag middleware.
 *
 * Provides three Express middleware functions:
 *   resolveWorkspaceWithRole  — sets req.workspace + req.workspaceRole
 *   requirePermission(r, a)   — checks Permission model (needs req.workspaceRole)
 *   requireFeature(key)       — checks FeatureFlag model (works with or without workspace)
 *
 * All DB lookups are cached in-memory with a 5-minute TTL.
 */

const Workspace = require('../models/Workspace');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
const Permission = require('../models/Permission');
const FeatureFlag = require('../models/FeatureFlag');
const Subscription = require('../models/Subscription');

// ─── In-memory cache (5-minute TTL) ─────────────────────────────

const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map();

function _getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _setCache(key, value) {
  _cache.set(key, { value, ts: Date.now() });
}

function clearPermissionCache() {
  _cache.clear();
}

// ─── Plan tier helpers ──────────────────────────────────────────

const PLAN_LEVELS = {
  free: 0,
  standard: 1,
  pro: 2,            // Legacy alias for professional
  professional: 2,
  agency: 3,
  enterprise: 3,     // Legacy alias for agency
};

function _getPlanTier(planId) {
  if (!planId) return null;
  return planId.split('-')[0]; // 'pro-monthly' → 'pro'
}

function _meetsMinimumPlan(userPlanId, minimumPlan) {
  if (!minimumPlan) return true;
  const userTier = _getPlanTier(userPlanId);
  const userLevel = PLAN_LEVELS[userTier] || 0;
  const requiredLevel = PLAN_LEVELS[minimumPlan] || 0;
  return userLevel >= requiredLevel;
}

// ─── resolveWorkspaceWithRole ───────────────────────────────────
//
// Replaces the inline resolveWorkspace() from contentController.js.
//
// 1. Finds workspace by req.params.workspaceNumber
// 2. Org workspace: org owner → 'owner';
//    OrgMember accessScope 'all'      → org-wide role;
//    OrgMember accessScope 'assigned' → WorkspaceMember role for THIS
//    workspace, or 403 (no fall-through to legacy paths — an assigned
//    member's access is exactly their grants, nothing more)
// 3. Personal workspace (no org): creator → 'owner'
// 4. Fallback: OrgMember.findMembership(workspace.userId, req.user.userId)
// 5. Legacy fallback: Workspace.members[] array → 'editor'
// 6. Sets req.workspace + req.workspaceRole, or 403
//

// resolveWorkspaceRole(workspace, userId) — the role-resolution CORE of
// resolveWorkspaceWithRole, given an ALREADY-FETCHED workspace document.
// Returns the role string ('owner' | org/ws role | 'editor') or null when the
// user has no access. Extracted (F1/B1) so routes NOT keyed by workspaceNumber
// — notably workspaceController.getMembers, keyed by workspace _id — can share
// the SAME modern OrgMember-based resolution instead of the legacy
// `members[] OR userId` re-query, which locked out every org-scoped teammate
// (modern membership lives in OrgMember, not the embedded members[] array).
async function resolveWorkspaceRole(workspace, userId) {
  // Org-based workspaces: org role takes priority over ws.userId (creator)
  // because ownership can be transferred, making the creator a non-owner.
  if (workspace.organizationId) {
    const org = await Organization.findById(workspace.organizationId).lean();
    if (org) {
      // Org owner = workspace owner
      if (org.ownerId.equals(userId)) {
        return 'owner';
      }
      const membership = await OrgMember.findMembershipByOrg(
        workspace.organizationId,
        userId
      );
      if (membership) {
        if (membership.accessScope === 'assigned') {
          // Scoped member: role comes from the per-workspace grant. No grant
          // for this workspace = no access — deliberately do NOT fall through
          // to the legacy paths below, which could silently widen a scoped
          // member's access.
          const wsMembership = await WorkspaceMember.findMembership(
            workspace._id,
            userId
          );
          return wsMembership ? wsMembership.role : null;
        }
        // accessScope 'all' (default): org-wide role, legacy behavior
        return membership.role;
      }
    }
  }

  // Personal workspace (no org): creator is always owner
  if (!workspace.organizationId && workspace.userId.equals(userId)) {
    return 'owner';
  }

  // Fallback: OrgMember by ownerId (pre-multi-org records, non-org workspaces only)
  if (!workspace.organizationId) {
    const membership = await OrgMember.findMembership(
      workspace.userId, // ownerId
      userId
    );
    if (membership) {
      return membership.role;
    }
  }

  // Legacy fallback: Workspace.members[] (pre-migration).
  // Safe to remove after running migrateWorkspaceMembers.js on all environments.
  const isLegacyMember = workspace.members?.some((m) => m.userId.equals(userId));
  if (isLegacyMember) {
    return 'editor';
  }

  return null;
}

const resolveWorkspaceWithRole = async (req, res, next) => {
  try {
    const { workspaceNumber } = req.params;
    if (!workspaceNumber) {
      return res.status(400).json({ error: 'Workspace number is required' });
    }

    const workspace = await Workspace.findOne({
      workspaceNumber: Number(workspaceNumber),
    });

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const role = await resolveWorkspaceRole(workspace, req.user.userId);
    if (role === null) {
      return res
        .status(403)
        .json({ error: 'You do not have access to this workspace' });
    }

    // B4: a locked workspace is inaccessible until it's restored. There are two
    // independent locks, BOTH of which the Workspace model documents as required-
    // clear for access. Checked AFTER role resolution (a non-member still gets a
    // generic "no access" and never learns the lock state) and EXEMPTING DELETE —
    // mirroring lockGuard's "delete a locked resource to free a slot" rule — so a
    // member can still erase/clean up a locked workspace; every other method blocks.
    if (req.method !== 'DELETE') {
      // Downgrade lock (downgradeService owns it): the org's tier dropped below
      // what this workspace needs. Cleared by upgrading the plan.
      if (workspace.locked) {
        return res.status(403).json({
          error: 'This workspace is locked. Upgrade your plan to regain access.',
          code: 'WORKSPACE_LOCKED',
          locked: true,
        });
      }
      // Client-billing lock (Phase 16): the agency-billed ClientSubscription went
      // past_due/canceled. Cleared automatically by the Connect webhook when the
      // client pays (reactivation never routes through here); the agency oversees
      // it via the org-keyed console, not by entering the workspace. Distinct code
      // so the FE can show a billing CTA rather than an upgrade CTA.
      if (workspace.clientLocked) {
        return res.status(403).json({
          error: 'This workspace is suspended pending payment. Contact your agency to restore access.',
          code: 'WORKSPACE_CLIENT_LOCKED',
          locked: true,
        });
      }
    }

    req.workspace = workspace;
    req.workspaceRole = role;
    return next();
  } catch (err) {
    console.error('[resolveWorkspaceWithRole]', err.message);
    return res.status(500).json({ error: 'Failed to resolve workspace' });
  }
};

// ─── requirePermission(resource, action) ────────────────────────
//
// Must come AFTER resolveWorkspaceWithRole (needs req.workspaceRole).
// Loads all permissions for the role (cached), checks resource:action.
//

function requirePermission(resource, action) {
  return async (req, res, next) => {
    try {
      const role = req.workspaceRole;
      if (!role) {
        return res.status(403).json({ error: 'No workspace role resolved' });
      }

      // Load all permissions for this role (cached by role name)
      const cacheKey = `perms:${role}`;
      let perms = _getCached(cacheKey);
      if (perms === undefined) {
        const docs = await Permission.find({ role }).lean();
        perms = {};
        for (const doc of docs) {
          perms[`${doc.resource}:${doc.action}`] = doc.allowed;
        }
        _setCache(cacheKey, perms);
      }

      if (perms[`${resource}:${action}`] === true) {
        return next();
      }

      return res.status(403).json({ error: 'Insufficient permissions' });
    } catch (err) {
      console.error('[requirePermission]', err.message);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ─── requireFeature(featureKey) ─────────────────────────────────
//
// Can be used with or without resolveWorkspaceWithRole.
//   With workspace context  → checks allowedRoles against req.workspaceRole
//   Without workspace context → skips allowedRoles check
//
// Checks: enabled → implemented → minimumPlan → allowedRoles
// Stores the flag on req.featureFlag for downstream use.
//

function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      // Load feature flag (cached by key)
      const cacheKey = `ff:${featureKey}`;
      let flag = _getCached(cacheKey);
      if (flag === undefined) {
        flag = await FeatureFlag.findOne({ key: featureKey }).lean();
        _setCache(cacheKey, flag);
      }

      if (!flag || !flag.enabled) {
        return res.status(404).json({ error: 'Feature not available' });
      }

      if (!flag.implemented) {
        return res.status(404).json({ error: 'Feature coming soon' });
      }

      const { conditions } = flag;

      // minimumPlan — check the org's subscription
      if (conditions?.minimumPlan) {
        let subscription;
        const orgId = req.workspace?.organizationId;
        if (orgId) {
          // Org workspace: look up subscription by organizationId
          const subCacheKey = `sub:org:${orgId}`;
          subscription = _getCached(subCacheKey);
          if (subscription === undefined) {
            subscription = await Subscription.findOne({
              organizationId: orgId,
              status: { $in: ['active', 'trialing'] },
            }).lean();
            _setCache(subCacheKey, subscription);
          }
        } else {
          // Non-org workspace: resolve owner's personal org, then look up by organizationId
          const ownerId = req.workspace ? req.workspace.userId : req.user.userId;
          const subCacheKey = `sub:personal:${ownerId}`;
          subscription = _getCached(subCacheKey);
          if (subscription === undefined) {
            const personalOrg = await Organization.findOne({ ownerId, isPersonal: true }).select('_id').lean();
            subscription = personalOrg
              ? await Subscription.findOne({
                  organizationId: personalOrg._id,
                  status: { $in: ['active', 'trialing'] },
                }).lean()
              : null;
            _setCache(subCacheKey, subscription);
          }
        }

        if (!_meetsMinimumPlan(subscription?.planId, conditions.minimumPlan)) {
          return res.status(403).json({
            error: 'Plan upgrade required',
            requiredPlan: conditions.minimumPlan,
          });
        }
      }

      // allowedRoles — check against workspace role or org ownership
      if (conditions?.allowedRoles?.length > 0) {
        if (req.workspaceRole) {
          // Workspace context exists — check workspace role
          if (!conditions.allowedRoles.includes(req.workspaceRole)) {
            return res
              .status(403)
              .json({ error: 'Feature not available for your role' });
          }
        } else {
          // No workspace context (e.g. billing routes).
          // If 'owner' is in allowedRoles, verify the user owns at least one org.
          if (conditions.allowedRoles.includes('owner')) {
            const ownsOrg = await Organization.exists({ ownerId: req.user.userId });
            if (!ownsOrg) {
              return res
                .status(403)
                .json({ error: 'Feature not available for your role' });
            }
          } else {
            // Non-owner role required but no workspace context — deny
            return res
              .status(403)
              .json({ error: 'Feature not available for your role' });
          }
        }
      }

      // Attach flag to req for downstream use (e.g., custom conditions)
      req.featureFlag = flag;

      return next();
    } catch (err) {
      console.error('[requireFeature]', err.message);
      return res.status(500).json({ error: 'Feature check failed' });
    }
  };
}

module.exports = {
  resolveWorkspaceWithRole,
  resolveWorkspaceRole,
  requirePermission,
  requireFeature,
  clearPermissionCache,
};
