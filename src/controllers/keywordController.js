const mongoose = require('mongoose');
const KeywordSearch = require('../models/KeywordSearch');
const KeywordDetail = require('../models/KeywordDetail');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const {
  resolveCountry, fetchRelatedKeywords, fetchSerpResults, SUPPORTED_COUNTRIES,
  DATAFORSEO_UNSUPPORTED_COUNTRIES,
} = require('../services/keywordService');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');
const { resolveCredits } = require('../config/creditRules');
// Wave 1 (§4b): server-lane usage telemetry — cache hits previously left ZERO
// trace, and credit-derived counts silently lose the free tier. Fire-and-forget.
const { recordObservation } = require('./observeController');

// Phase 6: bill a keyword search at 1 credit per row DELIVERED (cap 50). Cache
// hits deliver rows too, so they bill identically to fresh fetches — the user
// gets the licensed data either way. Free = fixed bundle → 0 (resolveCredits).
// preDeduct+settle via deductForRequest so the orphan-sweep can't refund it.
async function chargeKeywordRows(req, rows) {
  if (!req.creditContext?.deductionEnabled) return;
  const credits = resolveCredits('keywordLookup', { tier: req.creditContext.tier, rows });
  await creditService.deductForRequest(req, { credits, metadata: { rows } });
}

// Workspace resolved by permissions middleware (req.workspace).

// ─── Cache TTL (24 hours) ───────────────────────────────────────────────────

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// K3: how long an EMPTY result stays cached. Long enough to stop a hot
// keyword re-billing DataForSEO on every request, short enough that a
// transient vendor failure clears itself within the hour.
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;
// C3: upper bound on a seed keyword. Enforced before the vendor call so abuse
// costs us nothing. Generous by design — real seeds are a handful of words.
const MAX_KEYWORD_LENGTH = 200;

/**
 * K2 — canonical country code for cache keys and history rows.
 *
 * `/search` and `/detail` derived their code from `resolveCountry(...).gl`
 * (so the UK is stored as `'UK'`, Google's gl value), while `/cached`
 * uppercased whatever the client sent (`'GB'`, or a display name like
 * `'United Kingdom'`). The two never met: UK history replay always missed,
 * and any display-name caller missed for every country. Everything now goes
 * through this one function — accepting a gl value, an ISO code, or a
 * display name — so writes and reads cannot drift apart again.
 */
/**
 * K6 / D2 — single-flight for identical in-progress lookups.
 *
 * Two users (or two tabs) searching the same keyword+country at the same
 * moment both missed the cache and both called DataForSEO — two billed
 * vendor requests for one piece of data, and both charged the customer.
 * Callers now share ONE in-flight promise per `keyword|country`; the second
 * caller awaits the first's result. Billing still happens per REQUEST (each
 * caller gets the rows and is charged for them, which is the pricing
 * contract) — what this removes is the duplicate VENDOR spend and the
 * duplicate cache write.
 *
 * In-process only: with multiple backend replicas each process dedups its
 * own callers. That is the same scope as the existing suggest-prompts rate
 * limiter (PRIMITIVES G-07) and is deliberate — a cross-process lock would
 * need Redis, which this deployment does not have.
 */
const _inFlightSearches = new Map();

function singleFlightSearch(key, work) {
  const existing = _inFlightSearches.get(key);
  if (existing) return existing;
  const p = work().finally(() => _inFlightSearches.delete(key));
  _inFlightSearches.set(key, p);
  return p;
}

