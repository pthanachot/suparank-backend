/**
 * Map Suparank's MongoDB benchmark data to the Writing Engine's ContentBrief format.
 *
 * Suparank stores competitive analysis in MongoDB (from the Go engine pipeline).
 * The Writing Engine expects a ContentBrief (defined in seo/brief.go).
 * This function bridges the two schemas.
 *
 * @param {Object} content - MongoDB Content document (with benchmark, intent, etc.)
 * @returns {Object} ContentBrief for the Writing Engine
 */
function benchmarkToContentBrief(content) {
  const benchmark = content.benchmark || {};
  const intent = content.intent || {};
  const competitorPages = content.competitorPages || [];
  const peopleAlsoAsk = content.peopleAlsoAsk || [];
  const recommendedOutline = content.recommendedOutline || {};
  const keywords = benchmark.keywords || content.targetKeywords || [];

  const brief = {
    // Core targeting
    targetKeyword: keywords[0] || '',
    secondaryKeywords: keywords.slice(1),
    targetDensity: benchmark.avgKeywordDensity || 1.5,
    searchIntent: intent.primary || 'informational',

    // Content structure
    targetWordCount: content.targetWordCount || benchmark.avgWordCount || 2000,
    serpQuestions: extractSerpQuestions(peopleAlsoAsk),
    competitorHeadings: extractCompetitorHeadings(competitorPages),
    suggestedOutline: extractSuggestedOutline(recommendedOutline),

    // Content type — prefer user's wizard selection over inferred intent
    contentType: content.contentType || mapContentType(intent),

    // User instructions from wizard step 3
    authorContext: content.contentContext || '',

    // Top NLP terms the content should include. Each term gets a
    // recommendedSection tag (Phase 2 / Task #99) derived from topic-cluster
    // membership — frontend groups terms by section so writers see "this
    // section needs these terms" instead of one flat 30-item list.
    nlpTerms: extractNlpTerms(benchmark, benchmark.topicClusters),

    // Benchmark averages for competitive scoring (mirrors frontend BenchmarkData)
    benchmarkAverages: {
      wordCount: benchmark.avgWordCount || 2000,
      h2Count: benchmark.avgH2Count || 6,
      h3Count: benchmark.avgH3Count || 4,
      images: benchmark.avgImages || 3,
      listCount: benchmark.avgListCount || 1,
      tableCount: benchmark.avgTableCount || 0,
      faqCount: benchmark.avgFaqCount || 0,
      paragraphs: benchmark.avgParagraphs || 20,
      keywordDensity: benchmark.avgKeywordDensity || 1.5,
      readingLevel: benchmark.avgReadingLevel || 60,
      keywordInH2Rate: benchmark.keywordInH2Rate || 0,
      keywordInFirst100Rate: benchmark.keywordInFirst100Rate || 0,
      pageCount: benchmark.pageCount || 0,
    },

    // Topic clusters and subtopics for coverage scoring
    topicClusters: (benchmark.topicClusters || []).map((c) => ({
      label: c.topic || c.label || '',
      terms: c.terms || [],
      docFrequency: c.docFrequency || 0,
    })),
    subtopics: (benchmark.subtopics || []).map((s) => ({
      label: s.label || '',
      docFrequency: s.docFrequency || 0,
      docPercent: s.docPercent || 0,
    })),
  };

  return brief;
}


/**
 * Extract SERP "People Also Ask" questions.
 * @param {Array} paa - peopleAlsoAsk array from MongoDB
 * @returns {string[]}
 */
function extractSerpQuestions(paa) {
  if (!Array.isArray(paa)) return [];
  return paa
    .map((item) => item.question || item.query || '')
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Extract unique H2 headings from competitor pages.
 * @param {Array} pages - competitorPages from MongoDB
 * @returns {string[]}
 */
function extractCompetitorHeadings(pages) {
  if (!Array.isArray(pages)) return [];
  const seen = new Set();
  const headings = [];
  pages.forEach((page) => {
    const h2s = page.h2s || [];
    h2s.forEach((h) => {
      const norm = h.toLowerCase().trim();
      if (!seen.has(norm)) {
        seen.add(norm);
        headings.push(h);
      }
    });
  });
  return headings.slice(0, 20);
}

/**
 * Extract suggested outline headings from recommendedOutline.
 * @param {Object} outline - { h1: string, sections: [{ h2, children: [{ h3 }] }] }
 * @returns {string[]}
 */
function extractSuggestedOutline(outline) {
  if (!outline || !outline.sections) return [];
  return outline.sections.map((s) => s.h2).filter(Boolean);
}

/**
 * Extract top NLP terms from benchmark for the Writing Engine.
 *
 * Phase 2 / Task #99: each term is tagged with `recommendedSection` —
 * the topic cluster it belongs to. Frontend uses this to group terms in
 * the sidebar gauge so writers see "Section X needs these terms" instead
 * of one flat 30-item list. Terms not appearing in any cluster get an
 * empty recommendedSection (rendered as the "General" bucket).
 *
 * @param {Object} benchmark
 * @param {Array} topicClusters - clusters array (each { topic|label, terms[] })
 * @returns {Array<{term, min, max, category, recommendedSection}>}
 */
function extractNlpTerms(benchmark, topicClusters) {
  const terms = benchmark.topNlpTerms || [];
  if (!Array.isArray(terms)) return [];

  // Build term → cluster-label map. Lowercased for case-insensitive lookup;
  // a term that appears in multiple clusters takes its first appearance
  // (clusters are already ranked by docFrequency upstream).
  const termToCluster = new Map();
  if (Array.isArray(topicClusters)) {
    for (const c of topicClusters) {
      const label = c.topic || c.label || '';
      if (!label) continue;
      const clusterTerms = Array.isArray(c.terms) ? c.terms : [];
      for (const t of clusterTerms) {
        const key = String(t || '').toLowerCase().trim();
        if (key && !termToCluster.has(key)) {
          termToCluster.set(key, label);
        }
      }
    }
  }

  return terms
    .slice(0, 30)
    .filter((t) => t.term)
    .map((t) => {
      const lookupKey = String(t.term).toLowerCase().trim();
      const recommendedSection = termToCluster.get(lookupKey) || '';
      return {
        term: t.term,
        min: t.usageRange?.min ?? 1,
        max: t.usageRange?.max ?? Math.max(t.count || 1, 5),
        category: t.category || 'nlp',
        recommendedSection,
      };
    });
}

/**
 * Map Suparank intent to a content type string.
 * @param {Object} intent - { primary, sophistication, decisionStage }
 * @returns {string}
 */
function mapContentType(intent) {
  const primary = (intent.primary || '').toLowerCase();
  switch (primary) {
    case 'informational': return 'guide';
    case 'commercial': return 'comparison';
    case 'transactional': return 'review';
    case 'navigational': return 'guide';
    default: return 'guide';
  }
}

module.exports = { benchmarkToContentBrief };
