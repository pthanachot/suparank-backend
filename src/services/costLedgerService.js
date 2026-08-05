/**
 * costLedgerService — the one entry point for recording an LLM call's cost.
 *
 * Every LLM call site calls record() with the tokens it observed; this service
 * prices the call via modelRegistry and writes one AiCostLedger row. It is
 * deliberately fire-and-forget and NEVER throws into the caller's hot path —
 * a logging failure must not break content generation, tracking, or audits.
 *
 * Usage:
 *   const costLedger = require('../services/costLedgerService');
 *   costLedger.record({
 *     action: 'tracker_scan',
 *     model: 'gpt-4o-mini',
 *     tokensIn, tokensOut,
 *     organizationId, workspaceId, userId, tier,
 *     metadata: { trackerId, engine: 'chatgpt' },
 *   });
 *
 * record() returns a Promise you may await in tests (to assert a row was
 * written), but production callers should NOT await it — let it run detached.
 */

const AiCostLedger = require('../models/AiCostLedger');
const { costFor } = require('../config/modelRegistry');

/**
 * Price and persist one LLM call.
 *
 * @param {Object} p
 * @param {string} p.action                logical activity (see AiCostLedger.action)
 * @param {string} p.model                 model id passed to the provider
 * @param {number} [p.tokensIn=0]
 * @param {number} [p.tokensOut=0]
 * @param {number} [p.images]              for per-image models, image count
 * @param {string|ObjectId} [p.organizationId]
 * @param {string|ObjectId} [p.workspaceId]
 * @param {string|ObjectId} [p.userId]
 * @param {string} [p.tier]
 * @param {boolean} [p.byok=false]         caller used their own key → costUsd forced to 0
 * @param {number} [p.costUsdOverride]      pre-computed USD cost (e.g. the Go engine's
 *                                          pipeline_cost) — used verbatim, skips token pricing
 * @param {Object} [p.metadata]
 * @returns {Promise<import('mongoose').Document|null>} the row, or null on failure
 */
async function record(p) {
  try {
    if (!p || !p.action || !p.model) {
      console.warn('[costLedger] skipped: missing action/model', {
        action: p?.action,
        model: p?.model,
      });
      return null;
    }

    const tokensIn = Math.max(0, Math.round(p.tokensIn || 0));
    const tokensOut = Math.max(0, Math.round(p.tokensOut || 0));

    const priced = costFor(p.model, tokensIn, tokensOut, { images: p.images });
    const hasOverride = typeof p.costUsdOverride === 'number' && isFinite(p.costUsdOverride);
    if (!priced.known && !hasOverride) {
      // Unknown model and no pre-computed cost — still record the call (tokens
      // + context) so it shows on the margin dashboard as un-priced and can be
      // back-filled.
      console.warn(`[costLedger] unknown model "${p.model}" (action=${p.action}) — recorded with costUsd=0`);
    }

    // BYOK: the customer's key paid for it, so our COGS is 0. Tokens are still
    // recorded for volume analytics. Otherwise prefer an explicit override
    // (a service that already priced the call) over registry token pricing.
    const byok = !!p.byok;
    const costUsd = byok ? 0 : hasOverride ? Math.max(0, p.costUsdOverride) : priced.costUsd;

    return await AiCostLedger.create({
      organizationId: p.organizationId || null,
      workspaceId: p.workspaceId || null,
      userId: p.userId || null,
      action: p.action,
      model: priced.resolved || p.model,
      provider: priced.provider || '',
      tokensIn,
      tokensOut,
      // Clamped like the token counts: this is multiplied into per-org totals
      // an operator acts on, and it originates (via the agent path) in an SSE
      // payload. Non-finite or negative would corrupt every sum over the window.
      images: Number.isFinite(Number(p.images)) ? Math.max(0, Math.round(Number(p.images))) : 0,
      costUsd,
      unknownModel: !priced.known && !hasOverride,
      tier: p.tier || '',
      byok,
      metadata: p.metadata || {},
    });
  } catch (err) {
    // Never propagate — cost logging must not break the request.
    console.error('[costLedger] record failed:', err.message);
    return null;
  }
}

/**
 * Like record(), but resolves organizationId and tier from p.workspaceId when
 * they're not supplied — for call sites (background jobs, fire-and-forget
 * generations) that only have a workspace in hand. Same best-effort contract.
 */
async function recordForWorkspace(p) {
  try {
    let { organizationId, tier } = p;
    if (!organizationId && p.workspaceId) {
      // Lazy requires: keeps module load order independent of model registration.
      const Workspace = require('../models/Workspace');
      const ws = await Workspace.findById(p.workspaceId).select('organizationId').lean();
      organizationId = ws?.organizationId || null;
    }
    if (!tier && organizationId) {
      const tierService = require('./tierService');
      tier = (await tierService.getOrgTierConfig(organizationId))?.tier || '';
    }
    return await record({ ...p, organizationId, tier });
  } catch (err) {
    console.error('[costLedger] recordForWorkspace failed:', err.message);
    return null;
  }
}

/**
 * Convenience pass-through to the aggregation static, for dashboards/tests.
 */
function cogsBy(groupBy, opts) {
  return AiCostLedger.cogsBy(groupBy, opts);
}

module.exports = { record, recordForWorkspace, cogsBy };