function normalizeCountryCode(input) {
  const raw = (input == null ? '' : String(input)).trim();
  if (!raw) return 'US';
  // Display name ("United Kingdom") → resolveCountry knows the mapping.
  if (raw.length > 3) {
    const cfg = resolveCountry(raw);
    if (cfg?.gl) return cfg.gl.toUpperCase();
  }
  const upper = raw.toUpperCase();
  // ISO alpha-2 aliases for gl values that differ from ISO.
  const ISO_TO_GL = { GB: 'UK' };
  return ISO_TO_GL[upper] || upper;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /:workspaceNumber/keywords/search
// Body: { keyword: string, country?: string }
// ═══════════════════════════════════════════════════════════════════════════════

async function searchKeywords(req, res) {
  try {
    const workspace = req.workspace;

    const { keyword, country } = req.body;
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return res.status(400).json({ error: 'keyword is required' });
    }
    // C3: bound the seed BEFORE it reaches a billable vendor. Without this an
    // arbitrarily long string was forwarded to DataForSEO, which spends a real
    // request on a payload it will reject anyway. This is a defensive bound —
    // no legitimate seed keyword approaches it.
    if (keyword.trim().length > MAX_KEYWORD_LENGTH) {
      return res.status(400).json({ error: `keyword must be ${MAX_KEYWORD_LENGTH} characters or fewer` });
    }

    // C4 review: reject a country DataForSEO cannot serve BEFORE the vendor
    // call. Filtering it out of GET /keywords/countries is not enough — the
    // frontend ships its own hardcoded list, and any direct API caller can
    // send whatever it likes. Without this the request reached DataForSEO and
    // came back a task error, which we surfaced as an opaque 500.
    if (typeof country === 'string' && DATAFORSEO_UNSUPPORTED_COUNTRIES.has(country.trim())) {
      return res.status(400).json({
        error: `Keyword data is not available for ${country.trim()}`,
        code: 'COUNTRY_UNSUPPORTED',
      });
    }

    const seedKeyword = keyword.trim().toLowerCase();
    // K2: ONE canonical country representation everywhere (see normalizeCountryCode).
    // A non-string country (array/object/number from a hand-rolled client) must
    // fall back rather than throw inside resolveCountry.
    const countryConfig = resolveCountry(typeof country === 'string' && country.trim() ? country : 'United States');
    const countryCode = normalizeCountryCode(countryConfig.gl);

    // Determine createdOnPlan for history entry
    let createdOnPlan = 'free';
    if (req.body.quotaSource === 'free') {
      createdOnPlan = 'free';
    } else if (workspace.organizationId) {
      const { tier } = await tierService.getOrgTierConfig(workspace.organizationId);
      createdOnPlan = tier === 'free' ? 'free' : 'paid';
    }

    // Check cache (global — not workspace-scoped)
    const cached = await KeywordSearch.findOne({
      seedKeyword,
      country: countryCode,
      fetchedAt: { $gte: new Date(Date.now() - CACHE_TTL_MS) },
    });

    if (cached) {
      // Record in workspace history (fire-and-forget)
      // Reset locked=false so re-searching an old locked keyword unlocks it
      KeywordResearchHistory.findOneAndUpdate(
        { workspaceId: workspace._id, seedKeyword, country: countryCode },
        { searchedAt: new Date(), createdOnPlan, locked: false },
        { upsert: true },
      ).catch(() => {});

      // Track quota only after successful result
      if (req.tierQuota) {
        await tierService.incrementQuota(req.tierQuota);
      }

      await chargeKeywordRows(req, (cached.relatedKeywords || []).length);

      recordObservation('keyword_search', {
        workspaceNumber: workspace.workspaceNumber,
        country: countryCode,
        rows: (cached.relatedKeywords || []).length,
        cacheHit: true,
      }, req.user?.userId, req.user?.impersonatedBy);

      return res.json({
        seedMetrics: cached.seedMetrics,
        relatedKeywords: cached.relatedKeywords,
        totalCount: cached.totalCount,
      });
    }

    // Fetch from DataForSEO — deduplicated across concurrent identical
    // requests so one vendor call serves them all (K6).
    const { seed, related } = await singleFlightSearch(
      `${seedKeyword}|${countryCode}`,
      () => fetchRelatedKeywords(seedKeyword, countryConfig.locationName, countryConfig.languageCode),
    );

    const totalCount = related.length;

    // K3: never cache an EMPTY result for the full 14 days. A single bad
    // DataForSEO response (task error, transient outage, throttle) returns
    // zero rows; caching that poisoned the keyword globally for two weeks —
    // every workspace then got an instant empty answer indistinguishable
    // from a genuine "no data", with no way to retry.
    //
    // But dropping the write entirely would re-bill DataForSEO on EVERY
    // search for a keyword that genuinely has no data. So empty results are
    // written with a back-dated `fetchedAt`, giving them a short negative
    // TTL (NEGATIVE_CACHE_TTL_MS): repeat lookups inside that window are
    // served from cache, and after it the vendor is asked again.
    const isEmpty = totalCount === 0;
    await KeywordSearch.findOneAndUpdate(
      { seedKeyword, country: countryCode },
      {
        seedMetrics: seed,
        relatedKeywords: related,
        totalCount,
        fetchedAt: isEmpty
          ? new Date(Date.now() - (CACHE_TTL_MS - NEGATIVE_CACHE_TTL_MS))
          : new Date(),
      },
      { upsert: true, new: true },
    );
    if (isEmpty) {
      console.warn(`[keywordController] empty result for "${seedKeyword}" (${countryCode}) — short negative TTL (K3)`);
    }

    // Record in workspace history (fire-and-forget)
    // Reset locked=false so re-searching an old locked keyword unlocks it
    KeywordResearchHistory.findOneAndUpdate(
      { workspaceId: workspace._id, seedKeyword, country: countryCode },
      { searchedAt: new Date(), createdOnPlan, locked: false },
      { upsert: true },
    ).catch(() => {});

    // Track quota only after successful result
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

    await chargeKeywordRows(req, totalCount);

    recordObservation('keyword_search', {
      workspaceNumber: workspace.workspaceNumber,
      country: countryCode,
      rows: totalCount,
      cacheHit: false,
    }, req.user?.userId, req.user?.impersonatedBy);

    return res.json({
      seedMetrics: seed,
      relatedKeywords: related,
      totalCount,
    });
  } catch (err) {
    // K5: log the vendor's message server-side, return a generic one. The
    // raw text could carry up to 300 chars of the DataForSEO/Serper response
    // body (endpoint shapes, quota/account details) straight to the client.
    console.error('[keywordController] searchKeywords error:', err.message);
    return res.status(500).json({ error: 'Failed to search keywords' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /:workspaceNumber/keywords/detail?kw=...&country=US
// ═══════════════════════════════════════════════════════════════════════════════

async function getKeywordDetail(req, res) {
  try {
    const workspace = req.workspace;

    const { kw, country } = req.query;
    if (!kw || typeof kw !== 'string' || !kw.trim()) {
      return res.status(400).json({ error: 'kw query parameter is required' });
    }

    // C3: same bound as /search — Serper is a real (if unbilled) vendor call.
    if (kw.trim().length > MAX_KEYWORD_LENGTH) {
      return res.status(400).json({ error: `kw must be ${MAX_KEYWORD_LENGTH} characters or fewer` });
    }

    const keyword = kw.trim().toLowerCase();
    const countryConfig = resolveCountry(typeof country === 'string' && country.trim() ? country : 'United States');
    const countryCode = normalizeCountryCode(countryConfig.gl); // K2

    // Check cache (global)
    const cached = await KeywordDetail.findOne({
      keyword,
      country: countryCode,
      fetchedAt: { $gte: new Date(Date.now() - CACHE_TTL_MS) },
    });

    if (cached) {
      // Cache hits are FREE — only fresh fetches (which cost a real Serper
      // API call) burn quota. The /cached endpoint enforces the same rule
      // and customers expect parity. Smoking gun: the smoke test showed
      // /detail incrementing quota even when no Serper call was made.
      recordObservation('keyword_detail_opened', {
        workspaceNumber: workspace.workspaceNumber,
        cacheHit: true,
      }, req.user?.userId, req.user?.impersonatedBy);
      return res.json({
        keyword: cached.keyword,
        serpResults: cached.serpResults,
        paaQuestions: cached.paaQuestions,
        fromCache: true,
      });
    }

    // Fetch from Serper
    const { organic, peopleAlsoAsk } = await fetchSerpResults(keyword, countryConfig.gl, countryConfig.languageCode);

    // Upsert into cache (global)
    await KeywordDetail.findOneAndUpdate(
      { keyword, country: countryCode },
      {
        serpResults: organic,
        paaQuestions: peopleAlsoAsk,
        fetchedAt: new Date(),
      },
      { upsert: true, new: true },
    );

    // Track quota only after successful result
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

    recordObservation('keyword_detail_opened', {
      workspaceNumber: workspace.workspaceNumber,
      cacheHit: false,
    }, req.user?.userId, req.user?.impersonatedBy);

    return res.json({
      keyword,
      serpResults: organic,
      paaQuestions: peopleAlsoAsk,
    });
  } catch (err) {
    console.error('[keywordController] getKeywordDetail error:', err.message); // K5: generic to client
    return res.status(500).json({ error: 'Failed to get keyword detail' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /:workspaceNumber/keywords/history
// ═══════════════════════════════════════════════════════════════════════════════

async function getSearchHistory(req, res) {
  try {
    const workspace = req.workspace;

    const historyEntries = await KeywordResearchHistory.find({ workspaceId: workspace._id })
      .sort({ searchedAt: -1 })
      .limit(50)
      .lean();

    // Enrich with totalCount from cache where available
    const searches = await Promise.all(
      historyEntries.map(async (entry) => {
        const cached = await KeywordSearch.findOne({
          seedKeyword: entry.seedKeyword,
          country: entry.country,
        })
          .select('totalCount')
          .lean();

        return {
          _id: entry._id,
          seedKeyword: entry.seedKeyword,
          country: entry.country,
          searchedAt: entry.searchedAt,
          totalCount: cached?.totalCount ?? 0,
          locked: entry.locked || false,
          createdOnPlan: entry.createdOnPlan || 'free',
        };
      }),
    );

    return res.json({ searches });
  } catch (err) {
    console.error('[keywordController] getSearchHistory error:', err.message); // K5: generic to client
    return res.status(500).json({ error: 'Failed to get search history' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /:workspaceNumber/keywords/history/:historyId
// ═══════════════════════════════════════════════════════════════════════════════

async function deleteSearchHistory(req, res) {
  try {
    const workspace = req.workspace;

    const { historyId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(historyId)) {
      return res.status(400).json({ error: 'Invalid history id' });
    }

    const deleted = await KeywordResearchHistory.findOneAndDelete({
      _id: historyId,
      workspaceId: workspace._id,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'History entry not found' });
    }

    recordObservation('keyword_history_deleted', {
      workspaceNumber: workspace.workspaceNumber,
    }, req.user?.userId, req.user?.impersonatedBy);

    return res.json({ success: true });
  } catch (err) {
    if (err instanceof mongoose.Error.CastError) {
      return res.status(400).json({ error: `Invalid ${err.path || 'id'} format` });
    }
    console.error('[keywordController] deleteSearchHistory error:', err.message);
    return res.status(500).json({ error: 'Failed to delete history entry' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /:workspaceNumber/keywords/countries
// ═══════════════════════════════════════════════════════════════════════════════

function getCountries(req, res) {
  return res.json({ countries: SUPPORTED_COUNTRIES });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /:workspaceNumber/keywords/cached?kw=...&country=US
// Returns cached results only (no DataForSEO call). For viewers loading history.
// ═══════════════════════════════════════════════════════════════════════════════

async function getCachedResults(req, res) {
  try {
    const workspace = req.workspace;

    const { kw, country } = req.query;
    if (!kw || typeof kw !== 'string' || !kw.trim()) {
      return res.status(400).json({ error: 'kw query parameter is required' });
    }

    const seedKeyword = kw.trim().toLowerCase();
    // K2: same canonicalisation as the write paths — previously this
    // uppercased the raw input, so 'GB' and display names never matched the
    // 'UK'-keyed rows written by /search.
    const countryCode = normalizeCountryCode(country || 'US');

    // K1: the KeywordSearch cache is GLOBAL (cross-tenant, licensed rows).
    // Serving it on keyword+country alone let any workspace read data another
    // tenant paid for, unmetered. Replaying cached results requires an
    // own-workspace history entry — i.e. this workspace ran (and was quota-
    // charged for) this exact search. 404 (not 403) on a missing entry so the
    // response doesn't reveal whether a global cache row exists.
    const historyEntry = await KeywordResearchHistory.findOne({
      workspaceId: workspace._id,
      seedKeyword,
      country: countryCode,
    });
    if (!historyEntry) {
      return res.status(404).json({ error: 'No cached results found' });
    }
    // Downgrade-locked entries are not replayable (the sidebar renders them
    // unclickable; this is the server-side enforcement). Re-searching via
    // POST /search is the sanctioned unlock path.
    if (historyEntry.locked) {
      return res.status(403).json({ error: 'This search is locked on your current plan', code: 'LOCKED' });
    }

    // Same freshness window as /search — without it, replay served rows the
    // TTL monitor hadn't deleted yet, making staleness timing-dependent.
    const cached = await KeywordSearch.findOne({
      seedKeyword,
      country: countryCode,
      fetchedAt: { $gte: new Date(Date.now() - CACHE_TTL_MS) },
    });

    if (!cached) {
      return res.status(404).json({ error: 'No cached results found' });
    }

    recordObservation('keyword_history_replayed', {
      workspaceNumber: workspace.workspaceNumber,
    }, req.user?.userId, req.user?.impersonatedBy);

    return res.json({
      seedMetrics: cached.seedMetrics,
      relatedKeywords: cached.relatedKeywords,
      totalCount: cached.totalCount,
    });
  } catch (err) {
    console.error('[keywordController] getCachedResults error:', err.message); // K5: generic to client
    return res.status(500).json({ error: 'Failed to get cached results' });
  }
}

module.exports = {
  searchKeywords,
  getKeywordDetail,
  getSearchHistory,
  deleteSearchHistory,
  getCountries,
  getCachedResults,
};

// Exported for tests only (Phase A / plan Part II) — not part of the API.
module.exports.__test = { normalizeCountryCode, singleFlightSearch, CACHE_TTL_MS };
