const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const Site = require('../models/Site');
const tierService = require('../services/tierService');
const costLedger = require('../services/costLedgerService');
const creditService = require('../services/creditService');
const { tierToPreset } = require('../config/modelPreset');
const { engineFetch } = require('../services/analysisEngine');

// Workspace resolved by permissions middleware (req.workspace).
// This helper finds the content within that workspace.
async function resolveContent(req, res) {
  const { contentNumber } = req.params;
  const content = await Content.findByNumber(req.workspace._id, contentNumber);
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  // B4: locked content must not accept analysis/scoring ops or leak its data to
  // the engine/LLM. Same gate as contentController.getContent — closes the
  // analysis-route bypass (analyze/reanalyze/score-terms/import-url/etc.).
  if (content.locked) {
    res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });
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
    minWordCount: Math.round((stats.avg_word_count || 0) * 0.7),
    maxWordCount: Math.round((stats.avg_word_count || 0) * 1.3),
    avgH1Count: 1,
    avgH2Count: stats.avg_sections || 0,
    avgH3Count: stats.avg_h3_count || 0,
    avgInternalLinks: stats.avg_internal_links || 0,
    avgExternalLinks: stats.avg_external_links || 0,
    avgImages: stats.avg_images || 0,
    avgTitleLength: 0,
    avgDescLength: 0,
    avgKeywordDensity: stats.avg_keyword_density || 0,
    keywordInH2Rate: stats.keyword_in_h2_rate || 0,
    keywordInFirst100Rate: stats.keyword_in_first100_rate || 0,
    avgListCount: stats.avg_lists || 0,
    avgTableCount: stats.avg_tables || 0,
    avgFaqCount: stats.avg_faqs || 0,
    avgParagraphs: stats.avg_paragraphs || 0,
    avgSentenceLength: 0,
    avgReadingLevel: stats.avg_reading_level || 0,
    topNlpTerms: terms.map((t) => ({
      term: t.term,
      count: t.freq || t.doc_freq || 1,
      tfidf: 0,
      bm25: t.bm25 || 0,
      docFrequency: t.doc_freq || 0,
      prominence: t.section ? 'heading' : t.layer === 'awareness' ? 'first_paragraph' : '',
      usageRange: Array.isArray(t.uses) ? { min: Math.max(t.uses[0], 1), recommended: Math.max(Math.round((t.uses[0] + t.uses[1]) / 2), 2), max: Math.max(t.uses[1], t.uses[0] + 2, 3) } : null,
      category: t.section ? 'headings' : 'nlp',
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
    // Type-aware benchmark fields (engine Phases 2-3). contentType is the
    // declared page type whose lens shaped this brief; serpFormats is the
    // format census of the ranking pages; formatSignal is the strategic
    // advisory ("2 of 14 ranking pages are product pages — these are the
    // slots you compete for"). All optional — absent for briefs analyzed
    // without a declared type or by older engines.
    contentType: brief.content_type || '',
    serpFormats: brief.serp_formats ? {
      total: brief.serp_formats.total || 0,
      counts: brief.serp_formats.counts || {},
      declaredType: brief.serp_formats.declared_type || '',
      matchedLabels: brief.serp_formats.matched_labels || [],
      matchedCount: brief.serp_formats.matched_count || 0,
    } : null,
    formatSignal: brief.format_signal ? {
      kind: brief.format_signal.kind || '',
      message: brief.format_signal.message || '',
      matchedPages: (brief.format_signal.matched_pages || []).map((p) => ({
        url: p.url, title: p.title, position: p.position,
        format: p.format, wordCount: p.word_count,
      })),
    } : null,
    // Engine Phase 5: type-aware DESCRIPTIVE word-count band with provenance.
    // Replaces the pooled avg×0.7/×1.3 as the display truth when present
    // (commercial types' comparable pages run 4-6x shorter than the pooled
    // SERP average). Descriptive only — the score does not read it.
    wordCountBand: brief.word_count_band ? {
      min: brief.word_count_band.min || 0,
      max: brief.word_count_band.max || 0,
      source: brief.word_count_band.source || '',
      basis: brief.word_count_band.basis || '',
    } : null,
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

// Map engine ai_analysis.citation_formats (snake_case) → camelCase (engine
// Phase 4). NOTE: these fields ride the ANALYZE response's ai_analysis — the
// /api/ai-format-recommend response never carries them, so they are attached
// to aiFormatData separately (same pattern as citationAppearance), NOT read
// inside curateAiFormatData.
function curateCitationFormats(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    engine: c.engine || '',
    citedTotal: c.cited_total || 0,
    classified: c.classified || 0,
    counts: c.counts || {},
    matchedCount: c.matched_count || 0,
  }));
}

// Map engine citation_appearance (snake_case) → camelCase for the frontend.
function curateCitationAppearance(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    domain: c.domain || '',
    appearances: c.appearances || 0,
    samples: c.samples || 0,
    rate: c.rate || 0,
    exampleUrls: c.example_urls || [],
  }));
}

