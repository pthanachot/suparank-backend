const Workspace = require('../models/Workspace');
const KeywordSearch = require('../models/KeywordSearch');
const KeywordDetail = require('../models/KeywordDetail');
const { resolveCountry, fetchRelatedKeywords, fetchSerpResults } = require('../services/keywordService');

// ─── Workspace Resolution (same pattern as aiTrackerController.js) ──────────

async function resolveWorkspace(req, res) {
  const { workspaceNumber } = req.params;
  const workspace = await Workspace.findOne({
    workspaceNumber: Number(workspaceNumber),
    $or: [
      { userId: req.user.userId },
      { 'members.userId': req.user.userId },
    ],
  });
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  return workspace;
}

// ─── Cache TTL (24 hours) ───────────────────────────────────────────────────

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// POST /:workspaceNumber/keywords/search
// Body: { keyword: string, country?: string }
// ═══════════════════════════════════════════════════════════════════════════════

async function searchKeywords(req, res) {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { keyword, country } = req.body;
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return res.status(400).json({ error: 'keyword is required' });
    }

    const seedKeyword = keyword.trim().toLowerCase();
    const countryConfig = resolveCountry(country || 'United States');
    const countryCode = countryConfig.gl.toUpperCase();

    // Check cache (global — not workspace-scoped)
    const cached = await KeywordSearch.findOne({
      seedKeyword,
      country: countryCode,
      fetchedAt: { $gte: new Date(Date.now() - CACHE_TTL_MS) },
    });

    if (cached) {
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

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
      return res.json({
        keyword: cached.keyword,
        serpResults: cached.serpResults,
        paaQuestions: cached.paaQuestions,
      });
    }

    // Fetch from Serper
    const { organic, peopleAlsoAsk } = await fetchSerpResults(keyword, countryConfig.gl);

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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const searches = await KeywordSearch.find()
      .sort({ fetchedAt: -1 })
      .limit(20)
      .select('seedKeyword country totalCount fetchedAt')
      .lean();

    return res.json({ searches });
  } catch (err) {
    console.error('[keywordController] getSearchHistory error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to get search history' });
  }
}

module.exports = {
  searchKeywords,
  getKeywordDetail,
  getSearchHistory,
};
