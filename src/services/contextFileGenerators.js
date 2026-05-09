/**
 * Context file generators — convert MongoDB data into .md files
 * that the AI Writing Engine reads on demand via ReadFile tool.
 *
 * These mirror the "workspace files" concept from Claude Code:
 * the AI sees a file listing and reads what it needs.
 */

/**
 * Build research-outline.md from benchmark/competitor data.
 * Contains recommended outline, competitor headings, PAA questions, AI Search insights.
 *
 * @param {Object} content - MongoDB Content document
 * @returns {string} Markdown content
 */
function buildResearchOutlineMd(content) {
  const lines = ['# Research & Outline\n'];

  // Recommended outline
  const outline = content.recommendedOutline;
  if (outline && outline.sections && outline.sections.length > 0) {
    lines.push('## Recommended Outline\n');
    if (outline.h1) {
      lines.push(`**H1:** ${outline.h1}\n`);
    }
    for (const section of outline.sections) {
      if (section.h2) {
        lines.push(`- **H2:** ${section.h2}`);
        if (section.children && section.children.length > 0) {
          for (const child of section.children) {
            if (child.h3) {
              lines.push(`  - H3: ${child.h3}`);
            }
          }
        }
      }
    }
    lines.push('');
  }

  // Competitor headings
  const pages = content.competitorPages || [];
  if (pages.length > 0) {
    lines.push('## Competitor Headings\n');
    for (const page of pages.slice(0, 5)) {
      const domain = page.url ? new URL(page.url).hostname : page.domain || 'competitor';
      lines.push(`### ${domain}`);
      const h2s = page.h2s || [];
      for (const h of h2s.slice(0, 10)) {
        lines.push(`- ${h}`);
      }
      lines.push('');
    }
  }

  // People Also Ask
  const paa = content.peopleAlsoAsk || [];
  if (paa.length > 0) {
    lines.push('## People Also Ask\n');
    for (const item of paa.slice(0, 10)) {
      const q = item.question || item.query || '';
      if (q) lines.push(`- ${q}`);
    }
    lines.push('');
  }

  // AI Search insights (conversations)
  const conversations = content.aiConversations || [];
  if (conversations.length > 0) {
    lines.push('## AI Search Insights\n');
    for (const conv of conversations.slice(0, 3)) {
      if (conv.query) lines.push(`**Query:** ${conv.query}`);
      if (conv.summary) lines.push(conv.summary);
      if (conv.answer) lines.push(conv.answer);
      lines.push('');
    }
  }

  // AI Answer Analysis
  if (content.aiAnswerAnalysis) {
    const analysis = content.aiAnswerAnalysis;
    if (analysis.summary || analysis.recommendations) {
      lines.push('## AI Answer Analysis\n');
      if (analysis.summary) lines.push(analysis.summary);
      if (analysis.recommendations && Array.isArray(analysis.recommendations)) {
        lines.push('\n**Recommendations:**');
        for (const rec of analysis.recommendations) {
          lines.push(`- ${rec}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Build seo-targets.md from SEO brief data.
 * Contains target keyword, NLP terms with usage ranges, subtopics, topic clusters.
 *
 * @param {Object} brief - ContentBrief object (from benchmarkToContentBrief)
 * @returns {string} Markdown content
 */
function buildSeoTargetsMd(brief) {
  const lines = ['# SEO Targets\n'];

  // Target keyword
  if (brief.targetKeyword) {
    lines.push(`## Target Keyword\n`);
    lines.push(`"${brief.targetKeyword}" (target density: ${brief.targetDensity || 1.5}%)\n`);
  }

  // Secondary keywords
  if (brief.secondaryKeywords && brief.secondaryKeywords.length > 0) {
    lines.push('## Secondary Keywords\n');
    lines.push(brief.secondaryKeywords.join(', ') + '\n');
  }

  // NLP terms with usage ranges
  if (brief.nlpTerms && brief.nlpTerms.length > 0) {
    lines.push('## NLP Terms (use each within the min-max range)\n');
    lines.push('| Term | Min | Max | Category |');
    lines.push('|------|-----|-----|----------|');
    for (const t of brief.nlpTerms) {
      lines.push(`| ${t.term} | ${t.min} | ${t.max} | ${t.category || 'nlp'} |`);
    }
    lines.push('');
  }

  // Subtopics
  if (brief.subtopics && brief.subtopics.length > 0) {
    lines.push('## Subtopics (include these sections)\n');
    lines.push('| Subtopic | Competitor Coverage |');
    lines.push('|----------|-------------------|');
    for (const s of brief.subtopics) {
      lines.push(`| ${s.label} | ${s.docPercent || 0}% |`);
    }
    lines.push('');
  }

  // Topic clusters
  if (brief.topicClusters && brief.topicClusters.length > 0) {
    lines.push('## Topic Clusters\n');
    for (const c of brief.topicClusters) {
      const terms = (c.terms || []).join(', ');
      lines.push(`- **${c.label}**: ${terms}`);
    }
    lines.push('');
  }

  // Benchmark averages
  if (brief.benchmarkAverages) {
    const avg = brief.benchmarkAverages;
    lines.push('## Benchmark Averages (competitor analysis)\n');
    lines.push(`- Word count: ${avg.wordCount}`);
    lines.push(`- H2 headings: ${avg.h2Count}`);
    lines.push(`- H3 headings: ${avg.h3Count}`);
    lines.push(`- Images: ${avg.images}`);
    lines.push(`- Paragraphs: ${avg.paragraphs}`);
    lines.push(`- Keyword density: ${avg.keywordDensity}%`);
    lines.push('');
  }

  // Search intent
  if (brief.searchIntent) {
    lines.push(`## Search Intent\n`);
    lines.push(`${brief.searchIntent}\n`);
  }

  // Author context / instructions
  if (brief.authorContext) {
    lines.push('## Author Instructions\n');
    lines.push(brief.authorContext + '\n');
  }

  return lines.join('\n');
}

/**
 * Build content-audit.md from audit results.
 *
 * @param {Object} auditResults - Content audit data
 * @returns {string} Markdown content
 */
function buildContentAuditMd(auditResults) {
  if (!auditResults) return '';

  const lines = ['# Content Audit Results\n'];

  if (auditResults.overallScore !== undefined) {
    lines.push(`**Overall Score:** ${auditResults.overallScore}/100\n`);
  }

  if (auditResults.summary) {
    lines.push(`## Summary\n`);
    lines.push(auditResults.summary + '\n');
  }

  if (auditResults.criteria && Array.isArray(auditResults.criteria)) {
    lines.push('## Audit Criteria\n');
    lines.push('| Criterion | Score | Status | Feedback |');
    lines.push('|-----------|-------|--------|----------|');
    for (const c of auditResults.criteria) {
      lines.push(`| ${c.name} | ${c.score}/10 | ${c.status} | ${c.feedback} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  buildResearchOutlineMd,
  buildSeoTargetsMd,
  buildContentAuditMd,
};
