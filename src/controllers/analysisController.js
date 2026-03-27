const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const { scoreContent } = require('../services/scorer');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8080';

// Shared helper: resolve workspace + content from route params
async function resolveContent(req, res) {
  const { workspaceNumber, contentNumber } = req.params;
  const workspace = await Workspace.findOne({
    workspaceNumber: Number(workspaceNumber),
    userId: req.user.userId,
  });
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  const content = await Content.findByNumber(workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  return content;
}

// Curate benchmark: extract only what the frontend needs
function curateBenchmark(raw) {
  if (!raw) return null;
  return {
    keywords: raw.keywords || [],
    pageCount: raw.page_count || 0,
    avgWordCount: raw.avg_word_count || 0,
    minWordCount: raw.min_word_count || 0,
    maxWordCount: raw.max_word_count || 0,
    avgH1Count: raw.avg_h1_count || 0,
    avgH2Count: raw.avg_h2_count || 0,
    avgH3Count: raw.avg_h3_count || 0,
    avgInternalLinks: raw.avg_internal_links || 0,
    avgExternalLinks: raw.avg_external_links || 0,
    avgImages: raw.avg_images || 0,
    avgTitleLength: raw.avg_title_length || 0,
    avgDescLength: raw.avg_desc_length || 0,
    avgKeywordDensity: raw.avg_keyword_density_pct || 0,
    keywordInH2Rate: raw.keyword_in_h2_rate || 0,
    keywordInFirst100Rate: raw.keyword_in_first_100_rate || 0,
    avgListCount: raw.avg_list_count || 0,
    avgTableCount: raw.avg_table_count || 0,
    avgFaqCount: raw.avg_faq_count || 0,
    avgSentenceLength: raw.avg_sentence_length || 0,
    avgReadingLevel: raw.avg_reading_level || 0,
    topNlpTerms: (raw.top_nlp_terms || []).map((t) => ({
      term: t.term,
      count: t.count,
      tfidf: t.tfidf,
      bm25: t.bm25,
      docFrequency: t.doc_frequency,
      prominence: t.prominence || '',
      usageRange: t.usage_range || null,
    })),
    topicClusters: (raw.topic_clusters || []).map((c) => ({
      topic: c.topic,
      terms: c.terms || [],
      importance: c.importance,
      docFrequency: c.doc_frequency,
    })),
    subtopics: (raw.subtopics || []).map((s) => ({
      label: s.label,
      stemmedForm: s.stemmed_form,
      variants: s.variants || [],
      docFrequency: s.doc_frequency,
      docPercent: s.doc_percent,
    })),
  };
}

// Curate competitors: summaries only
function curateCompetitors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    url: c.url,
    title: c.title,
    position: c.position,
    wordCount: c.word_count,
    qualityScore: c.quality_score,
    keywords: c.keywords || [],
    selected: c.selected || false,
  }));
}

// Curate AI format recommend data
function curateAiFormatData(raw) {
  if (!raw) return null;
  return {
    keyword: raw.keyword || '',
    recommendedFormat: raw.recommended_format || 'guide',
    formatConfidence: raw.format_confidence || 0,
    formatDistribution: raw.format_distribution || {},
    recommendedStructure: raw.recommended_structure ? {
      targetWordCount: raw.recommended_structure.target_word_count || null,
      targetSections: raw.recommended_structure.target_sections || null,
      targetSectionLength: raw.recommended_structure.target_section_length || null,
      suggestedHeadings: raw.recommended_structure.suggested_headings || [],
      mustIncludeElements: raw.recommended_structure.must_include_elements || [],
      frontLoadingGuidance: raw.recommended_structure.front_loading_guidance || '',
    } : null,
    nlpTerms: (raw.nlp_terms || []).map((t) => ({
      term: t.term,
      group: t.group || 'mention',
      benchmarkCount: t.benchmark_count || 0,
      position: t.position || 'any',
      proximityPartners: t.proximity_partners || [],
      volatile: t.volatile || false,
    })),
  };
}

// ─── RUN ANALYSIS (background) ─────────────────────────────────

