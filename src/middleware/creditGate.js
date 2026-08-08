/**
 * Credit gate middleware — pre-flight balance check before AI operations.
 *
 * Similar pattern to tierEnforcement.js requireQuota, but for credit balance.
 *
 *   requireCredits(featureKey, estimateCredits)
 *
 * On success: sets req.creditContext so the controller can call
 *   creditService.preDeduct() when the operation starts.
 *
 * On failure: responds 402 with INSUFFICIENT_CREDITS code.
 * If credit deduction is disabled for this feature: passes through with
 *   req.creditContext.deductionEnabled = false.
 */

const Organization = require('../models/Organization');
const creditService = require('../services/creditService');
const tierService = require('../services/tierService');
const workspaceQuotaService = require('../services/workspaceQuotaService');
const WorkspaceUsageTracker = require('../models/WorkspaceUsageTracker');

// ─── Resolve org from workspace (same as tierEnforcement.js) ──

async function _resolveOrgId(workspace) {
  if (workspace.organizationId) return workspace.organizationId;

  const org = await Organization.findOne({ ownerId: workspace.userId, isPersonal: true })
    .select('_id')
    .lean();
  return org?._id || null;
}

// ─── Deny telemetry (Wave 1, §4b quota_denied) ───────────────
// Same contract as tierEnforcement.denyTelemetry: denials previously left
// zero server-side trace; the 402 lane is the credit half of the free→paid
// first-wall analysis. Fire-and-forget, never affects the response.
function denyTelemetry(req, { featureKey, tier, scope, orgId }) {
  try {
    const { recordObservation } = require('../controllers/observeController');
    recordObservation('quota_denied', {
      action: featureKey,
      gate: '402_credits',
      tier: tier || '',
      scope: scope || 'org',
      workspaceNumber: req.workspace?.workspaceNumber,
      // W2: the RESOLVED org (personal-org fallback included).
      orgId: orgId || req.workspace?.organizationId || null,
    }, req.user?.userId, req.user?.impersonatedBy); // W7
  } catch { /* telemetry must never break a deny response */ }
}

// ─── requireCredits ──────────────────────────────────────────

/**
 * Factory: returns Express middleware that gates on credit balance.
 *
 * @param {string} featureKey - matches creditDeductionFlags keys (e.g. 'aiChat')
 * @param {number|function} estimateCredits - fixed number or (req) => number
 */
function requireCredits(featureKey, estimateCredits) {
  return async (req, res, next) => {
    try {
      if (!req.workspace) {
        // No workspace context — skip (shouldn't happen in normal flow)
        req.creditContext = { deductionEnabled: false };
        return next();
      }

      const orgId = await _resolveOrgId(req.workspace);
      if (!orgId) {
        req.creditContext = { deductionEnabled: false };
        return next();
      }

      const { tier, config } = await tierService.getOrgTierConfig(orgId);
      if (!config) {
        req.creditContext = { deductionEnabled: false };
        return next();
      }

      // Check if credit deduction is enabled for this feature
      if (!creditService.isFeatureEnabled(config, featureKey)) {
        req.creditContext = { deductionEnabled: false };
        return next();
      }

      // Calculate estimated credit cost. Supports async functions so callers
      // can look up live data (e.g., AI Tracker counts prompts × platforms
      // from Mongo) instead of being stuck on a literal pre-flight estimate.
      // The resolved { tier, config } is passed as the 2nd arg so estimators
      // can apply Option B (Free fixed-bundle → 0) via creditRules.resolveCredits.
      const estimated = typeof estimateCredits === 'function'
        ? await Promise.resolve(estimateCredits(req, { tier, config }))
        : estimateCredits;

      // Phase 17 (DARK): resolve client-billing FIRST — it changes which pools
      // fund the work. Inert (null) unless saasMode is live AND this workspace is
      // client-billed.
      const wsLimits = await workspaceQuotaService.resolveWorkspacePlanLimits(req.workspace._id);
      const wsBilled = wsLimits != null;

      // Check if the funding pools can afford it. A client-billed workspace is
      // funded from the agency ORG pool ONLY (subscription + general) — never the
      // triggering member's personal free credits — mirroring preDeduct's B1
      // exclusion. Using balance.total here (which includes user_free) would let
      // this pre-flight gate pass on credits preDeduct then refuses to spend,
      // starting an expensive generation that fails (or silently no-ops) mid-way.
      const balance = await creditService.getBalance(orgId, req.user?.userId);
      const affordable = wsBilled ? balance.subscription + balance.general : balance.total;

      if (affordable < estimated) {
        denyTelemetry(req, { featureKey, tier, orgId });
        return res.status(402).json({
          error: `Insufficient credits. You have ${affordable} but need ${estimated}.`,
          code: 'INSUFFICIENT_CREDITS',
          balance: affordable,
          required: estimated,
          tier,
          upgradeHint: tier !== 'agency' ? 'Upgrade your plan for more credits.' : null,
        });
      }

      // Client-billed workspaces are ALSO hard-capped at their plan's monthly
      // credit allocation. Early 402 so an expensive generation never starts
      // against a cap the workspace can't cover (preDeduct enforces it
      // authoritatively inside the transaction too).
      if (wsLimits?.creditsPerMonth != null) {
        const wsPeriod = tierService.getPeriod('monthly');
        const wsUsed = await WorkspaceUsageTracker.getCount(req.workspace._id, 'creditsUsed', wsPeriod);
        if (wsUsed + estimated > wsLimits.creditsPerMonth) {
          denyTelemetry(req, { featureKey, tier, scope: 'workspace', orgId });
          return res.status(402).json({
            error: `Client plan monthly credit limit reached (${wsUsed}/${wsLimits.creditsPerMonth}).`,
            code: 'INSUFFICIENT_CREDITS',
            scope: 'workspace',
            balance: Math.max(0, wsLimits.creditsPerMonth - wsUsed),
            required: estimated,
          });
        }
      }

      // Pass context to controller for actual deduction
      req.creditContext = {
        orgId,
        userId: req.user?.userId,
        workspaceId: req.workspace._id,
        estimatedCredits: estimated,
        featureKey,
        deductionEnabled: true,
        config,
        tier,
      };

      return next();
    } catch (err) {
      console.error('[creditGate]', err.message);
      // Fail open — don't block the request on credit-check errors
      req.creditContext = { deductionEnabled: false };
      return next();
    }
  };
}

module.exports = { requireCredits };