// Curate recommended outline from engine
function curateRecommendedOutline(raw) {
  if (!raw) return null;
  return {
    h1: raw.h1 || '',
    sections: (raw.sections || []).map((s) => ({
      h2: s.h2 || '',
      rationale: s.rationale || '',
      children: (s.children || []).map((c) => ({
        h3: c.h3 || '',
        rationale: c.rationale || '',
      })),
    })),
  };
}

// Convert curated camelCase structure back to snake_case for engine
function structureToSnakeCase(structure) {
  if (!Array.isArray(structure)) return [];
  return structure.map((s) => ({
    id: s.id,
    name: s.name,
    priority: s.priority,
    words: s.words || [],
    prevalence: s.prevalence || '',
    paa_mapped: s.paaMapped || false,
    snippet_target: s.snippetTarget || false,
    source: s.source || '',
  }));
}

// Convert curated camelCase terms back to snake_case for engine
function termsToSnakeCase(terms) {
  if (!Array.isArray(terms)) return [];
  return terms.map((t) => ({
    term: t.term,
    score: t.score,
    centrality: t.centrality,
    type: t.type,
    layer: t.layer,
    section: t.section,
    uses: t.uses || [],
    cluster: t.cluster || '',
    source: t.source || '',
    gap_ref: t.gapRef || '',
    guidance: t.guidance || '',
    bm25: t.bm25 || 0,
    doc_freq: t.docFreq || 0,
    freq: t.freq || 0,
    volatile: t.volatile || false,
  }));
}

// ─── ASYNC ANALYZE CLIENT (Phase E) ────────────────────────────

// analyzeViaEngine submits an async analyze job and polls for the result,
// falling back to the synchronous /api/analyze when the engine predates
// /api/analyze/jobs (404/405 — safe in either deploy order). The async path
// frees the held connection during the ~3-4 min pipeline: a job queued behind
// the engine's concurrency cap waits in the engine's memory instead of
// burning a connection deadline (the burn-test 502 failure mode).
//
// Returns a fetch-Response-shaped object ({ ok, status, json, text }) so the
// call site's handling is identical for both paths.
const JOB_POLL_MS = Number(process.env.ENGINE_JOB_POLL_MS) || 5000;
// Sized WITH the engine's queue bound: ENGINE_MAX_QUEUED_ANALYZE (12) ÷ 4
// concurrent × 5-min worst-case run = 15 min worst-case tail wait. Raise the
// two together or tail jobs will outlive their poller.
const JOB_POLL_BUDGET_MS = 15 * 60 * 1000;

async function analyzeViaEngine(analyzeBody, preset) {
  const submitRes = await engineFetch('/api/analyze/jobs', {
    body: analyzeBody,
    preset,
    timeoutMs: 30000,
  });
  if (submitRes.status === 404 || submitRes.status === 405) {
    // Old engine without the jobs API — synchronous fallback.
    return engineFetch('/api/analyze', { body: analyzeBody, preset, timeoutMs: 330000 });
  }
  if (!submitRes.ok) {
    return submitRes; // shed (503 queue full) etc. — caller reads status/text
  }
  const submit = await submitRes.json();
  const jobId = submit.job_id;
  if (!jobId) {
    return { ok: false, status: 502, text: async () => 'engine job submit returned no job_id' };
  }

  const deadline = Date.now() + JOB_POLL_BUDGET_MS;
  // A submit that is already done (engine cache hit) resolves on the first
  // poll; skip the initial sleep for it.
  let sleepFirst = submit.status !== 'done';
  while (Date.now() < deadline) {
    if (sleepFirst) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
    sleepFirst = true;
    let pollRes;
    try {
      pollRes = await engineFetch(`/api/analyze/jobs/${jobId}`, { method: 'GET', timeoutMs: 30000 });
    } catch {
      continue; // transient network blip — keep polling until the budget ends
    }
    if (pollRes.status === 404) {
      // Job lost to an engine restart — surface as a failed analysis (the
      // user-facing retry path resubmits from scratch).
      return { ok: false, status: 502, text: async () => 'engine analyze job lost (engine restarted); retry the analysis' };
    }
    if (!pollRes.ok) continue;
    const job = await pollRes.json();
    if (job.status === 'done') {
      return { ok: true, status: 200, json: async () => job.result };
    }
    if (job.status === 'failed') {
      return { ok: false, status: 502, text: async () => job.error || 'analyze job failed' };
    }
    // queued/running — keep polling
  }
  return { ok: false, status: 504, text: async () => 'engine analyze job did not finish within the polling budget' };
}

// ─── RUN ANALYSIS (background) ─────────────────────────────────

