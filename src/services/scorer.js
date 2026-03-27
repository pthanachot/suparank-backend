const { parseHTML, stripTags, extractTagContents, extractExactTag } = require('./htmlParser');
const { stemPhrase, buildStemmedNGrams, tokenize, stem } = require('./stemmer');

// Base weights matching Go engine scorer
const BASE_WEIGHTS = {
  'Word Count': 14,
  'H2 Headings': 4,
  'H3 Headings': 3,
  'Keyword in Title': 8,
  'Keyword in H1': 6,
  'Keyword in H2': 5,
  'Keyword in First 100': 4,
  'Keyword Density': 3,
  'Images': 3,
  'Internal Links': 3,
  'External Links': 3,
  'Lists': 3,
  'Tables': 2,
  'FAQ': 2,
  'NLP Term Coverage': 17,
  'Topic Coverage': 6,
  'Subtopic Coverage': 9,
  'Term Prominence': 4,
  'Reading Level': 3,
};

function rangeScore(actual, target, tolerance) {
  if (target === 0) return actual === 0 ? [100, 'good'] : [50, 'needs_work'];
  const ratio = actual / target;
  const diff = Math.abs(1 - ratio);
  if (diff <= tolerance) return [100, 'good'];
  if (diff <= tolerance * 2) {
    const score = Math.max(0, Math.round(100 - (diff - tolerance) * 200));
    return [score, 'needs_work'];
  }
  return [Math.max(0, Math.round(100 - diff * 100)), 'poor'];
}

function priority(score) {
  if (score < 30) return 'high';
  if (score < 60) return 'medium';
  return 'low';
}

