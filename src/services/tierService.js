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

const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const TierConfig = require('../models/TierConfig');

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
 * org → org.ownerId → Subscription → planId → tier name
 * No subscription → 'free'
 */
async function getOrgTier(orgId) {
  const cacheKey = `tier:${orgId}`;
  let cached = _get(cacheKey);
  if (cached !== undefined) return cached;

  const org = await Organization.findById(orgId).select('ownerId').lean();
  if (!org) {
    _set(cacheKey, 'free');
    return 'free';
  }

  const sub = await Subscription.findOne({
    userId: org.ownerId,
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

module.exports = {
  getOrgTier,
  getTierConfig,
  getOrgTierConfig,
  getPeriod,
  clearTierCache,
  _upgradeHint,
  TIER_ORDER,
};
