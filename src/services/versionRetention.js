/**
 * Version-history retention (Phase 11).
 *
 * Content version snapshots (Content.versions) are a client-supplied embedded
 * array, capped at 10 by COUNT via the schema validator. The tiers advertise a
 * time window instead — Free 7d / Standard 30d / Pro 90d / Agency 365d
 * (TierConfig.contentVersionHistoryDays) — but nothing enforced it server-side.
 *
 * This prunes snapshots older than the tier's window on save ("lazy" pruning —
 * no cron: every save re-trims the doc being edited). The most-recent snapshot is
 * NEVER dropped, so history is never fully lost even if every snapshot is past the
 * window. A hard MAX_VERSIONS ceiling (matching the Content schema's 10-snapshot
 * validator) is also applied so an all-fresh array on a long-retention tier can
 * never exceed the validator and 500 the save.
 *
 * Retention is an organisation feature: callers apply this only for org-scoped
 * workspaces (personal/org-less workspaces keep the count-cap-only behaviour).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_VERSIONS = 10; // hard ceiling — matches Content.versions schema validator

// Snapshots are written in epoch-MS (Date.now()), but a client/integration that
// sent epoch-SECONDS would be ~1000× smaller than the ms cutoff and collapse ALL
// history to the newest snapshot. Any real epoch-ms date after ~1973 is ≥ 1e11;
// any epoch-seconds date before ~year 5138 is < 1e11 — so a positive value below
// the threshold is treated as seconds and scaled to ms for COMPARISON only (the
// stored snapshot value is never mutated).
const MS_THRESHOLD = 1e11;
function toMs(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return t;
  return t > 0 && t < MS_THRESHOLD ? t * 1000 : t;
}
// Numeric sort/compare key: normalized ms, or -Infinity for a malformed timestamp
// (sorts oldest → dropped first; never produces a NaN comparison).
const numTs = (v) => (typeof v?.timestamp === 'number' && Number.isFinite(v.timestamp) ? toMs(v.timestamp) : -Infinity);

/**
 * @param {Array} versions  snapshots (each with a numeric epoch-ms `timestamp`)
 * @param {number|null|undefined} retentionDays  tier window; null/≤0 = keep all
 * @param {number} [now]  epoch ms (injectable for tests)
 * @returns {Array} pruned snapshots (new array; input never mutated)
 */
function pruneVersions(versions, retentionDays, now = Date.now()) {
  if (!Array.isArray(versions) || versions.length <= 1) return versions || [];

  let kept = versions;
  if (retentionDays != null && retentionDays > 0) {
    const cutoff = now - retentionDays * DAY_MS;
    // Keep a snapshot if it is fresh OR its timestamp is MALFORMED (non-numeric):
    // a bad timestamp is not evidence of age, so defer it to schema validation
    // rather than silently dropping real content here. Seconds-vs-ms is normalized
    // (toMs) so a seconds timestamp isn't mistaken for ancient.
    const fresh = versions.filter((v) => typeof v?.timestamp !== 'number' || toMs(v.timestamp) >= cutoff);
    if (fresh.length > 0) {
      kept = fresh;
    } else {
      // Everything is validly past the window — keep only the single most-recent
      // snapshot so the user is never left with zero recoverable history.
      const newest = versions.reduce((a, b) => (numTs(b) > numTs(a) ? b : a));
      kept = [newest];
    }
  }

  // Hard count ceiling (defensive; input is normally already ≤10). Keep the
  // newest MAX_VERSIONS in chronological order; numTs coerces malformed timestamps
  // to -Infinity (dropped first) so the real newest snapshot is always retained.
  if (kept.length > MAX_VERSIONS) {
    kept = [...kept].sort((a, b) => numTs(a) - numTs(b)).slice(-MAX_VERSIONS);
  }
  return kept;
}

module.exports = { pruneVersions };