async function runAnalysis(contentId, opts = {}) {
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

    // Phase 4: resolve the org tier once → model preset for the engine pipeline
    // (Free → "budget" = flash-lite everywhere; paid → base). Reused below for
    // the analyze/outline X-Model-Preset header and for tagging the cost-ledger rows.
    let orgId = null;
    let tier = '';
    try {
      const wsTier = await Workspace.findById(content.workspaceId).select('organizationId').lean();
      orgId = wsTier?.organizationId || null;
      if (orgId) {
        const resolved = await tierService.getOrgTierConfig(orgId);
        tier = resolved?.tier || '';
      }
    } catch { /* best-effort — model selection falls back to base */ }
    const preset = tierToPreset(tier);

    // Step 1: Discover (SERP data, related searches, PAA, volumes)
    let discoverData = {};
    try {
      const discoverRes = await engineFetch('/api/discover', {
        body: { keywords },
        timeoutMs: 60000,
      });
      if (discoverRes.ok) {
        discoverData = await discoverRes.json();
      }
    } catch (err) {
      console.error('[analysis] discover failed:', err.message);
    }

    // Extract selected URLs from discover candidates to feed into analyze (cap at 5)
    const candidates = discoverData.candidates || [];
    const selectedUrls = candidates.filter((c) => c.selected).map((c) => c.url).slice(0, 5);

    // Step 2: Analyze (full pipeline — 5 min timeout to match engine)
    let contentBrief = {};
    let competitorPages = [];
    let analyzeData = {};
    try {
      const analyzeBody = { keywords };
      if (selectedUrls.length > 0) {
        analyzeBody.selected_urls = selectedUrls;
      }
      // Declared page type (wizard "Content Type" step) → engine lens on the
      // structure + guidance prompts. Absent/serp-based = engine default; the
      // engine normalizes and warns on unknown values, so forward verbatim.
      if (content.contentType) {
        analyzeBody.content_type = content.contentType;
      }
      // Explicit re-analysis must produce FRESH data: refresh bypasses the
      // engine's analyze-cache read (the run still updates the cache).
      if (opts.refresh) {
        analyzeBody.refresh = true;
      }
      // preset (if any) is merged into the body by engineFetch — the engine
      // reads the body `preset` field, not the X-Model-Preset header.
      // Phase E: async submit + poll, with sync fallback for old engines.
      const analyzeRes = await analyzeViaEngine(analyzeBody, preset);
      if (analyzeRes.ok) {
        analyzeData = await analyzeRes.json();
        contentBrief = analyzeData.content_brief || {};
        competitorPages = analyzeData.competitor_pages || [];

        // AI cost ledger (Phase 1): the Go engine returns a per-LLM-call
        // breakdown as pipeline_steps (step, model, prompt/completion tokens).
        // Record one row per call with the real model id + tokens. The engine
        // sends NO per-call cost (it has no pricing table), so each row is
        // priced from the backend model registry — a backend-ESTIMATED COGS,
        // not the engine's actual OpenRouter-billed amount. The `s.cost > 0`
        // override below is honored only if a future engine build starts
        // sending a cost. Fallback: pipeline_cost is a dormant aggregate path
        // for a hypothetical build that emits a lump cost but no steps; the
        // current engine emits neither, so that branch stays inert.
        try {
          // Engine cache hit (Phase D): the payload's pipeline_steps are the
          // ORIGINAL run's — that cost was recorded when the cache filled.
          // Re-recording it here would double-count COGS in the ledger.
          const steps = analyzeData.cache_hit
            ? []
            : (Array.isArray(analyzeData.pipeline_steps) ? analyzeData.pipeline_steps : []);
          const pipelineCost = analyzeData.cache_hit ? 0 : (Number(contentBrief.pipeline_cost) || 0);
          if (steps.length > 0 || pipelineCost > 0) {
            // orgId + tier resolved once at the top of runAnalysis (Phase 4).
            const base = {
              action: 'analyze',
              organizationId: orgId,
              workspaceId: content.workspaceId,
              tier,
            };
            if (steps.length > 0) {
              for (const s of steps) {
                // Trust the engine's cost only when it actually priced the call
                // (its own table can miss a model → cost 0). Otherwise leave the
                // override off so registry token pricing + unknownModel apply.
                const engineCost = Number(s.cost);
                costLedger.record({
                  ...base,
                  model: s.model,
                  tokensIn: s.prompt_tokens || 0,
                  tokensOut: s.completion_tokens || 0,
                  ...(Number.isFinite(engineCost) && engineCost > 0 && { costUsdOverride: engineCost }),
                  metadata: { contentId: content._id?.toString(), step: s.step },
                });
              }
            } else {
              costLedger.record({
                ...base,
                model: 'engine-pipeline',
                costUsdOverride: pipelineCost,
                metadata: { contentId: content._id?.toString(), keywords: keywords?.length || 0, aggregate: true },
              });
            }
          }
        } catch (e) {
          console.warn('[costLedger] analyze skipped:', e.message);
        }
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

    // AI conversations come from the analyze response (bare keyword + targeted prompts)
    const aiConversations = (analyzeData.conversations || []).map((c) => ({
      engine: c.engine || '',
      prompt: c.prompt || '',
      answer: c.answer || '',
      citations: c.citations || [],
      // Per-fanout citations are intentionally not persisted here: the Rec 3
      // appearance-rate signal already aggregates them engine-side and is
      // delivered via aiFormatData.citationAppearance. Add `citations: f.citations`
      // here if a future feature needs per-fanout sources round-tripped.
      fanout_queries: (c.fanout_queries || []).map((f) => ({
        query: f.query || '',
        answer: f.answer || '',
        engine: f.engine || '',
      })),
    }));
    if (aiConversations.length > 0) {
      console.log(`[analysis] received ${aiConversations.length} AI conversations`);
    }

    // AI Answer Analysis (v2 citability) — pass through from engine
    const aiAnswerAnalysis = analyzeData.ai_answer_analysis || null;
    if (aiAnswerAnalysis) {
      console.log(`[analysis] received AI answer analysis with ${(aiAnswerAnalysis.query_groups || []).length} query groups`);
    }


    // Per-URL crawl failures (SSRF block, timeout, 4xx, empty body). The engine
    // surfaces these so an operator can see WHY a requested competitor page is
    // missing from the benchmark; previously they were silently dropped.
    const crawlErrors = (Array.isArray(analyzeData.crawl_errors) ? analyzeData.crawl_errors : [])
      .map((e) => ({ url: e?.url || '', reason: e?.reason || '' }))
      .filter((e) => e.url || e.reason);
    if (crawlErrors.length > 0) {
      console.warn(
        `[analysis] ${crawlErrors.length} crawl error(s): ` +
          crawlErrors.map((e) => `${e.url} → ${e.reason}`).join('; ')
      );
    }

    // Steps 3+4: Run AI Format Recommend + Recommend Outline in PARALLEL
    let aiFormatData = null;
    let recommendedOutline = null;

    const [formatResult, outlineResult] = await Promise.allSettled([
      // Step 3: AI Format Recommend
      engineFetch('/api/ai-format-recommend', {
        body: { keywords },
        timeoutMs: 60000,
      }).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          console.log(`[analysis] ai-format-recommend returned ${(data.nlp_terms || []).length} NLP terms`);
          return data;
        }
        return null;
      }),
      // Step 4: Recommend Outline
      engineFetch('/api/recommend-outline', {
        preset,
        body: {
          keyword: keywords[0],
          competitor_pages: competitorPages,
          people_also_ask: discoverData.people_also_ask || [],
          related_searches: discoverData.related_searches || [],
          structure: contentBrief.structure || [],
          terms: (contentBrief.terms || []).slice(0, 15),
          ai_conversations: aiConversations,
        },
        timeoutMs: 60000,
      }).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          console.log(`[analysis] recommend-outline returned H1 + ${(data.sections || []).length} sections`);
          return data;
        }
        return null;
      }),
    ]);

    if (formatResult.status === 'fulfilled') {
      aiFormatData = formatResult.value;
    } else {
      console.error('[analysis] ai-format-recommend failed (non-fatal):', formatResult.reason?.message);
    }

    if (outlineResult.status === 'fulfilled') {
      recommendedOutline = outlineResult.value;
    } else {
      console.error('[analysis] recommend-outline failed (non-fatal):', outlineResult.reason?.message);
    }

    // Rec 3: the citation appearance-rate signal rides the analyze response's
    // `ai_analysis.citation_appearance` — the fanout-enriched path where an AI
    // answer's cited domains are sampled across the parent + fan-out queries.
    // NOTE: the current writing-engine `/analyze` does NOT run that citation
    // sampling (it generates a single simulated answer with no real citations),
    // so `ai_analysis` is absent and this resolves to []. The read is kept as a
    // forward-compatible passthrough for a future citation-sampling producer;
    // it is intentionally NOT synthesized from empty data. Until that pipeline
    // exists, aiFormatData.citationAppearance simply stays unset (the frontend
    // field is optional). Do not "fix" this by fabricating appearance rows.
    const curatedAiFormat = aiFormatData ? curateAiFormatData(aiFormatData) : null;
    const citationAppearance = curateCitationAppearance(analyzeData.ai_analysis?.citation_appearance);
    // Attach only when the format payload exists — never persist a partial
    // aiFormatData missing its required-shape fields. If ai-format-recommend
    // failed (curatedAiFormat null), the AI section is degraded anyway and we
    // keep aiFormatData honestly null rather than a citationAppearance-only stub.
    if (curatedAiFormat && citationAppearance.length > 0) {
      curatedAiFormat.citationAppearance = citationAppearance;
    }
    // Engine Phase 4 (type-aware benchmarks): the per-engine citation-format
    // census + advisory ALSO ride the analyze response's ai_analysis (the
    // ai-format-recommend response never carries them). Attached with the
    // same guard as citationAppearance: only onto an existing format payload.
    const citationFormats = curateCitationFormats(analyzeData.ai_analysis?.citation_formats);
    if (curatedAiFormat && citationFormats.length > 0) {
      curatedAiFormat.citationFormats = citationFormats;
      curatedAiFormat.citationFormatSignal = analyzeData.ai_analysis?.citation_format_signal || '';
    }

    // Step 5: Save curated results to DB
    const updates = {
      analysisStatus: 'ready',
      analysisError: '',
      analyzedAt: new Date(),
      driftDetected: null, // Rec 10: a fresh analysis clears any drift flag
      benchmark: curateBenchmark(contentBrief),
      intent: contentBrief.intent || null,
      competitors: curateCompetitors(candidates),
      contentBrief: curateContentBrief(contentBrief),
      relatedSearches: discoverData.related_searches || [],
      peopleAlsoAsk: discoverData.people_also_ask || [],
      keywordVolumes: discoverData.keyword_volumes || [],
      aiFormatData: curatedAiFormat,
      competitorPages: competitorPages.map((p) => ({
        url: p.url || '',
        title: p.title || '',
        position: p.position || 0,
        wordCount: p.word_count || 0,
        h1s: p.h1s || [],
        h2s: p.h2s || [],
        h3s: p.h3s || [],
        h4s: p.h4s || [],
      })),
      recommendedOutline: curateRecommendedOutline(recommendedOutline),
      aiConversations,
      aiAnswerAnalysis,
      crawlErrors,
    };

    await Content.findByIdAndUpdate(contentId, { $set: updates });
    console.log(`[analysis] completed for content ${contentId}`);

    // Rec 14: snapshot the outcome baseline at every successful (re)analysis —
    // the first analysis captures "before", each reanalysis an "after" point.
    // Best-effort: an outcome hiccup must never fail the analysis itself.
    try {
      const outcomeService = require('../services/outcomeService');
      const snapDoc = await Content.findById(contentId)
        .select('score targetKeywords trackedPrompts workspaceId publishedUrl').lean();
      if (snapDoc) await outcomeService.snapshotContent(snapDoc, { source: 'reanalyze' });
    } catch (e) {
      console.error('[analysis] outcome snapshot failed (non-fatal):', e.message);
    }

    // Phase 6: charge re-score (10) ONLY on a fully successful re-analysis. This
    // line is reached only when the whole pipeline succeeded — every failure path
    // (no keywords, engine unreachable, parse error) returns/throws early to
    // 'failed' above and never gets here, so an outage or a zero-keyword re-run
    // is NOT billed (review MAJOR: the prior charge-at-trigger billed those).
    // opts.bill is set only by reanalyze; the free initial /analyze passes nothing.
    // chargeAction re-resolves tier/flag + affordability and is orphan-sweep safe.
    if (opts.bill) {
      const charge = await creditService.chargeAction(opts.bill.action, {
        orgId,
        userId: opts.bill.userId,
        workspaceId: content.workspaceId,
        metadata: { contentId: contentId.toString(), reScore: true },
      });
      console.log(`[analysis] re-score charged ${charge.deducted} (${charge.reason}) for ${contentId}`);
    }

    // Phase 2 / Task #100: push the freshly-computed brief into any
    // engine session currently open for this content. Lazy-require avoids
    // a controller-controller import cycle at module load.
    try {
      const { resyncBriefIfActive } = require('./aiController');
      const synced = await resyncBriefIfActive(contentId);
      if (synced) {
        console.log(`[analysis] resynced brief to active engine session for ${contentId}`);
      }
    } catch (resyncErr) {
      console.error('[analysis] brief resync failed (non-fatal):', resyncErr.message);
    }
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

    // Track audit usage before starting analysis
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

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

    // Rec 11: keyword-tracking trend (additive — key absent when the content
    // isn't tracking, so untracked responses stay byte-identical). Series
    // failures degrade to an empty series, never break the benchmark.
    let tracking;
    if (Array.isArray(content.trackedPrompts) && content.trackedPrompts.length > 0) {
      try {
        const { getScanSeriesForPrompts } = require('../services/trackerSeriesService');
        const { series, lastScanAt } = await getScanSeriesForPrompts(req.workspace._id, content.trackedPrompts, 30);
        tracking = { enabled: true, prompts: content.trackedPrompts, lastScanAt, series };
      } catch (e) {
        console.error('getBenchmark tracking series failed:', e.message);
        tracking = { enabled: true, prompts: content.trackedPrompts, lastScanAt: null, series: [] };
      }
    }

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
      competitorPages: content.competitorPages || [],
      recommendedOutline: content.recommendedOutline || null,
      aiConversations: content.aiConversations || [],
      aiAnswerAnalysis: content.aiAnswerAnalysis || null,
      driftDetected: content.driftDetected || null, // Rec 10
      ...(tracking ? { tracking } : {}), // Rec 11 (additive)
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

    // Track audit usage before starting re-analysis (re-analysis consumes the
    // same monthly audit pool as first analysis — mirrors triggerAnalysis).
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

    // Fire-and-forget. Phase 6: re-score (10) is charged INSIDE runAnalysis, on
    // success only (see its success hook) — NOT here at trigger — so an engine
    // outage or a zero-keyword content never bills. The rc('reScore') route gate
    // already ran the pre-flight 402, so the user had the credits when they asked.
    // refresh: an explicit re-analysis must bypass the engine's analyze-cache
    // read — the user is paying for fresh data, not a cached replay.
    runAnalysis(content._id, { bill: { action: 'reScore', userId: req.user?.userId }, refresh: true });

    res.json({ analysisStatus: 'pending', message: 'Re-analysis started' });
  } catch (err) {
    console.error('reanalyze error:', err.message);
    res.status(500).json({ error: 'Failed to trigger re-analysis' });
  }
};

