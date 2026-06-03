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

// ─── Resolve org from workspace (same as tierEnforcement.js) ──

async function _resolveOrgId(workspace) {
  if (workspace.organizationId) return workspace.organizationId;

  const org = await Organization.findOne({ ownerId: workspace.userId, isPersonal: true })
    .select('_id')
    .lean();
  return org?._id || null;
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
      const estimated = typeof estimateCredits === 'function'
        ? await Promise.resolve(estimateCredits(req))
        : estimateCredits;

      // Check if org + user can afford it
      const balance = await creditService.getBalance(orgId, req.user?.userId);

      if (balance.total < estimated) {
        return res.status(402).json({
          error: `Insufficient credits. You have ${balance.total} but need ${estimated}.`,
          code: 'INSUFFICIENT_CREDITS',
          balance: balance.total,
          required: estimated,
          tier,
          upgradeHint: tier !== 'agency' ? 'Upgrade your plan for more credits.' : null,
        });
      }

      // Pass context to controller for actual deduction
      req.creditContext = {
        orgId,
        userId: req.user?.userId,
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
