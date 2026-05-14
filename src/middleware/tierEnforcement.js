/**
 * Tier-enforcement middleware (Layer 3).
 *
 * Runs AFTER resolveWorkspaceWithRole (needs req.workspace).
 * Checks organisation usage against TierConfig limits.
 *
 *   requireQuota(counterKey, tierLimitKey, tierLimitTypeKey)
 *
 * On success: sets req.tierQuota so the controller can call
 *   UsageTracker.increment(req.tierQuota.orgId, counterKey, period)
 * after the operation succeeds.
 *
 * On failure: responds 429 with QUOTA_EXCEEDED code + quota details.
 */

const Organization = require('../models/Organization');
const UsageTracker = require('../models/UsageTracker');
const tierService = require('../services/tierService');

// ─── Resolve org from workspace (handles legacy null organizationId) ─

async function _resolveOrgId(workspace) {
  if (workspace.organizationId) return workspace.organizationId;

  // Legacy workspace without explicit org — look up the personal org
  const org = await Organization.findOne({ ownerId: workspace.userId, isPersonal: true })
    .select('_id')
    .lean();
  return org?._id || null;
}

// ─── requireQuota ─────────────────────────────────────────────────

/**
 * Factory: returns an Express middleware that checks a monthly/lifetime quota.
 *
 * @param {string} counterKey      UsageTracker field, e.g. 'articlesCreated'
 * @param {string} tierLimitKey    TierConfig field for the limit, e.g. 'maxArticlesPerMonth'
 * @param {string} tierLimitTypeKey TierConfig field for the limit type, e.g. 'articleLimitType'
 */
function requireQuota(counterKey, tierLimitKey, tierLimitTypeKey) {
  return async (req, res, next) => {
    try {
      if (!req.workspace) {
        // No workspace context — skip quota check (shouldn't happen in normal flow)
        return next();
      }

      const orgId = await _resolveOrgId(req.workspace);
      if (!orgId) {
        // Cannot resolve org — skip quota (graceful degradation)
        return next();
      }

      const { tier, config } = await tierService.getOrgTierConfig(orgId);
      if (!config) {
        // No TierConfig in DB for this tier — allow (fail open)
        return next();
      }

      const limit = config[tierLimitKey];
      // null/undefined = unlimited
      if (limit == null) {
        req.tierQuota = { orgId, counterKey, period: null };
        return next();
      }

      const limitType = config[tierLimitTypeKey] || 'monthly';

      // Lifetime limits use UsageTracker with period='lifetime' — the counter
      // increments on creation and never decrements on deletion, so deleting
      // a resource does NOT free a creation slot. On tier change (downgrade),
      // downgradeService resets the lifetime counter to match unlocked counts.
      const period = tierService.getPeriod(limitType);
      const used = await UsageTracker.getCount(orgId, counterKey, period);

      if (used >= limit) {
        return res.status(429).json({
          error: `${config.displayName || tier} plan limit reached for this feature`,
          code: 'QUOTA_EXCEEDED',
          quota: {
            limit,
            used,
            tier,
            limitKey: tierLimitKey,
            limitType,
            upgradeHint: tierService._upgradeHint(tier, tierLimitKey),
          },
        });
      }

      // Attach context so controller can increment after success
      req.tierQuota = { orgId, counterKey, period, limit, used };
      return next();
    } catch (err) {
      console.error('[requireQuota]', err.message);
      // Fail open — don't block the request on quota-check errors
      return next();
    }
  };
}

module.exports = { requireQuota };