// ─── POST /:contentNumber/score — compute score from saved benchmark ───

// Rec 13 Phase B: fetch engine-canonical NLP term counts for scoring. The
// engine counts with the exact tokenizer/stemmer that built the benchmark
// usage ranges (the JS stemmer diverges on inflections and CJK boundaries —
// see tests/fixtures/scoring/DIVERGENCE.md). Returns a lowercased-term →
// count map, or null on ANY failure so callers fall back to the unchanged
// internal counting.
// ─── POST /:contentNumber/score-terms — engine-canonical term counting ───
// Proxies to the Go engine's /api/score so term counts use the exact
// tokenizer/stemmer that built the benchmark usage ranges. The editor's
// local regex counting misses inflected forms ("credit card" vs "credit
// cards") and over-matches short terms inside longer words ("ai" in
// "maintain"); the engine is the single source of truth for counts.

const scoreTerms = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { content: draftText, terms } = req.body;
    if (!draftText || typeof draftText !== 'string') {
      return res.status(400).json({ error: 'content (draft text) is required' });
    }
    if (!Array.isArray(terms) || terms.length === 0) {
      return res.status(400).json({ error: 'terms are required' });
    }
    if (terms.length > 500) {
      return res.status(400).json({ error: 'maximum 500 terms' });
    }

    const engineRes = await engineFetch('/api/score', {
      body: {
        keyword: (content.targetKeywords && content.targetKeywords[0]) || '',
        content: draftText,
        terms,
      },
      timeoutMs: 15000, // scoring is sub-second; don't hang on a stuck engine
    });
    if (!engineRes.ok) {
      const text = await engineRes.text();
      console.error('scoreTerms engine error:', engineRes.status, text.slice(0, 200));
      return res.status(502).json({ error: 'Engine scoring unavailable' });
    }
    res.json(await engineRes.json());
  } catch (err) {
    // Distinguish infrastructure failures from controller bugs so callers
    // and logs can tell a stuck/down engine apart from a 500.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('scoreTerms: engine timed out');
      return res.status(504).json({ error: 'Engine scoring timed out' });
    }
    if (err instanceof TypeError) {
      console.error('scoreTerms: engine unreachable:', err.message);
      return res.status(502).json({ error: 'Engine scoring unavailable' });
    }
    console.error('scoreTerms error:', err.message);
    res.status(500).json({ error: 'Failed to score terms' });
  }
};

