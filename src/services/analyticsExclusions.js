'use strict';

/**
 * Who does not count as a customer (USAGE-TELEMETRY-PLAN.md §7.0).
 *
 * §7.0 lists staff/internal accounts as a FIXED exclusion, not a toggle, but
 * until now nothing applied it — impersonation was filtered everywhere and
 * staff nowhere. Staff are among the heaviest users of a beta product, so they
 * inflate both the numerator and the denominator of anything they touch.
 *
 * ADMIN_EMAILS is the only reliable signal available. `User.roles` is
 * explicitly NOT usable — validateAdmin documents that role claims go stale
 * until re-login, which is why platform-admin identity lives in env at all.
 * There is no marker for an internal/demo *customer* org anywhere in the
 * schema, so §7.0's "internal orgs" is only partly satisfiable today; adding
 * `Organization.internal` would be the way to close that half.
 *
 * Exclusion happens at READ time, so editing ADMIN_EMAILS retroactively
 * changes historical figures. That is the right trade against write-time
 * exclusion (which could never reach rows already written), but panels that
 * use it should say staff are excluded.
 */

const User = require('../models/User');
const { adminEmailSet } = require('../utils/adminEmails');

// Small and slow-changing; one lookup per request is noise next to the
// aggregations it guards, but a short cache keeps it off the hot path entirely.
const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, ids: [] };

/** ObjectIds of accounts that must not appear in customer-facing analytics. */
async function excludedUserIds() {
  if (Date.now() - cache.at < TTL_MS) return cache.ids;
  const emails = [...adminEmailSet()];
  if (!emails.length) {
    cache = { at: Date.now(), ids: [] };
    return cache.ids;
  }
  try {
    const rows = await User.find({ email: { $in: emails } }, { _id: 1 }).lean();
    cache = { at: Date.now(), ids: rows.map((r) => r._id) };
  } catch {
    // Serving a stale list beats failing a dashboard read.
  }
  return cache.ids;
}

/** `{ $nin: [...] }` clause for a userId field, or null when nothing to exclude. */
async function excludedUserFilter() {
  const ids = await excludedUserIds();
  return ids.length ? { $nin: ids } : null;
}

/** Test seam — the cache would otherwise outlive a seeded fixture. */
function _resetCache() {
  cache = { at: 0, ids: [] };
}

module.exports = { excludedUserIds, excludedUserFilter, _resetCache };
