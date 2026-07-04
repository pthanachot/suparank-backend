/**
 * Shared launch-flag reads for dark-shipped features.
 *
 * `isFlagLive(key)` = FeatureFlag.enabled && FeatureFlag.implemented,
 * cached 5 min, FAIL-CLOSED (missing flag, lookup error → false).
 *
 * This is deliberately narrower than middleware/permissions.requireFeature
 * (which also enforces minimumPlan/allowedRoles per request): flag-live is
 * a deploy-level switch consulted from services (host resolution, email
 * identity) where there is no req context. Route-level gating should keep
 * using requireFeature; both read the same FeatureFlag documents.
 */

const FeatureFlag = require('../models/FeatureFlag');

const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map(); // key → { value, ts }

async function isFlagLive(key) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts <= CACHE_TTL) return entry.value;

  let live = false;
  try {
    const flag = await FeatureFlag.findOne({ key }).select('enabled implemented').lean();
    live = Boolean(flag?.enabled && flag?.implemented);
  } catch (err) {
    console.error(`[flags] lookup failed for ${key}:`, err.message);
  }
  _cache.set(key, { value: live, ts: Date.now() });
  return live;
}

/** Test hook / cache bust after admin flag edits. */
function clearFlagCache() {
  _cache.clear();
}

module.exports = { isFlagLive, clearFlagCache };