// ─── POST /:contentNumber/import-url — fetch a page for content import ───
// Proxies to the Go engine's /api/fetch-page, which fetches the URL
// directly and falls back to the external fetch service (Scrappey) when the
// page blocks plain HTTP. Returns the main content area as HTML; the editor
// converts it to blocks client-side (htmlToBlocks).

const importUrl = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'url is required' });
    }

    const engineRes = await engineFetch('/api/fetch-page', {
      body: { url: url.trim() },
      // Scrappey fallback for protected pages can take a while.
      timeoutMs: 95000,
    });
    const body = await engineRes.text();
    if (!engineRes.ok) {
      let message = 'Failed to fetch page';
      try { message = JSON.parse(body).error || message; } catch { /* non-JSON upstream body */ }
      console.error('importUrl engine error:', engineRes.status, body.slice(0, 200));
      return res.status(engineRes.status === 400 ? 400 : 502).json({ error: message });
    }
    // Parse BEFORE charging so a non-JSON 2xx body throws (→ 500) without billing
    // (review MINOR). Phase 6: charge import (5, Scrappey infra) on success only.
    const parsed = JSON.parse(body);
    await creditService.deductForRequest(req, { metadata: { contentId: content._id.toString() } });
    res.json(parsed);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('importUrl: engine timed out');
      return res.status(504).json({ error: 'Page fetch timed out' });
    }
    if (err instanceof TypeError) {
      console.error('importUrl: engine unreachable:', err.message);
      return res.status(502).json({ error: 'Fetch service unavailable' });
    }
    console.error('importUrl error:', err.message);
    res.status(500).json({ error: 'Failed to import page' });
  }
};

