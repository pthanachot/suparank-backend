/**
 * Rec 11 — keyword-level AI-visibility series from stored AiTracker scans.
 * Read-only: queries the scans the existing scheduler already produces; no
 * scan-engine involvement. Lives beside aiTrackerScanEngine.js by design.
 */

const AiTracker = require('../models/AiTracker');
const AiTrackerScan = require('../models/AiTrackerScan');

/**
 * Per-day AI-visibility series for a set of prompt texts (matched
 * case-insensitively on trimmed text) across all of a workspace's trackers.
 *
 * Aggregation per day across prompts and platforms:
 *   mentioned = any, cited = any, position = min non-null (1 = best).
 *
 * → { series: [{date: 'YYYY-MM-DD', mentioned, cited, position}], lastScanAt }
 */
async function getScanSeriesForPrompts(workspaceId, prompts, days = 30) {
  if (!Array.isArray(prompts) || prompts.length === 0) return { series: [], lastScanAt: null };

  const trackers = await AiTracker.find({ workspaceId }).select('_id').lean();
  if (trackers.length === 0) return { series: [], lastScanAt: null };

  const wanted = new Set(prompts.map((p) => String(p).trim().toLowerCase()));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const scans = await AiTrackerScan.find({
    trackerId: { $in: trackers.map((t) => t._id) },
    status: 'ready',
    completedAt: { $gte: cutoff },
  }).select('completedAt results').sort({ completedAt: 1 }).lean();

  const byDay = new Map();
  let lastScanAt = null;

  for (const scan of scans) {
    if (!scan.completedAt) continue;
    const matched = (scan.results || []).filter(
      (r) => wanted.has(String(r.prompt || '').trim().toLowerCase()),
    );
    if (matched.length === 0) continue;

    lastScanAt = scan.completedAt; // scans are sorted asc → ends at the max
    const day = new Date(scan.completedAt).toISOString().slice(0, 10);
    const entry = byDay.get(day) || { date: day, mentioned: false, cited: false, position: null };
    for (const r of matched) {
      for (const pf of r.platforms || []) {
        if (pf.mentioned) entry.mentioned = true;
        if (pf.cited) entry.cited = true;
        if (pf.position != null && (entry.position == null || pf.position < entry.position)) {
          entry.position = pf.position;
        }
      }
    }
    byDay.set(day, entry);
  }

  return { series: [...byDay.values()], lastScanAt };
}

module.exports = { getScanSeriesForPrompts };
