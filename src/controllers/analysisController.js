const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const { scoreContent } = require('../services/scorer');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8080';

// Shared helper: resolve workspace + content from route params
async function resolveContent(req, res) {
  const { workspaceNumber, contentNumber } = req.params;
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
  const content = await Content.findByNumber(workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  return content;
}

// Curate benchmark: map engine content_brief to scorer-compatible format
function curateBenchmark(brief) {
  if (!brief) return null;

  const stats = brief.competitor_stats || {};
  const terms = brief.terms || [];
  const clusters = brief.clusters || [];
  const structure = brief.structure || [];

  // Estimate page count from max doc_freq across terms
  const pageCount = terms.reduce((max, t) => Math.max(max, t.doc_freq || 0), 0) || 10;

  return {
    keywords: brief.keyword ? [brief.keyword] : [],
    pageCount,
    avgWordCount: stats.avg_word_count || 0,
    minWordCount: 0,
    maxWordCount: 0,
    avgH1Count: 1,
    avgH2Count: stats.avg_sections || 0,
    avgH3Count: 0,
    avgInternalLinks: 0,
    avgExternalLinks: 0,
    avgImages: 0,
    avgTitleLength: 0,
    avgDescLength: 0,
    avgKeywordDensity: 0,
    keywordInH2Rate: 0,
    keywordInFirst100Rate: 0,
    avgListCount: 0,
    avgTableCount: 0,
    avgFaqCount: 0,
    avgSentenceLength: 0,
    avgReadingLevel: 0,
    topNlpTerms: terms.map((t) => ({
      term: t.term,
      count: t.freq || t.doc_freq || 1,
      tfidf: 0,
      bm25: t.bm25 || 0,
      docFrequency: t.doc_freq || 0,
      prominence: t.layer === 'awareness' ? 'first_paragraph' : '',
      usageRange: Array.isArray(t.uses) ? { min: t.uses[0], recommended: Math.round((t.uses[0] + t.uses[1]) / 2), max: t.uses[1] } : null,
    })),
    topicClusters: clusters.map((c) => ({
      topic: c.label,
      terms: c.terms || [],
      importance: 0,
      docFrequency: 0,
    })),
    subtopics: structure.map((s) => {
      const parts = (s.prevalence || '0/0').split('/').map(Number);
      return {
        label: (s.name || '').replace(/_/g, ' '),
        stemmedForm: '',
        variants: [],
        docFrequency: parts[0] || 0,
        docPercent: parts[1] > 0 ? parts[0] / parts[1] : 0,
      };
    }),
  };
}

// Curate competitors from discover candidates
function curateCompetitors(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((c) => ({
    url: c.url,
    title: c.title,
    position: c.best_position || 0,
    wordCount: 0,
    qualityScore: 0,
    keywords: c.keywords || [],
    selected: c.selected || false,
  }));
}

// Curate full content brief for frontend (snake_case → camelCase)
function curateContentBrief(brief) {
  if (!brief) return null;
  return {
    briefId: brief.brief_id || '',
    keyword: brief.keyword || '',
    createdAt: brief.created_at || null,
    archetype: brief.archetype || '',
    sophistication: brief.sophistication || '',
    audiences: brief.audiences || [],
    structure: (brief.structure || []).map((s) => ({
      id: s.id,
      name: s.name,
      priority: s.priority,
      words: s.words || [],
      prevalence: s.prevalence || '',
      paaMapped: s.paa_mapped || false,
      snippetTarget: s.snippet_target || false,
      source: s.source || '',
    })),
    serpAnalysis: brief.serp_analysis ? {
      featuredSnippet: brief.serp_analysis.featured_snippet || null,
      peopleAlsoAsk: brief.serp_analysis.people_also_ask || [],
    } : null,
    competitorStats: brief.competitor_stats || {},
    layerTargets: brief.layer_targets || {},
    gaps: brief.gaps ? {
      conceptGaps: (brief.gaps.concept_gaps || []).map((g) => ({
        id: g.id, concept: g.concept, coverage: g.coverage,
        score: g.score, terms: g.terms || [], angle: g.angle || '',
      })),
      layerGaps: (brief.gaps.layer_gaps || []).map((g) => ({
        id: g.id, layer: g.layer, current: g.current, target: g.target,
        score: g.score, terms: g.terms || [], angle: g.angle || '',
      })),
      paaGaps: (brief.gaps.paa_gaps || []).map((g) => ({
        id: g.id, question: g.question,
        answeredWellByCompetitors: g.answered_well_by_competitors,
        score: g.score, terms: g.terms || [], angle: g.angle || '',
      })),
    } : null,
    terms: (brief.terms || []).map((t) => ({
      term: t.term, score: t.score, centrality: t.centrality,
      type: t.type, layer: t.layer, section: t.section,
      uses: t.uses || [], cluster: t.cluster || '',
      source: t.source || '', gapRef: t.gap_ref || '',
      guidance: t.guidance || '', bm25: t.bm25 || 0,
      docFreq: t.doc_freq || 0, freq: t.freq || 0,
      volatile: t.volatile || false,
    })),
    clusters: (brief.clusters || []).map((c) => ({
      id: c.id, label: c.label, terms: c.terms || [],
    })),
    competitorWeaknesses: brief.competitor_weaknesses || [],
    pipelineCost: brief.pipeline_cost || 0,
  };
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

    // Extract selected URLs from discover candidates to feed into analyze
    const candidates = discoverData.candidates || [];
    const selectedUrls = candidates.filter((c) => c.selected).map((c) => c.url);

    // Step 2: Analyze (full pipeline — 5 min timeout to match engine)
    let contentBrief = {};
    try {
      const analyzeBody = { keywords };
      if (selectedUrls.length > 0) {
        analyzeBody.selected_urls = selectedUrls;
      }
      const analyzeRes = await fetch(`${ENGINE_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analyzeBody),
        signal: AbortSignal.timeout(300000),
      });
      if (analyzeRes.ok) {
        const analyzeData = await analyzeRes.json();
        contentBrief = analyzeData.content_brief || {};
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
      benchmark: curateBenchmark(contentBrief),
      intent: contentBrief.intent || null,
      competitors: curateCompetitors(candidates),
      contentBrief: curateContentBrief(contentBrief),
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
      contentBrief: content.contentBrief || null,
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