// ─── POST /:contentNumber/internal-links — suggest internal links ───
// Assembles the internal-link inventory from the sitemap crawl
// (buildAvailableLinks) server-side, then asks the Go engine to find where
// each page's topic appears in the draft and propose an anchor + placement.
// The draft sections come from the request (unsaved editor state).

const internalLinks = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { sections, max_suggestions } = req.body;
    if (!Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'sections are required' });
    }

    const { benchmarkToContentBrief, buildAvailableLinks } = require('../services/benchmarkToContentBrief');
    const brief = benchmarkToContentBrief(content);
    const links = await buildAvailableLinks(
      content.workspaceId || req.workspace._id,
      brief.targetKeyword,
      brief.secondaryKeywords,
    );
    // No completed sitemap crawl → no inventory → nothing to suggest.
    if (!links.length) {
      return res.json({ suggestions: [], count: 0, reason: 'no_sitemap' });
    }

    const engineRes = await engineFetch('/api/internal-links', {
      body: {
        sections,
        links: links.map((l) => ({ url: l.url, title: l.title, relevance: l.relevance })),
        max_suggestions: max_suggestions || undefined,
      },
      timeoutMs: 20000,
    });
    const body = await engineRes.text();
    if (!engineRes.ok) {
      let message = 'Failed to suggest internal links';
      try { message = JSON.parse(body).error || message; } catch { /* non-JSON */ }
      console.error('internalLinks engine error:', engineRes.status, body.slice(0, 200));
      return res.status(engineRes.status === 400 ? 400 : 502).json({ error: message });
    }
    // Parse BEFORE charging so a non-JSON 2xx body throws (→ 500) without billing
    // (review MINOR). Phase 6: charge the internal-link run (10, infra) only when
    // the engine actually ran — the no-sitemap early return above bills nothing.
    const parsed = JSON.parse(body);
    await creditService.deductForRequest(req, { metadata: { contentId: content._id.toString() } });
    res.json(parsed);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Internal-link suggestion timed out' });
    }
    if (err instanceof TypeError) {
      return res.status(502).json({ error: 'Engine unavailable' });
    }
    console.error('internalLinks error:', err.message);
    res.status(500).json({ error: 'Failed to suggest internal links' });
  }
};

