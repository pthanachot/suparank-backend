const mongoose = require('mongoose');
const KeywordSearch = require('../models/KeywordSearch');
const KeywordDetail = require('../models/KeywordDetail');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const { resolveCountry, fetchRelatedKeywords, fetchSerpResults, SUPPORTED_COUNTRIES } = require('../services/keywordService');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');
const { resolveCredits } = require('../config/creditRules');

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

    const seedKeyword = keyword.trim().toLowerCase();
    const countryConfig = resolveCountry(country || 'United States');
    const countryCode = countryConfig.gl.toUpperCase();

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

      return res.json({
        seedMetrics: cached.seedMetrics,
        relatedKeywords: cached.relatedKeywords,
        totalCount: cached.totalCount,
      });
    }

    // Fetch from DataForSEO
    const { seed, related } = await fetchRelatedKeywords(
      seedKeyword,
      countryConfig.locationName,
      countryConfig.languageCode,
    );

    const totalCount = related.length;

    // Upsert into cache (global)
    await KeywordSearch.findOneAndUpdate(
      { seedKeyword, country: countryCode },
      {
        seedMetrics: seed,
        relatedKeywords: related,
        totalCount,
        fetchedAt: new Date(),
      },
      { upsert: true, new: true },
    );

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

    return res.json({
      seedMetrics: seed,
      relatedKeywords: related,
      totalCount,
    });
  } catch (err) {
    console.error('[keywordController] searchKeywords error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to search keywords' });
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

    const keyword = kw.trim().toLowerCase();
    const countryConfig = resolveCountry(country || 'United States');
    const countryCode = countryConfig.gl.toUpperCase();

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

    return res.json({
      keyword,
      serpResults: organic,
      paaQuestions: peopleAlsoAsk,
    });
  } catch (err) {
    console.error('[keywordController] getKeywordDetail error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to get keyword detail' });
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
    console.error('[keywordController] getSearchHistory error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to get search history' });
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
    const { kw, country } = req.query;
    if (!kw || typeof kw !== 'string' || !kw.trim()) {
      return res.status(400).json({ error: 'kw query parameter is required' });
    }

    const seedKeyword = kw.trim().toLowerCase();
    const countryCode = (country || 'US').toUpperCase();

    const cached = await KeywordSearch.findOne({ seedKeyword, country: countryCode });

    if (!cached) {
      return res.status(404).json({ error: 'No cached results found' });
    }

    return res.json({
      seedMetrics: cached.seedMetrics,
      relatedKeywords: cached.relatedKeywords,
      totalCount: cached.totalCount,
    });
  } catch (err) {
    console.error('[keywordController] getCachedResults error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to get cached results' });
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