async function runAnalysis(contentId) {
  try {
    const content = await Content.findById(contentId);
    if (!content) return;

    const keywords = content.targetKeywords;
    if (!keywords || keywords.length === 0) {
      await Content.findByIdAndUpdate(contentId, {
        $set: { analysisStatus: 'failed', analysisError: 'No keywords to analyze' },
      });
      return;
    }

    await Content.findByIdAndUpdate(contentId, {
      $set: { analysisStatus: 'analyzing', analysisError: '' },
    });

    // Step 1: Discover (SERP data, related searches, PAA, volumes)
    let discoverData = {};
    try {
      const discoverRes = await fetch(`${ENGINE_URL}/api/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords }),
        signal: AbortSignal.timeout(60000),
      });
      if (discoverRes.ok) {
        discoverData = await discoverRes.json();
      }
    } catch (err) {
      console.error('[analysis] discover failed:', err.message);
    }

    // Step 2: Analyze (full crawl + benchmark + intent)
    let analyzeData = {};
    try {
      const analyzeRes = await fetch(`${ENGINE_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords }),
        signal: AbortSignal.timeout(180000),
      });
      if (analyzeRes.ok) {
        analyzeData = await analyzeRes.json();
      } else {
        const errBody = await analyzeRes.text();
        throw new Error(`Engine returned ${analyzeRes.status}: ${errBody}`);
      }
    } catch (err) {
      console.error('[analysis] analyze failed:', err.message);
      await Content.findByIdAndUpdate(contentId, {
        $set: { analysisStatus: 'failed', analysisError: err.message },
      });
      return;
    }

    // Step 3: AI Format Recommend (optional — needs AI engine keys)
    let aiFormatData = null;
    try {
      const aiFormatRes = await fetch(`${ENGINE_URL}/api/ai-format-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords }),
        signal: AbortSignal.timeout(90000),
      });
      if (aiFormatRes.ok) {
        aiFormatData = await aiFormatRes.json();
        console.log(`[analysis] ai-format-recommend returned ${(aiFormatData.nlp_terms || []).length} NLP terms`);
      }
    } catch (err) {
      console.error('[analysis] ai-format-recommend failed (non-fatal):', err.message);
    }

    // Step 4: Save curated results to DB
    const updates = {
      analysisStatus: 'ready',
      analysisError: '',
      analyzedAt: new Date(),
      benchmark: curateBenchmark(analyzeData.benchmark),
      intent: analyzeData.intent || null,
      competitors: curateCompetitors(analyzeData.competitors),
      relatedSearches: discoverData.related_searches || [],
      peopleAlsoAsk: discoverData.people_also_ask || [],
      keywordVolumes: discoverData.keyword_volumes || [],
      aiFormatData: aiFormatData ? curateAiFormatData(aiFormatData) : null,
    };

    await Content.findByIdAndUpdate(contentId, { $set: updates });
    console.log(`[analysis] completed for content ${contentId}`);
  } catch (err) {
    console.error('[analysis] unexpected error:', err.message);
    await Content.findByIdAndUpdate(contentId, {
      $set: { analysisStatus: 'failed', analysisError: err.message },
    }).catch(() => {});
  }
}

// ─── POST /:contentNumber/analyze — trigger analysis ───────────

const triggerAnalysis = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    if (content.analysisStatus === 'analyzing') {
      return res.status(409).json({ error: 'Analysis already in progress' });
    }

    await Content.findByIdAndUpdate(content._id, {
      $set: { analysisStatus: 'pending' },
    });

    // Fire-and-forget: run analysis in background
    runAnalysis(content._id);

    res.json({ analysisStatus: 'pending', message: 'Analysis started' });
  } catch (err) {
    console.error('triggerAnalysis error:', err.message);
    res.status(500).json({ error: 'Failed to trigger analysis' });
  }
};

// ─── GET /:contentNumber/benchmark — return saved analysis ─────

const getBenchmark = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    res.json({
      analysisStatus: content.analysisStatus,
      analysisError: content.analysisError || '',
      analyzedAt: content.analyzedAt || null,
      benchmark: content.benchmark || null,
      intent: content.intent || null,
      competitors: content.competitors || [],
      relatedSearches: content.relatedSearches || [],
      peopleAlsoAsk: content.peopleAlsoAsk || [],
      keywordVolumes: content.keywordVolumes || [],
      aiFormatData: content.aiFormatData || null,
    });
  } catch (err) {
    console.error('getBenchmark error:', err.message);
    res.status(500).json({ error: 'Failed to fetch benchmark' });
  }
};

// ─── POST /:contentNumber/reanalyze — force re-analysis ────────

const reanalyze = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    if (content.analysisStatus === 'analyzing') {
      return res.status(409).json({ error: 'Analysis already in progress' });
    }

    await Content.findByIdAndUpdate(content._id, {
      $set: { analysisStatus: 'pending', analysisError: '' },
    });

    // Fire-and-forget
    runAnalysis(content._id);

    res.json({ analysisStatus: 'pending', message: 'Re-analysis started' });
  } catch (err) {
    console.error('reanalyze error:', err.message);
    res.status(500).json({ error: 'Failed to trigger re-analysis' });
  }
};

// ─── POST /:contentNumber/score — compute score from saved benchmark ───

const computeScore = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { htmlContent } = req.body;
    if (!htmlContent) {
      return res.status(400).json({ error: 'htmlContent is required' });
    }

    if (!content.benchmark) {
      return res.status(400).json({ error: 'No benchmark data. Run analysis first.' });
    }

    const keyword = (content.targetKeywords && content.targetKeywords[0]) || '';
    const result = scoreContent(htmlContent, keyword, content.benchmark, content.intent, content.aiFormatData);

    // Update the stored score on the content document
    await Content.findByIdAndUpdate(content._id, { $set: { score: result.overallScore } });

    res.json({ score: result });
  } catch (err) {
    console.error('computeScore error:', err.message);
    res.status(500).json({ error: 'Failed to compute score' });
  }
};

module.exports = { triggerAnalysis, getBenchmark, reanalyze, runAnalysis, computeScore };