// ─── POST /:contentNumber/readability-check — run AI readability check ───

const readabilityCheck = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const { keyword, contentText, headings, aiAnswers, intent, archetype } = req.body;
    if (!keyword || !contentText) {
      return res.status(400).json({ error: 'keyword and contentText are required' });
    }

    const engineRes = await engineFetch('/api/readability-check', {
      body: {
        keyword,
        content: contentText,
        headings: headings || [],
        ai_answers: aiAnswers || [],
        intent: intent || '',
        archetype: archetype || '',
      },
      timeoutMs: 60000,
    });

    if (!engineRes.ok) {
      const errBody = await engineRes.text();
      console.error(`[readability-check] engine returned ${engineRes.status}: ${errBody}`);
      return res.status(engineRes.status).json({ error: 'Readability check failed' });
    }

    const result = await engineRes.json();
    res.json(result);
  } catch (err) {
    console.error('readabilityCheck error:', err.message);
    res.status(500).json({ error: 'Failed to run readability check' });
  }
};

// ─── POST /:contentNumber/regenerate-outline — re-run outline only (~5s) ───

const regenerateOutline = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    if (!content.benchmark) {
      return res.status(400).json({ error: 'No analysis data. Run analysis first.' });
    }

    const keyword = (content.benchmark.keywords && content.benchmark.keywords[0]) || '';
    const competitorPages = (content.competitorPages || []).map((p) => ({
      url: p.url || '',
      title: p.title || '',
      position: p.position || 0,
      word_count: p.wordCount || 0,
      h1s: p.h1s || [],
      h2s: p.h2s || [],
      h3s: p.h3s || [],
      h4s: p.h4s || [],
    }));

    // Phase 4: Free tier → budget model for the regenerated outline too (parity
    // with runAnalysis; otherwise this live Free path leaks base-model COGS).
    let preset = '';
    try {
      const wsTier = await Workspace.findById(content.workspaceId).select('organizationId').lean();
      if (wsTier?.organizationId) {
        const tier = (await tierService.getOrgTierConfig(wsTier.organizationId))?.tier || '';
        preset = tierToPreset(tier);
      }
    } catch { /* best-effort — falls back to base */ }

    const outlineRes = await engineFetch('/api/recommend-outline', {
      preset,
      body: {
        keyword,
        competitor_pages: competitorPages,
        people_also_ask: (content.peopleAlsoAsk || []).slice(0, 5),
        related_searches: (content.relatedSearches || []).slice(0, 5),
        structure: structureToSnakeCase((content.contentBrief && content.contentBrief.structure) || []),
        terms: termsToSnakeCase(((content.contentBrief && content.contentBrief.terms) || []).slice(0, 15)),
        ai_conversations: (content.aiConversations || []).slice(0, 3),
      },
      timeoutMs: 30000,
    });

    if (!outlineRes.ok) {
      const errBody = await outlineRes.text();
      console.error(`[regenerate-outline] engine returned ${outlineRes.status}: ${errBody}`);
      return res.status(outlineRes.status).json({ error: 'Outline generation failed' });
    }

    const raw = await outlineRes.json();
    const curated = curateRecommendedOutline(raw);

    // Phase 6: charge brief/outline (20) only on a successful regeneration. The
    // mandatory initial /analyze is NOT charged (product decision) — this
    // discretionary re-run is. Free draws from the 200 sample pool.
    await creditService.deductForRequest(req, { metadata: { contentId: content._id.toString() } });

    // Persist to DB
    await Content.findByIdAndUpdate(content._id, { $set: { recommendedOutline: curated } });

    console.log(`[regenerate-outline] new outline: H1 + ${(curated?.sections || []).length} sections`);
    res.json(curated);
  } catch (err) {
    console.error('regenerateOutline error:', err.message);
    res.status(500).json({ error: 'Failed to regenerate outline' });
  }
};

