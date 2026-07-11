/**
 * Tail-risk telemetry (Phase 14). The negative-margin tail is heavy content
 * consumers: Agency's article cap is 300/mo (~$36 content COGS at ~$0.12/article),
 * so an org running well past ~200 articles in a month is where a plan's margin
 * goes negative. This surfaces that cohort for the admin dashboard so it's
 * watchable (per Table 3's usage-analytics row).
 *
 * Backed by the monthly UsageTracker.articlesCreated counter (org-scoped,
 * period = 'YYYY-MM').
 */

const UsageTracker = require('../models/UsageTracker');

// >200 articles/mo = the tail-risk threshold (conservative vs Agency's 300 cap,
// so a heavy account is flagged before it maxes out).
const ARTICLE_TAIL_RISK_THRESHOLD = 200;

/** Current usage period key in the UsageTracker 'YYYY-MM' format (UTC). */
function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Count organizations whose article usage in `period` exceeds `threshold`.
 * @param {object} [opts]
 * @param {string} [opts.period]     defaults to the current month
 * @param {number} [opts.threshold]  defaults to ARTICLE_TAIL_RISK_THRESHOLD
 * @returns {Promise<number>}
 */
async function countHighVolumeOrgs({ period = currentPeriod(), threshold = ARTICLE_TAIL_RISK_THRESHOLD } = {}) {
  return UsageTracker.countDocuments({ period, articlesCreated: { $gt: threshold } });
}

module.exports = { countHighVolumeOrgs, currentPeriod, ARTICLE_TAIL_RISK_THRESHOLD };
