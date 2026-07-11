/**
 * Tier resolution & quota-checking service.
 *
 * Central place to answer:
 *   "What tier is this org on?"  →  getOrgTier(orgId)
 *   "What limits apply?"         →  getTierConfig(tier)
 *   "Is quota exhausted?"        →  checkQuota(...)
 *
 * Uses a 5-minute in-memory cache (same strategy as permissions.js).
 */

const Subscription = require('../models/Subscription');
const TierConfig = require('../models/TierConfig');
const UsageTracker = require('../models/UsageTracker');
const UserUsageTracker = require('../models/UserUsageTracker');
const WorkspaceUsageTracker = require('../models/WorkspaceUsageTracker');

// ─── Cache (5 min TTL, shared with this module only) ────────────

const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map();

function _get(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _set(key, value) {
  _cache.set(key, { value, ts: Date.now() });
}

function clearTierCache() {
  _cache.clear();
}

// ─── Tier resolution ────────────────────────────────────────────

/**
 * Resolve the tier name for an organisation.
 *
 * org → Subscription (by organizationId) → planId → tier name
 * No subscription → 'free'
 */
async function getOrgTier(orgId) {
  const cacheKey = `tier:${orgId}`;
  let cached = _get(cacheKey);
  if (cached !== undefined) return cached;

  const sub = await Subscription.findOne({
    organizationId: orgId,
    status: { $in: ['active', 'trialing'] },
  })
    .select('planId')
    .lean();

  const tier = sub?.planId ? sub.planId.split('-')[0] : 'free';
  // Normalise legacy alias
  const normalised = tier === 'pro' ? 'professional' : tier;

  _set(cacheKey, normalised);
  return normalised;
}

/**
 * Fetch TierConfig document for a given tier name (cached).
 */
async function getTierConfig(tier) {
  const cacheKey = `tc:${tier}`;
  let cached = _get(cacheKey);
  if (cached !== undefined) return cached;

  const config = await TierConfig.findOne({ tier }).lean();
  _set(cacheKey, config);
  return config;
}

/**
 * Convenience: resolve org → tier → config in one call.
 * @returns {{ tier: string, config: object|null }}
 */
async function getOrgTierConfig(orgId) {
  const tier = await getOrgTier(orgId);
  const config = await getTierConfig(tier);
  return { tier, config };
}

// ─── Quota helpers ──────────────────────────────────────────────

const TIER_ORDER = ['free', 'standard', 'professional', 'agency'];

/**
 * Build a short upgrade hint, e.g. "Upgrade to Professional for 50 articles/month".
 */
function _upgradeHint(currentTier, limitKey) {
  const idx = TIER_ORDER.indexOf(currentTier);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return `Upgrade to ${TIER_ORDER[idx + 1]} for higher limits`;
}

/**
 * Determine the usage period string for a given limit type.
 *   'lifetime' → 'lifetime'
 *   'monthly'  → 'YYYY-MM' (current calendar month)
 */
function getPeriod(limitType) {
  if (limitType === 'lifetime') return 'lifetime';
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Increment the correct usage tracker based on tierQuota context.
 *
 * Lifetime quotas → UserUsageTracker (user-level)
 * Monthly quotas  → UsageTracker (org-level)
 *
 * @param {object} tierQuota - from req.tierQuota (set by requireQuota middleware)
 */
async function incrementQuota(tierQuota) {
  if (!tierQuota?.counterKey) return;
  if (tierQuota.isUserLevel && tierQuota.userId) {
    await UserUsageTracker.increment(tierQuota.userId, tierQuota.counterKey);
  } else if (tierQuota.orgId && tierQuota.period) {
    await UsageTracker.increment(tierQuota.orgId, tierQuota.counterKey, tierQuota.period);
  }
  // Phase 17 (dark): also count against the client-billed workspace's OWN
  // ceiling. workspaceId/workspacePeriod are set by requireQuota only when
  // saasMode is live AND the workspace has an active ClientSubscription — absent
  // otherwise, making this a no-op on the live (non-SaaS) path.
  if (tierQuota.workspaceId && tierQuota.workspacePeriod) {
    await WorkspaceUsageTracker.increment(
      tierQuota.workspaceId,
      tierQuota.counterKey,
      tierQuota.workspacePeriod
    );
  }
}

module.exports = {
  getOrgTier,
  getTierConfig,
  getOrgTierConfig,
  getPeriod,
  incrementQuota,
  clearTierCache,
  _upgradeHint,
  TIER_ORDER,
};
