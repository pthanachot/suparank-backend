const KeywordSearch = require('../models/KeywordSearch');
const KeywordDetail = require('../models/KeywordDetail');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const { resolveCountry, fetchRelatedKeywords, fetchSerpResults, SUPPORTED_COUNTRIES } = require('../services/keywordService');
const UsageTracker = require('../models/UsageTracker');
const tierService = require('../services/tierService');

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

    // Track keyword search against tier quota
    if (req.tierQuota) {
      await UsageTracker.increment(req.tierQuota.orgId, req.tierQuota.counterKey, req.tierQuota.period);
    }

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
      KeywordResearchHistory.findOneAndUpdate(
        { workspaceId: workspace._id, seedKeyword, country: countryCode },
        { searchedAt: new Date(), createdOnPlan },
        { upsert: true },
      ).catch(() => {});

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
    KeywordResearchHistory.findOneAndUpdate(
      { workspaceId: workspace._id, seedKeyword, country: countryCode },
      { searchedAt: new Date(), createdOnPlan },
      { upsert: true },
    ).catch(() => {});

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

    // Track keyword detail lookup against tier quota
    if (req.tierQuota) {
      await UsageTracker.increment(req.tierQuota.orgId, req.tierQuota.counterKey, req.tierQuota.period);
    }

    // Check cache (global)
    const cached = await KeywordDetail.findOne({
      keyword,
      country: countryCode,
      fetchedAt: { $gte: new Date(Date.now() - CACHE_TTL_MS) },
    });

    if (cached) {
      return res.json({
        keyword: cached.keyword,
        serpResults: cached.serpResults,
        paaQuestions: cached.paaQuestions,
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

    const deleted = await KeywordResearchHistory.findOneAndDelete({
      _id: historyId,
      workspaceId: workspace._id,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'History entry not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[keywordController] deleteSearchHistory error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to delete history entry' });
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
