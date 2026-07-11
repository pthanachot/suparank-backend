/**
 * Margin report (Phase 14 sign-off telemetry).
 *
 * Realized gross margin per paid tier = (subscription revenue − AI provider COGS)
 * / revenue, where COGS is the real per-call cost logged to AiCostLedger. The
 * v4.1 pricing targets (GEO-PRICING-v4.md §"Margin check"): Standard ~74%,
 * Professional ~63%, Agency ~58%. This module is the PURE computation; the
 * runnable `scripts/marginReport.js` feeds it real ledger + subscription data.
 *
 * Free is intentionally excluded — it is a cost-controlled loss-leader (budget
 * model + zero-credit bundles), not a margin target.
 */

const MARGIN_TARGETS = Object.freeze({ standard: 0.74, professional: 0.63, agency: 0.58 });

// A few points of slack: the targets are "~" figures and real months vary. Below
// (target − tolerance) is flagged as a genuine margin miss worth investigating.
const MARGIN_TOLERANCE = 0.03;

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} input
 * @param {Object<string,number>} input.revenueByTier  USD subscription revenue per tier
 * @param {Object<string,number>} input.cogsByTier     USD AI provider COGS per tier
 * @returns {Object<string,{revenue,cogs,marginPct,target,belowTarget}>}
 *   marginPct is null when revenue is 0 (nothing to measure).
 */
function computeTierMargins({ revenueByTier = {}, cogsByTier = {} } = {}) {
  const out = {};
  for (const t of Object.keys(MARGIN_TARGETS)) {
    const revenue = num(revenueByTier[t]);
    const cogs = num(cogsByTier[t]);
    const marginPct = revenue > 0 ? (revenue - cogs) / revenue : null;
    const target = MARGIN_TARGETS[t];
    out[t] = {
      revenue,
      cogs,
      marginPct,
      target,
      belowTarget: marginPct == null ? null : marginPct < target - MARGIN_TOLERANCE,
    };
  }
  return out;
}

/**
 * Map a Stripe planId (e.g. 'pro-monthly', 'professional-yearly', 'standard-monthly')
 * to a margin tier key. 'pro' and 'professional' both → 'professional'.
 * @returns {'standard'|'professional'|'agency'|null}
 */
function planIdToTier(planId) {
  if (!planId || typeof planId !== 'string') return null;
  const prefix = planId.split('-')[0];
  if (prefix === 'pro' || prefix === 'professional') return 'professional';
  if (prefix === 'standard') return 'standard';
  if (prefix === 'agency') return 'agency';
  return null;
}

module.exports = { computeTierMargins, planIdToTier, MARGIN_TARGETS, MARGIN_TOLERANCE };
