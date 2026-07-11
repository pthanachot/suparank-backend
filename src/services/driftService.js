/**
 * Rec 10 — SERP drift detection (near-$0 dynamism).
 *
 * Weekly cheap check per active content: re-run the engine's /api/discover
 * (one Serper query — NEVER the LLM pipeline) and compare the fresh SERP's
 * competitor URLs against the set stored at analysis time. Low overlap =
 * the SERP has shifted → flag `content.driftDetected` so the editor can show
 * "SERP shifted — Re-analyze recommended". The user spends the (quota-gated,
 * Rec 5) reanalysis; nothing is auto-run.
 */

const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const tierService = require('./tierService');
const { engineFetch } = require('./analysisEngine');

// Below this Jaccard overlap between stored and fresh competitor sets, the
// SERP is considered drifted. Exported for tests.
const DRIFT_OVERLAP_THRESHOLD = 0.6;

// Sweep eligibility windows.
const MIN_ANALYSIS_AGE_DAYS = 21; // don't nag fresh analyses
const MAX_IDLE_DAYS = 90; // skip abandoned docs

/**
 * Normalize a URL for overlap comparison.
 *
 * PARITY CONTRACT: mirrors engine `cluster.NormalizeURL` (cluster.go:286) —
 * strips utm_*, ref, fbclid, gclid, source, medium, campaign params
 * (case-insensitive keys), sorts remaining query params (Go's Encode() sorts),
 * strips trailing slashes from non-root paths, strips the fragment. Protocol
 * and www are KEPT (the engine keeps them; both sides of the comparison come
 * from the same engine endpoint, so consistency matters more than aggressive
 * canonicalization). Unparseable input is returned unchanged, as in Go.
 * Known cosmetic divergence: the JS URL API lowercases the host; engine test
 * fixtures are all lowercase, so the parity table is unaffected.
 */
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const drop = [];
  for (const key of u.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith('utm_')
      || lower === 'ref' || lower === 'fbclid' || lower === 'gclid'
      || lower === 'source' || lower === 'medium' || lower === 'campaign'
    ) {
      drop.push(key);
    }
  }
  for (const key of drop) u.searchParams.delete(key);
  u.searchParams.sort(); // Go's url.Values.Encode() emits keys sorted
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  u.hash = '';
  return u.toString();
}

/**
 * Jaccard overlap between two URL lists (normalized). Empty on either side
 * → overlap 1 (no drift signal — never flag on missing data).
 * Returns { overlap: 0..1, newUrls: fresh URLs absent from stored }.
 */
function computeOverlap(storedUrls, freshUrls) {
  const stored = new Set((storedUrls || []).map(normalizeUrl).filter(Boolean));
  const fresh = new Set((freshUrls || []).map(normalizeUrl).filter(Boolean));
  if (stored.size === 0 || fresh.size === 0) return { overlap: 1, newUrls: [] };

  let intersection = 0;
  const newUrls = [];
  for (const u of fresh) {
    if (stored.has(u)) intersection += 1;
    else newUrls.push(u);
  }
  const union = stored.size + fresh.size - intersection;
  return { overlap: union === 0 ? 1 : intersection / union, newUrls };
}

/**
 * Check one content's SERP for drift. Throws on engine failure (the sweep
 * counts errors; a broken engine must not flag anything).
 * → { drifted, overlap, newCompetitors }
 */
async function checkContentDrift(content) {
  const keywords = content.targetKeywords || [];
  const storedUrls = (content.competitors || []).map((c) => c.url).filter(Boolean);
  if (keywords.length === 0 || storedUrls.length === 0) {
    return { drifted: false, overlap: 1, newCompetitors: [] };
  }

  // skip_volumes: we only consume candidates — without it, discover would
  // bill a DataForSEO volume request per check (fresh related-search terms
  // are never cached) for data this comparison discards.
  // engineFetch injects X-Internal-Key — the engine gates /api/discover behind
  // ShouldProtect, so without it the sweep 401s on every keyed deploy.
  const res = await engineFetch('/api/discover', {
    body: { keywords, skip_volumes: true },
    timeoutMs: 60000,
  });
  if (!res.ok) {
    throw new Error(`discover returned ${res.status}`);
  }
  const data = await res.json();
  const freshUrls = (data.candidates || []).map((c) => c.url).filter(Boolean);
  if (freshUrls.length === 0) {
    // An empty SERP answer is a data problem, not drift.
    return { drifted: false, overlap: 1, newCompetitors: [] };
  }

  const { overlap, newUrls } = computeOverlap(storedUrls, freshUrls);
  return {
    drifted: overlap < DRIFT_OVERLAP_THRESHOLD,
    overlap: Math.round(overlap * 100) / 100,
    newCompetitors: newUrls.slice(0, 10),
  };
}

/**
 * Weekly sweep: select eligible contents (ready, analyzed >21d ago, not
 * already flagged, touched in the last 90d), oldest-analyzed first, capped at
 * batchSize; paid orgs only (cost gate). One /api/discover per checked doc —
 * sequential, to keep Serper load gentle.
 */
async function runDriftSweep({ batchSize = 50 } = {}) {
  const now = Date.now();
  const candidates = await Content.find({
    analysisStatus: 'ready',
    analyzedAt: { $lt: new Date(now - MIN_ANALYSIS_AGE_DAYS * 86400000) },
    driftDetected: null, // matches both null and missing (legacy docs)
    updatedAt: { $gte: new Date(now - MAX_IDLE_DAYS * 86400000) },
  })
    .sort({ analyzedAt: 1 })
    .limit(batchSize)
    .select('targetKeywords competitors workspaceId analyzedAt');

  let checked = 0;
  let flagged = 0;
  let errors = 0;
  const tierCache = new Map(); // orgId → tier, per sweep

  for (const content of candidates) {
    try {
      const ws = await Workspace.findById(content.workspaceId).select('organizationId').lean();
      const orgId = ws?.organizationId?.toString();
      if (!orgId) continue;

      let tier = tierCache.get(orgId);
      if (tier === undefined) {
        tier = (await tierService.getOrgTierConfig(orgId)).tier;
        tierCache.set(orgId, tier);
      }
      if (tier === 'free') continue; // paid tiers only

      checked += 1;
      const result = await checkContentDrift(content);
      if (result.drifted) {
        flagged += 1;
        await Content.updateOne(
          { _id: content._id },
          {
            $set: {
              driftDetected: {
                at: new Date(),
                overlap: result.overlap,
                newCompetitors: result.newCompetitors,
              },
            },
          },
        );
      }
    } catch (err) {
      // Engine 5xx/timeout or a doc-level surprise: count it, flag nothing,
      // keep sweeping. A broken engine must never mark content as drifted.
      errors += 1;
      console.error(`[drift] check failed for content ${content._id}:`, err.message);
    }
  }

  console.log(`[drift] checked ${checked}, flagged ${flagged}, errors ${errors} (of ${candidates.length} candidates)`);
  return { candidates: candidates.length, checked, flagged, errors };
}

module.exports = {
  normalizeUrl,
  computeOverlap,
  checkContentDrift,
  runDriftSweep,
  DRIFT_OVERLAP_THRESHOLD,
};
