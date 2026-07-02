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

    // Org-based workspaces: org role takes priority over ws.userId (creator)
    // because ownership can be transferred, making the creator a non-owner.
    if (workspace.organizationId) {
      const org = await Organization.findById(workspace.organizationId).lean();
      if (org) {
        // Org owner = workspace owner
        if (org.ownerId.equals(req.user.userId)) {
          req.workspace = workspace;
          req.workspaceRole = 'owner';
          return next();
        }
        const membership = await OrgMember.findMembershipByOrg(
          workspace.organizationId,
          req.user.userId
        );
        if (membership) {
          if (membership.accessScope === 'assigned') {
            // Scoped member: role comes from the per-workspace grant.
            // No grant for this workspace = no access — deliberately do
            // NOT fall through to the legacy paths below, which could
            // silently widen a scoped member's access.
            const wsMembership = await WorkspaceMember.findMembership(
              workspace._id,
              req.user.userId
            );
            if (wsMembership) {
              req.workspace = workspace;
              req.workspaceRole = wsMembership.role;
              return next();
            }
            return res
              .status(403)
              .json({ error: 'You do not have access to this workspace' });
          }
          // accessScope 'all' (default): org-wide role, legacy behavior
          req.workspace = workspace;
          req.workspaceRole = membership.role;
          return next();
        }
      }
    }

    // Personal workspace (no org): creator is always owner
    if (!workspace.organizationId && workspace.userId.equals(req.user.userId)) {
      req.workspace = workspace;
      req.workspaceRole = 'owner';
      return next();
    }

    // Fallback: OrgMember by ownerId (pre-multi-org records, non-org workspaces only)
    if (!workspace.organizationId) {
      const membership = await OrgMember.findMembership(
        workspace.userId, // ownerId
        req.user.userId // userId
      );

      if (membership) {
        req.workspace = workspace;
        req.workspaceRole = membership.role;
        return next();
      }
    }

    // Legacy fallback: Workspace.members[] (pre-migration).
    // Safe to remove after running migrateWorkspaceMembers.js on all environments.
    const isLegacyMember = workspace.members?.some((m) =>
      m.userId.equals(req.user.userId)
    );
    if (isLegacyMember) {
      req.workspace = workspace;
      req.workspaceRole = 'editor';
      return next();
    }

    return res
      .status(403)
      .json({ error: 'You do not have access to this workspace' });
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
  requirePermission,
  requireFeature,
  clearPermissionCache,
};
