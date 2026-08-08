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
const UserUsageTracker = require('../models/UserUsageTracker');
const WorkspaceUsageTracker = require('../models/WorkspaceUsageTracker');
const tierService = require('../services/tierService');
const { resolveWorkspacePlanLimits } = require('../services/workspaceQuotaService');

// ─── Resolve org from workspace (handles legacy null organizationId) ─

async function _resolveOrgId(workspace) {
  if (workspace.organizationId) return workspace.organizationId;

  // Legacy workspace without explicit org — look up the personal org
  const org = await Organization.findOne({ ownerId: workspace.userId, isPersonal: true })
    .select('_id')
    .lean();
  return org?._id || null;
}

// ─── Deny telemetry (Wave 1, §4b quota_denied) ────────────────────
// Denials were HTTP responses recorded NOWHERE, yet the free→paid "first
// wall" analysis (which cap converts a signup) depends entirely on them.
// Fire-and-forget via the server-lane observation sink; flows into the
// durable daily rollup. Must never affect the response.
function denyTelemetry(req, { action, tier, quotaSource, limitKey, limitType, scope, orgId }) {
  try {
    const { recordObservation } = require('../controllers/observeController');
    recordObservation('quota_denied', {
      action,
      gate: '429_quota',
      // W5: ALWAYS the org's real tier — a paid user denied on a free lifetime
      // slot (quotaSource='free') must not poison the Free facet of the
      // blocked-actions panel. quotaSource carries the slot distinction.
      tier: tier || '',
      ...(quotaSource === 'free' ? { quotaSource: 'free' } : {}),
      limitKey: limitKey || '',
      limitType: limitType || '',
      scope: scope || 'org',
      workspaceNumber: req.workspace?.workspaceNumber,
      // W2: the RESOLVED org (personal-org fallback included) — reading
      // req.workspace.organizationId dropped attribution for exactly the
      // legacy/personal-workspace cohort the first-wall analysis is about.
      orgId: orgId || req.workspace?.organizationId || null,
    }, req.user?.userId, req.user?.impersonatedBy); // W7
  } catch { /* telemetry must never break a deny response */ }
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

      // ── Quota source override ──
      // Paid users can opt to use a free lifetime slot instead of their
      // paid monthly quota. When quotaSource='free', we check against the
      // free tier's limits and lifetime counter instead.
      const quotaSource = req.body?.quotaSource;
      let activeConfig = config;
      let activeTier = tier;

      if (quotaSource === 'free' && tier !== 'free') {
        const freeConfig = await tierService.getTierConfig('free');
        if (!freeConfig) return next(); // fail open
        activeConfig = freeConfig;
        activeTier = 'free';
      }

      // ── Phase 17 (DARK): per-workspace ceiling from the client's AgencyPlan.
      // Independent of and ADDITIONAL to the org ceiling below. resolveWorkspacePlanLimits
      // returns null unless saasMode is live AND this workspace has an active
      // ClientSubscription, so with the flag dark this whole block is inert and
      // everything below is byte-identical to pre-P17. Enforced even when the ORG
      // limit is unlimited (agency tier) — a client's plan can be stricter.
      let wsQuota = {};
      const wsLimits = await resolveWorkspacePlanLimits(req.workspace._id);
      if (wsLimits) {
        const wsPeriod = tierService.getPeriod('monthly'); // AgencyPlan limits are monthly
        const wsLimit = wsLimits[tierLimitKey];
        if (wsLimit != null) {
          const wsUsed = await WorkspaceUsageTracker.getCount(req.workspace._id, counterKey, wsPeriod);
          if (wsUsed >= wsLimit) {
            denyTelemetry(req, { action: counterKey, tier, quotaSource, limitKey: tierLimitKey, scope: 'workspace', orgId });
            return res.status(429).json({
              error: 'Client plan limit reached for this workspace',
              code: 'QUOTA_EXCEEDED',
              quota: { limit: wsLimit, used: wsUsed, scope: 'workspace', limitKey: tierLimitKey, limitType: 'monthly' },
            });
          }
        }
        // Count this workspace's usage after success (also when the plan's limit
        // for THIS counter is unlimited — keeps the per-workspace counter honest).
        wsQuota = { workspaceId: req.workspace._id, workspacePeriod: wsPeriod };
      }

      const limit = activeConfig[tierLimitKey];
      // null/undefined = unlimited
      if (limit == null) {
        req.tierQuota = { orgId, userId: req.user?.userId, counterKey, period: null, isUserLevel: false, ...wsQuota };
        return next();
      }

      const limitType = activeConfig[tierLimitTypeKey] || 'monthly';

      // Lifetime limits use UsageTracker with period='lifetime' — the counter
      // increments on creation and never decrements on deletion, so deleting
      // a resource does NOT free a creation slot. On tier change (downgrade),
      // downgradeService resets the lifetime counter to match unlocked counts.
      const isUserLevel = limitType === 'lifetime' && req.user?.userId;
      const period = tierService.getPeriod(limitType);
      const used = isUserLevel
        ? await UserUsageTracker.getCount(req.user.userId, counterKey)
        : await UsageTracker.getCount(orgId, counterKey, period);

      if (used >= limit) {
        denyTelemetry(req, { action: counterKey, tier, quotaSource, limitKey: tierLimitKey, limitType, orgId });
        return res.status(429).json({
          error: quotaSource === 'free'
            ? 'No free lifetime slots remaining for this feature'
            : `${activeConfig.displayName || activeTier} plan limit reached for this feature`,
          code: 'QUOTA_EXCEEDED',
          quota: {
            limit,
            used,
            tier: activeTier,
            limitKey: tierLimitKey,
            limitType,
            upgradeHint: tierService._upgradeHint(tier, tierLimitKey),
          },
        });
      }

      // Attach context so controller can increment after success
      req.tierQuota = { orgId, userId: req.user?.userId, counterKey, period, limit, used, isUserLevel: !!isUserLevel, ...wsQuota };
      return next();
    } catch (err) {
      console.error('[requireQuota]', err.message);
      // Fail open — don't block the request on quota-check errors
      return next();
    }
  };
}

module.exports = { requireQuota };