// ─── GET /:workspaceNumber/site/bot-access — AI crawler access audit (Rec 7) ───
// Deterministic robots.txt + CDN dual-UA check via the engine. The report is
// cached on the Site for 7 days; ?refresh=1 forces a live re-check.
const BOT_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Curate the engine's snake_case bot-access report into the camelCase shape
// the rest of the API returns. Presentation-only: the raw engine report is what
// we persist on the Site (storage stays engine-native), so this runs at the
// output boundary for BOTH the fresh and cached paths — no migration of
// previously cached reports is needed.
function curateBotAccess(report) {
  if (!report) return null;
  return {
    robotsUrl: report.robots_url,
    robotsStatus: report.robots_status,
    verdicts: (report.verdicts || []).map((v) => ({
      bot: v.bot,
      allowed: v.allowed,
      source: v.source,
    })),
    ...(report.cdn_block && {
      cdnBlock: {
        normalStatus: report.cdn_block.normal_status,
        botUaStatus: report.cdn_block.bot_ua_status,
        blocked: report.cdn_block.blocked,
      },
    }),
    guidance: report.guidance || [],
  };
}

const getBotAccess = async (req, res) => {
  try {
    const site = await Site.findOne({ workspaceId: req.workspace._id, url: { $nin: [null, ''] } });
    if (!site) return res.status(404).json({ error: 'No site configured for this workspace' });

    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!refresh && site.botAccess && site.botAccessCheckedAt
        && (Date.now() - new Date(site.botAccessCheckedAt).getTime()) < BOT_ACCESS_TTL_MS) {
      return res.json({ botAccess: curateBotAccess(site.botAccess), checkedAt: site.botAccessCheckedAt, cached: true });
    }

    const engineRes = await engineFetch('/api/bot-access', {
      body: { url: site.url },
      timeoutMs: 25000, // engine worst case ≈20s (robots 10s + parallel probes 10s) + headroom
    });
    if (!engineRes.ok) {
      const text = await engineRes.text();
      console.error('getBotAccess engine error:', engineRes.status, text.slice(0, 200));
      return res.status(engineRes.status === 400 ? 400 : 502).json({ error: 'Bot access check unavailable' });
    }
    const report = await engineRes.json();

    site.botAccess = report;
    site.botAccessCheckedAt = new Date();
    site.markModified('botAccess'); // Mixed path — be explicit
    await site.save();

    res.json({ botAccess: curateBotAccess(report), checkedAt: site.botAccessCheckedAt, cached: false });
  } catch (err) {
    // Same infrastructure/bug split as scoreTerms: stuck engine → 504,
    // unreachable engine → 502, anything else → 500.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('getBotAccess: engine timed out');
      return res.status(504).json({ error: 'Bot access check timed out' });
    }
    if (err instanceof TypeError) {
      console.error('getBotAccess: engine unreachable:', err.message);
      return res.status(502).json({ error: 'Bot access check unavailable' });
    }
    console.error('getBotAccess error:', err.message);
    res.status(500).json({ error: 'Failed to check bot access' });
  }
};

// ─── GET /:workspaceNumber/content/:contentNumber/outcomes (Rec 14) ─────────
// Time-ordered outcome snapshots + first-vs-latest deltas for the editor's
// Results panel. Read-only Mongo query — no engine/GSC calls at request time.
const getOutcomes = async (req, res) => {
  try {
    const content = await resolveContent(req, res);
    if (!content) return;

    const outcomeService = require('../services/outcomeService');
    const series = await outcomeService.getOutcomeSeries(content._id, 180);
    res.json({ series, delta: outcomeService.computeDelta(series) });
  } catch (err) {
    console.error('getOutcomes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch outcomes' });
  }
};

module.exports = {
  triggerAnalysis, getBenchmark, reanalyze, runAnalysis, scoreTerms, importUrl,
  internalLinks, readabilityCheck, regenerateOutline, curateCitationAppearance,
  getBotAccess, getOutcomes,
  // Exported for the camelCase-boundary invariant test (tests/curationCamelCase.test.js).
  // These map engine snake_case → the API's camelCase contract; a forgotten
  // remap is exactly the bot-access leak the test guards against.
  _curators: {
    curateBenchmark, curateCompetitors, curateContentBrief, curateAiFormatData,
    curateCitationAppearance, curateCitationFormats, curateRecommendedOutline, curateBotAccess,
  },
};