function analyzeKeywordPlacement(page, keyword) {
  if (!keyword) {
    return { inTitle: false, inH1: false, inH2: false, inMetaDescription: false, inFirst100: false, exactCount: 0, density: 0 };
  }
  const kw = keyword.toLowerCase();
  const bodyLower = page.bodyText.toLowerCase();
  const words = bodyLower.split(/\s+/);
  const first100 = words.slice(0, 100).join(' ');
  const wordCount = page.wordCount || words.length;
  const kwCount = (bodyLower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

  return {
    inTitle: page.title.toLowerCase().includes(kw),
    inH1: page.h1s.some((h) => h.toLowerCase().includes(kw)),
    inH2: page.h2s.some((h) => h.toLowerCase().includes(kw)),
    inMetaDescription: page.metaDescription.toLowerCase().includes(kw),
    inFirst100: first100.includes(kw),
    exactCount: kwCount,
    density: wordCount > 0 ? (kwCount / wordCount) * 100 : 0,
  };
}

function buildProminenceMap(htmlContent) {
  const lower = htmlContent.toLowerCase();
  const result = {};

  let headingText = '';
  for (const tag of ['h1', 'h2', 'h3', 'h4']) {
    for (const content of extractTagContents(lower, tag)) headingText += ' ' + content;
  }

  let boldText = '';
  for (const content of extractTagContents(lower, 'strong')) boldText += ' ' + content;
  for (const content of extractExactTag(lower, 'b')) boldText += ' ' + content;

  const bodyText = stripTags(htmlContent);
  const bodyWords = bodyText.split(/\s+/).filter(Boolean);
  const firstParaCount = Math.min(200, bodyWords.length);
  const firstParaText = bodyWords.slice(0, firstParaCount).join(' ');

  const headingGrams = buildStemmedNGrams(headingText, 3);
  const boldGrams = buildStemmedNGrams(boldText, 3);
  const firstParaGrams = buildStemmedNGrams(firstParaText, 3);

  const allStems = new Set([...Object.keys(headingGrams), ...Object.keys(boldGrams), ...Object.keys(firstParaGrams)]);
  for (const s of allStems) {
    result[s] = {
      inHeading: (headingGrams[s] || 0) > 0,
      inBold: (boldGrams[s] || 0) > 0,
      inFirstParagraph: (firstParaGrams[s] || 0) > 0,
    };
  }
  return result;
}

/**
 * Score user HTML content against a saved benchmark.
 * @param {string} htmlContent - User's HTML content
 * @param {string} keyword - Primary target keyword
 * @param {object} benchmark - Saved benchmark from DB (camelCase fields)
 * @param {object|null} intent - Saved intent classification from DB
 * @param {object|null} aiFormatData - AI format recommend data (enriched NLP terms)
 * @returns {object} Score result matching Go engine's ContentScore shape
 */
function scoreContent(htmlContent, keyword, benchmark, intent, aiFormatData) {
  if (!benchmark) {
    return { overallScore: 0, signals: [], recommendations: [{ priority: 'high', message: 'No benchmark data. Run analysis first.' }] };
  }

  const isHTML = htmlContent.includes('<');
  const page = isHTML ? parseHTML(htmlContent) : {
    title: '', metaDescription: '', h1s: [], h2s: [], h3s: [], h4s: [],
    bodyText: htmlContent, wordCount: htmlContent.split(/\s+/).filter(Boolean).length,
    imageCount: 0, internalLinks: 0, externalLinks: 0,
    listCount: 0, tableCount: 0, faqCount: 0,
  };

  const kwMetrics = analyzeKeywordPlacement(page, keyword);
  const userNGrams = buildStemmedNGrams(isHTML ? page.bodyText : htmlContent, 3);
  const prominenceMap = isHTML ? buildProminenceMap(htmlContent) : null;

  const signals = [];
  const recs = [];

  // 1. Word Count
  const [wcScore, wcStatus] = rangeScore(page.wordCount, benchmark.avgWordCount, 0.3);
  signals.push({ signal: 'Word Count', yourValue: page.wordCount, avgValue: benchmark.avgWordCount, score: wcScore, status: wcStatus });
  if (wcStatus !== 'good') {
    const diff = Math.round(benchmark.avgWordCount) - page.wordCount;
    if (diff > 0) recs.push({ priority: priority(wcScore), message: `Add approximately ${diff} more words. Top pages average ${Math.round(benchmark.avgWordCount)} words.` });
    else recs.push({ priority: 'low', message: `Your content is longer than average (${Math.round(benchmark.avgWordCount)} words). Consider tightening.` });
  }

  // 2. H2 Headings
  const [h2Score, h2Status] = rangeScore(page.h2s.length, benchmark.avgH2Count, 0.4);
  signals.push({ signal: 'H2 Headings', yourValue: page.h2s.length, avgValue: benchmark.avgH2Count, score: h2Score, status: h2Status });
  if (h2Status !== 'good') recs.push({ priority: priority(h2Score), message: `Use around ${Math.round(benchmark.avgH2Count)} H2 headings. You currently have ${page.h2s.length}.` });

  // 3. H3 Headings
  const [h3Score, h3Status] = rangeScore(page.h3s.length, benchmark.avgH3Count, 0.5);
  signals.push({ signal: 'H3 Headings', yourValue: page.h3s.length, avgValue: benchmark.avgH3Count, score: h3Score, status: h3Status });
  if (h3Status !== 'good' && page.h3s.length < benchmark.avgH3Count) recs.push({ priority: priority(h3Score), message: `Use around ${Math.round(benchmark.avgH3Count)} H3 subheadings. You currently have ${page.h3s.length}.` });

  // 4. Keyword in Title
  const titleScore = kwMetrics.inTitle ? 100 : 0;
  signals.push({ signal: 'Keyword in Title', yourValue: kwMetrics.inTitle ? 1 : 0, avgValue: 1, score: titleScore, status: kwMetrics.inTitle ? 'good' : 'poor' });
  if (!kwMetrics.inTitle) recs.push({ priority: 'high', message: `Include "${keyword}" in your page title.` });

  // 5. Keyword in H1
  const h1Score = kwMetrics.inH1 ? 100 : 0;
  signals.push({ signal: 'Keyword in H1', yourValue: kwMetrics.inH1 ? 1 : 0, avgValue: 1, score: h1Score, status: kwMetrics.inH1 ? 'good' : 'poor' });
  if (!kwMetrics.inH1) recs.push({ priority: 'high', message: `Include "${keyword}" in your H1 heading.` });

  // 6. Keyword in H2
  const h2Rate = benchmark.keywordInH2Rate || 0;
  let kwH2Score = 0, kwH2Status = 'poor';
  if (kwMetrics.inH2) { kwH2Score = 100; kwH2Status = 'good'; }
  else if (h2Rate < 0.3) { kwH2Score = 60; kwH2Status = 'needs_work'; }
  signals.push({ signal: 'Keyword in H2', yourValue: kwMetrics.inH2 ? 1 : 0, avgValue: h2Rate, score: kwH2Score, status: kwH2Status });
  if (!kwMetrics.inH2 && h2Rate >= 0.3) recs.push({ priority: 'medium', message: `Include "${keyword}" in at least one H2 heading (${Math.round(h2Rate * 100)}% of competitors do).` });

  // 7. Keyword in First 100 Words
  const first100Rate = benchmark.keywordInFirst100Rate || 0;
  let kw100Score = 0, kw100Status = 'poor';
  if (kwMetrics.inFirst100) { kw100Score = 100; kw100Status = 'good'; }
  else if (first100Rate < 0.3) { kw100Score = 60; kw100Status = 'needs_work'; }
  signals.push({ signal: 'Keyword in First 100', yourValue: kwMetrics.inFirst100 ? 1 : 0, avgValue: first100Rate, score: kw100Score, status: kw100Status });
  if (!kwMetrics.inFirst100 && first100Rate >= 0.3) recs.push({ priority: 'medium', message: `Mention "${keyword}" within the first 100 words (${Math.round(first100Rate * 100)}% of competitors do).` });

  // 8. Keyword Density
  const [densityScore, densityStatus] = rangeScore(kwMetrics.density, benchmark.avgKeywordDensity, 0.5);
  signals.push({ signal: 'Keyword Density', yourValue: Math.round(kwMetrics.density * 100) / 100, avgValue: benchmark.avgKeywordDensity, score: densityScore, status: densityStatus });

  // 9. Images
  const [imgScore, imgStatus] = rangeScore(page.imageCount, benchmark.avgImages, 0.5);
  signals.push({ signal: 'Images', yourValue: page.imageCount, avgValue: benchmark.avgImages, score: imgScore, status: imgStatus });
  if (imgStatus !== 'good' && page.imageCount < benchmark.avgImages) recs.push({ priority: priority(imgScore), message: `Add more images. Top pages average ${Math.round(benchmark.avgImages)} images.` });

  // 10. Internal Links
  const [ilScore, ilStatus] = rangeScore(page.internalLinks, benchmark.avgInternalLinks, 0.5);
  signals.push({ signal: 'Internal Links', yourValue: page.internalLinks, avgValue: benchmark.avgInternalLinks, score: ilScore, status: ilStatus });

  // 11. External Links
  const [elScore, elStatus] = rangeScore(page.externalLinks, benchmark.avgExternalLinks, 0.5);
  signals.push({ signal: 'External Links', yourValue: page.externalLinks, avgValue: benchmark.avgExternalLinks, score: elScore, status: elStatus });

  // 12. Lists
  const [listScore, listStatus] = rangeScore(page.listCount, benchmark.avgListCount, 0.5);
  signals.push({ signal: 'Lists', yourValue: page.listCount, avgValue: benchmark.avgListCount, score: listScore, status: listStatus });
  if (listStatus !== 'good' && benchmark.avgListCount >= 1 && page.listCount < benchmark.avgListCount) recs.push({ priority: priority(listScore), message: `Add bullet or numbered lists. Competitors average ${Math.round(benchmark.avgListCount)} lists.` });

  // 13. Tables
  const [tableScore, tableStatus] = rangeScore(page.tableCount, benchmark.avgTableCount, 0.5);
  signals.push({ signal: 'Tables', yourValue: page.tableCount, avgValue: benchmark.avgTableCount, score: tableScore, status: tableStatus });
  if (tableStatus !== 'good' && benchmark.avgTableCount >= 1 && page.tableCount < benchmark.avgTableCount) recs.push({ priority: 'medium', message: `Consider adding comparison tables. Competitors average ${Math.round(benchmark.avgTableCount)} tables.` });

  // 14. FAQ
  const [faqScore, faqStatus] = rangeScore(page.faqCount, benchmark.avgFaqCount, 0.5);
  signals.push({ signal: 'FAQ', yourValue: page.faqCount, avgValue: benchmark.avgFaqCount, score: faqScore, status: faqStatus });
  if (faqStatus !== 'good' && benchmark.avgFaqCount >= 1 && page.faqCount < benchmark.avgFaqCount) recs.push({ priority: 'medium', message: 'Add an FAQ section. Most competitors include one.' });

  // 15. Reading Level
  const bodyWords = page.bodyText.split(/\s+/).filter(Boolean);
  const sentences = page.bodyText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentLen = sentences.length > 0 ? bodyWords.length / sentences.length : 0;
  const avgWordLen = bodyWords.length > 0 ? bodyWords.reduce((sum, w) => sum + w.length, 0) / bodyWords.length : 0;
  let userReadingLevel = 0.39 * avgSentLen + 11.8 * (avgWordLen / 3.0) - 15.59;
  if (userReadingLevel < 1) userReadingLevel = 1;
  let readScore = 50, readStatus = 'needs_work';
  if (benchmark.avgReadingLevel > 0) [readScore, readStatus] = rangeScore(userReadingLevel, benchmark.avgReadingLevel, 0.3);
  signals.push({ signal: 'Reading Level', yourValue: Math.round(userReadingLevel * 10) / 10, avgValue: benchmark.avgReadingLevel, score: readScore, status: readStatus });

  // 16. NLP Term Coverage
  let nlpCoverage = 0;
  let nlpScore = 0, nlpStatus = 'poor';
  const coveredNlpTerms = [];
  const missingNlpTerms = [];
  const nlpTermDetails = [];

  // Prefer AI-enriched terms when available, fall back to benchmark terms
  const aiTerms = aiFormatData?.nlpTerms || [];
  const topNlpTerms = aiTerms.length > 0
    ? aiTerms.map((t) => ({
        term: t.term,
        count: t.benchmarkCount || 1,
        docFrequency: 0,
        usageRange: null, // AI terms use benchmarkCount via ratio-based scoring
        prominence: t.position === 'top' ? 'first_paragraph' : '',
      }))
    : (benchmark.topNlpTerms || []);

  if (topNlpTerms.length > 0) {
    let totalCoverage = 0;

    for (const t of topNlpTerms) {
      const stemmed = stemPhrase(t.term);
      const userCount = userNGrams[stemmed] || 0;
      const detail = { term: t.term, yourCount: userCount, usageRange: t.usageRange || null, prominence: 'body' };

      if (prominenceMap && prominenceMap[stemmed]) {
        const p = prominenceMap[stemmed];
        if (p.inHeading) detail.prominence = 'heading';
        else if (p.inBold) detail.prominence = 'bold';
        else if (p.inFirstParagraph) detail.prominence = 'first_paragraph';
      }

      if (userCount === 0) {
        detail.status = 'missing';
        missingNlpTerms.push(t);
      } else if (t.usageRange) {
        if (userCount >= t.usageRange.min && userCount <= t.usageRange.max) {
          detail.status = 'good';
          totalCoverage += 1.0;
          coveredNlpTerms.push(t);
        } else if (userCount > t.usageRange.max) {
          detail.status = 'overused';
          const overRatio = userCount / t.usageRange.max;
          let overCredit = 1.0 - (overRatio - 1.0) * 0.5;
          overCredit = Math.max(0.3, Math.min(0.8, overCredit));
          totalCoverage += overCredit;
          coveredNlpTerms.push(t);
        } else {
          detail.status = 'underused';
          totalCoverage += 0.5;
          coveredNlpTerms.push(t);
        }
      } else {
        const avgPerDoc = t.count / Math.max(t.docFrequency || 1, 1);
        const ratio = Math.min(userCount / avgPerDoc, 1.0);
        if (ratio >= 0.3) { detail.status = 'good'; totalCoverage += 1.0; coveredNlpTerms.push(t); }
        else { detail.status = 'underused'; totalCoverage += 0.3; coveredNlpTerms.push(t); }
      }

      nlpTermDetails.push(detail);
    }

    nlpCoverage = (totalCoverage / topNlpTerms.length) * 100;

    if (nlpCoverage >= 70) { nlpScore = 100; nlpStatus = 'good'; }
    else if (nlpCoverage >= 40) { nlpScore = Math.round(nlpCoverage * 1.4); nlpStatus = 'needs_work'; }
    else { nlpScore = Math.round(nlpCoverage * 1.2); nlpStatus = 'poor'; }

    // Anti-stuffing
    if (benchmark.avgKeywordDensity > 0 && kwMetrics.density > benchmark.avgKeywordDensity * 2 && nlpScore > 70) {
      nlpScore = 70;
      nlpStatus = 'needs_work';
    }

    signals.push({ signal: 'NLP Term Coverage', yourValue: Math.round(nlpCoverage * 10) / 10, avgValue: 70, score: nlpScore, status: nlpStatus });

    if (missingNlpTerms.length > 0) {
      const highPri = missingNlpTerms.filter((t) => {
        // Benchmark terms: high priority if in 50%+ of competitor pages
        if ((t.docFrequency || 0) >= (benchmark.pageCount || 1) / 2) return true;
        // AI terms (docFrequency=0): high priority if benchmarkCount >= 3
        if (t.docFrequency === 0 && (t.count || 0) >= 3) return true;
        return false;
      });
      if (highPri.length > 0) {
        const labels = highPri.slice(0, 10).map((t) => t.usageRange ? `${t.term} (${t.usageRange.min}-${t.usageRange.max} times)` : t.term);
        recs.push({ priority: 'high', message: `Missing key terms used by most competitors: ${labels.join(', ')}` });
      }
    }
  }

  // 17. Topic Coverage
  let topicCoverage = 0;
  let topicScore = 0;
  const missingTopics = [];
  const topicClusters = benchmark.topicClusters || [];

  if (topicClusters.length > 0) {
    let coveredTopics = 0;
    for (const cluster of topicClusters) {
      let termsCovered = 0;
      for (const termStr of (cluster.terms || [])) {
        const stemmed = stemPhrase(termStr);
        if (userNGrams[stemmed] > 0) termsCovered++;
      }
      const clusterRatio = cluster.terms.length > 0 ? termsCovered / cluster.terms.length : 0;
      if (clusterRatio >= 0.3 || termsCovered >= 1) coveredTopics++;
      else missingTopics.push({ ...cluster, coverage: clusterRatio, userCovered: false });
    }
    topicCoverage = (coveredTopics / topicClusters.length) * 100;
    if (topicCoverage >= 75) topicScore = 100;
    else if (topicCoverage >= 45) topicScore = Math.round(topicCoverage * 1.3);
    else topicScore = Math.round(topicCoverage * 1.1);

    signals.push({ signal: 'Topic Coverage', yourValue: Math.round(topicCoverage * 10) / 10, avgValue: 75, score: topicScore, status: topicCoverage >= 75 ? 'good' : topicCoverage >= 45 ? 'needs_work' : 'poor' });

    if (missingTopics.length > 0) {
      const names = missingTopics.slice(0, 5).map((t) => `${t.topic} (${(t.terms || []).slice(0, 3).join(', ')})`);
      recs.push({ priority: 'high', message: `Missing topics your competitors cover: ${names.join('; ')}` });
    }
  }

  // 18. Subtopic Coverage
  let subtopicCoverage = 0;
  let subtopicScore = 0;
  const missingSubtopics = [];
  const subtopics = benchmark.subtopics || [];

  if (subtopics.length > 0) {
    let coveredCount = 0;
    const allUserHeadings = [...page.h2s, ...page.h3s].map((h) => stemPhrase(h.toLowerCase()));

    for (const sub of subtopics) {
      const stemmedSub = stemPhrase(sub.label.toLowerCase());
      const stemmedVariants = (sub.variants || []).map((v) => stemPhrase(v.toLowerCase()));
      const allForms = [stemmedSub, ...stemmedVariants];

      let found = false;
      for (const userH of allUserHeadings) {
        for (const form of allForms) {
          if (userH.includes(form) || form.includes(userH)) { found = true; break; }
          // Fuzzy: check word overlap
          const formWords = form.split(' ');
          const userWords = userH.split(' ');
          const overlap = formWords.filter((w) => userWords.includes(w)).length;
          if (formWords.length > 0 && overlap / formWords.length >= 0.6) { found = true; break; }
        }
        if (found) break;
      }

      // Also check body text for the subtopic term
      if (!found) {
        const bodyNGrams = userNGrams;
        if (bodyNGrams[stemmedSub] > 0) found = true;
      }

      if (found) coveredCount++;
      else missingSubtopics.push(sub);
    }

    subtopicCoverage = (coveredCount / subtopics.length) * 100;
    if (subtopicCoverage >= 70) subtopicScore = 100;
    else if (subtopicCoverage >= 40) subtopicScore = Math.round(subtopicCoverage * 1.3);
    else subtopicScore = Math.round(subtopicCoverage * 1.1);

    signals.push({ signal: 'Subtopic Coverage', yourValue: Math.round(subtopicCoverage * 10) / 10, avgValue: 70, score: subtopicScore, status: subtopicCoverage >= 70 ? 'good' : subtopicCoverage >= 40 ? 'needs_work' : 'poor' });

    if (missingSubtopics.length > 0) {
      const highPri = missingSubtopics.filter((s) => (s.docPercent || 0) >= 0.5);
      if (highPri.length > 0) {
        const labels = highPri.slice(0, 5).map((s) => `"${s.label}" (${s.docFrequency}/${benchmark.pageCount || '?'} competitors)`);
        recs.push({ priority: 'high', message: `Add sections covering: ${labels.join('; ')}` });
      }
    }
  }

  // 19. Term Prominence
  let prominenceScore = 50, prominenceStatus = 'needs_work';
  if (topNlpTerms.length > 0 && isHTML && prominenceMap) {
    let prominentCount = 0, coveredCount = 0;
    for (const t of topNlpTerms) {
      const stemmed = stemPhrase(t.term);
      if ((userNGrams[stemmed] || 0) > 0) {
        coveredCount++;
        const p = prominenceMap[stemmed];
        if (p && (p.inHeading || p.inBold || p.inFirstParagraph)) prominentCount++;
      }
    }
    if (coveredCount > 0) {
      const prominencePct = (prominentCount / coveredCount) * 100;
      if (prominencePct >= 40) { prominenceScore = 100; prominenceStatus = 'good'; }
      else if (prominencePct >= 20) { prominenceScore = Math.round(prominencePct * 2.5); prominenceStatus = 'needs_work'; }
      else { prominenceScore = Math.round(prominencePct * 2); prominenceStatus = 'poor'; }
      signals.push({ signal: 'Term Prominence', yourValue: Math.round(prominencePct * 10) / 10, avgValue: 40, score: prominenceScore, status: prominenceStatus });
    }
  }

  // Overall score: weighted average with intent modifiers
  let totalWeight = 0;
  let weightedSum = 0;
  const weightModifiers = intent?.weightModifiers || {};

  for (const s of signals) {
    let w = BASE_WEIGHTS[s.signal] || 1;
    if (weightModifiers[s.signal]) w *= weightModifiers[s.signal];
    weightedSum += s.score * w;
    totalWeight += w;
  }
  const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return {
    overallScore,
    keywords: benchmark.keywords || [],
    signals,
    recommendations: recs,
    nlpTermCoverage: Math.round(nlpCoverage * 10) / 10,
    coveredNlpTerms,
    missingNlpTerms,
    nlpTermDetails,
    topicCoverage: Math.round(topicCoverage * 10) / 10,
    missingTopics,
    subtopicCoverage: Math.round(subtopicCoverage * 10) / 10,
    missingSubtopics,
  };
}

module.exports = { scoreContent };
