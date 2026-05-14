/**
 * CFS generators — one function per file type. Each takes (content, params)
 * and returns {frontmatter, body, anchors} as a structured object plus a
 * rendered markdown body. The router (router.js) maps virtual paths to
 * these functions.
 *
 * Anchor IDs are stable per generator. anchors_version starts at 1 and is
 * bumped when a generator's anchor schema changes (see planValidator's
 * matchAnchor — citations record the version they saw).
 *
 * All generators are pure: no DB writes, no side effects. They consume
 * already-loaded Content (and optionally a Plan or referenced Content).
 */

const anchors = require('./anchors');
const slug = require('./slug');

const ANCHORS_VERSION = 1;

// ─── /INDEX.md ────────────────────────────────────────────────────────

function genIndex({ content, planContext }) {
  const benchmark = content.benchmark || {};
  const subtopics = Array.isArray(benchmark.subtopics) ? benchmark.subtopics : [];
  const competitors = Array.isArray(content.competitors) ? content.competitors : [];
  const targetKeywords = Array.isArray(content.targetKeywords) ? content.targetKeywords : [];
  const secondaryCount = Math.max(0, targetKeywords.length - 1);
  const blockCount = Array.isArray(content.blocks) ? content.blocks.length : 0;
  const draftWords = content.wordCount || 0;
  const priorPlanCount = planContext ? planContext.historyCount || 0 : 0;
  const latestHistoricalVersion = planContext ? planContext.latestHistoricalVersion || 0 : 0;
  const hasActivePlan = planContext ? !!planContext.activePlan : false;
  const hasDraft = blockCount > 0 || draftWords > 0;

  // Reading order adapts to state. Prior-plan link uses the actual newest
  // version, NOT the count (version numbers can be sparse). (Bug 2 fix.)
  const readingOrder = [];
  if (latestHistoricalVersion > 0) {
    readingOrder.push(`/plans/history/v-${latestHistoricalVersion}.md (prior plan — what was decided)`);
  }
  if (hasDraft) {
    readingOrder.push('/draft/outline.md (current structure)');
    readingOrder.push('/draft/meta.md (title, target word count, intent)');
  }
  readingOrder.push('/keywords/primary.md  + /keywords/secondary/ (target + supporting keywords)');
  if (competitors.length > 0) {
    const top = competitors.slice(0, 3).map(slug.competitorSlug).join(', ');
    readingOrder.push(`/competitors/* (start with top: ${top})`);
  }
  if (subtopics.length > 0) {
    readingOrder.push('/subtopics/* (high-coverage first)');
  }
  readingOrder.push('/nlp-terms/* (use during section construction, not on first pass)');

  const segments = [
    {
      id: 'summary',
      label: 'Workspace summary',
      body: [
        `- Content type: ${content.contentType || 'article'}`,
        `- Title: ${content.title || 'Untitled'}`,
        `- Target word count: ${content.targetWordCount || 'not set'}`,
        `- Country / device: ${content.country || 'any'} / ${content.device || 'any'}`,
        `- Current draft: ${draftWords} words, ${blockCount} blocks${hasDraft ? '' : ' (empty)'}`,
        `- Current mode: ${content.mode || 'chat'}`,
      ].join('\n'),
    },
    {
      id: 'available-context',
      label: 'Available context',
      body: [
        `- /keywords/: 1 primary, ${secondaryCount} secondary`,
        `- /aeo/questions/: ${(content.peopleAlsoAsk || []).length} SERP questions`,
        `- /competitors/: ${competitors.length} competitor pages analyzed`,
        `- /subtopics/: ${subtopics.length} subtopics`,
        `- /nlp-terms/: from benchmark.topNlpTerms`,
        `- /draft/: ${hasDraft ? `${draftWords} words, ${blockCount} blocks` : 'empty'}`,
        `- /style/: ${content.styleReferenceContentNumber ? `reference content #${content.styleReferenceContentNumber}` : 'none'}`,
        `- /audit/: ${(content.audits || []).length} runs`,
        `- /plans/: ${hasActivePlan ? 'active plan present, ' : ''}${priorPlanCount} historical version(s)`,
      ].join('\n'),
    },
    {
      id: 'reading-order',
      label: 'Suggested reading order',
      body: readingOrder.map((r, i) => `${i + 1}. ${r}`).join('\n'),
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: 'index',
      type: 'index',
      source: 'computed',
      priority: 0,
      description: `Workspace index for "${content.title || 'Untitled'}"`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /keywords/primary.md ────────────────────────────────────────────

function genKeywordPrimary({ content }) {
  const keywords = Array.isArray(content.targetKeywords) ? content.targetKeywords : [];
  const primary = keywords[0] || '';
  const benchmark = content.benchmark || {};
  const density = benchmark.avgKeywordDensity || 0;
  const intent = (content.intent && (content.intent.search_intent || content.intent.intent)) || 'informational';

  const segments = [
    {
      id: 'overview',
      label: 'Primary keyword',
      body: primary
        ? `**${primary}**\n\nThe principal target keyword for this article.`
        : '_No primary keyword set — wizard must specify before drafting._',
    },
    {
      id: 'targets',
      label: 'Targets',
      body: [
        `- Density target: ${density ? `${(density * 100).toFixed(2)}%` : 'not benchmarked'}`,
        `- Intent: ${intent}`,
        `- Country: ${content.country || 'any'}`,
        `- Device: ${content.device || 'any'}`,
        `- Word count target: ${content.targetWordCount || 'not set'}`,
      ].join('\n'),
    },
    {
      id: 'placement',
      label: 'Placement requirements',
      body: [
        '- Must appear in H1',
        '- Must appear in first paragraph (first 100 words)',
        '- Should appear in at least one H2',
        '- Should appear in the conclusion',
      ].join('\n'),
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: `keyword-${slug.keywordSlug(primary) || 'unset'}`,
      type: 'keyword',
      source: 'wizard',
      priority: 1,
      description: primary ? `Primary keyword: ${primary}` : 'No primary keyword set',
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /keywords/secondary/{slug}.md ───────────────────────────────────

function genKeywordSecondary({ content, params }) {
  const keywords = Array.isArray(content.targetKeywords) ? content.targetKeywords : [];
  const requested = params && params.slug;
  // Disambiguated lookup against the secondary slice. Use entry.slug for the
  // frontmatter id so collided keywords get distinct ids, not just paths.
  // (Bug 2 from M2 second-round review.)
  const secondaries = keywords.slice(1);
  const entry = slug.assignUniqueSlugs(secondaries, slug.keywordSlug).find((e) => e.slug === requested);
  const match = entry && entry.item;
  if (!match) return null;

  const segments = [
    {
      id: 'overview',
      label: 'Secondary keyword',
      body: `**${match}**\n\nSupporting keyword — weave naturally where it fits the topic.`,
    },
    {
      id: 'placement',
      label: 'Placement',
      body: '- 1-3 occurrences across the article\n- Prefer sub-section H2/H3 over body where possible',
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: `keyword-${entry.slug}`,
      type: 'keyword',
      source: 'wizard',
      priority: 2,
      description: `Secondary keyword: ${match}`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /competitors/{domain}.md ────────────────────────────────────────

function genCompetitor({ content, params }) {
  const competitors = Array.isArray(content.competitors) ? content.competitors : [];
  const requested = params && params.slug;
  // Disambiguated lookup — must match how router.list assigned the slug
  // (first occurrence keeps base, subsequent get -2, -3...). entry.slug is
  // used for the frontmatter id below so collided hosts get distinct ids.
  // (Bug 9 + Bug 2 from second-round review.)
  const entry = slug.assignUniqueSlugs(competitors, slug.competitorSlug).find((e) => e.slug === requested);
  const match = entry && entry.item;
  if (!match) return null;

  const segments = [
    {
      id: 'overview',
      label: 'Competitor overview',
      body: [
        `- **URL**: ${match.url || 'unknown'}`,
        `- **Title**: ${match.title || 'untitled'}`,
        `- **SERP position**: ${match.position || 'unknown'}`,
        `- **Word count**: ${match.wordCount || 'not measured'}`,
        `- **Selected for analysis**: ${match.selected ? 'yes' : 'no'}`,
      ].join('\n'),
    },
    {
      id: 'keywords',
      label: 'Keywords this page ranks for',
      body: Array.isArray(match.keywords) && match.keywords.length > 0
        ? match.keywords.slice(0, 20).map((k) => `- ${k}`).join('\n')
        : '_No keyword data._',
    },
    {
      id: 'differentiation',
      label: 'Differentiation prompts',
      body: [
        '- What does this competitor cover thoroughly that we can match?',
        '- What does this competitor MISS or treat shallowly that we can lead with?',
        '- Where is their angle weak (commercial bias, dated stats, no expert quotes)?',
      ].join('\n'),
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: `competitor-${entry.slug}`,
      type: 'competitor',
      source: 'benchmark',
      priority: 1,
      description: `Competitor: ${match.title || match.url || 'unknown'}`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /subtopics/{slug}.md ────────────────────────────────────────────

function genSubtopic({ content, params }) {
  const subtopics = (content.benchmark && content.benchmark.subtopics) || [];
  const requested = params && params.slug;
  // Disambiguated lookup; entry.slug used for the frontmatter id below.
  // (Bug 9 + Bug 2 from second-round review.)
  const entry = slug.assignUniqueSlugs(subtopics, slug.subtopicSlug).find((e) => e.slug === requested);
  const match = entry && entry.item;
  if (!match) return null;

  const pct = match.docPercent ? Math.round(match.docPercent * 100) : 0;
  const segments = [
    {
      id: 'overview',
      label: 'Subtopic',
      body: [
        `**${match.label}**`,
        '',
        `Found in ${pct}% of analyzed competitor pages (${match.docFrequency || 0} pages).`,
      ].join('\n'),
    },
    {
      id: 'variants',
      label: 'Term variants',
      body: Array.isArray(match.variants) && match.variants.length > 0
        ? match.variants.map((v) => `- ${v}`).join('\n')
        : '_No variants recorded._',
    },
    {
      id: 'guidance',
      label: 'Coverage guidance',
      body: pct >= 70
        ? 'High coverage — your article must address this subtopic to remain competitive.'
        : pct >= 30
        ? 'Medium coverage — strong signal to include; weak signal to differentiate by omitting.'
        : 'Low coverage — optional. Consider only if directly relevant to your angle.',
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: `subtopic-${entry.slug}`,
      type: 'subtopic',
      source: 'benchmark',
      priority: pct >= 70 ? 1 : pct >= 30 ? 2 : 3,
      description: `Subtopic: ${match.label} (${pct}% coverage)`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /nlp-terms/headings.md and /body.md ─────────────────────────────

function genNlpTerms({ content, params }) {
  const terms = (content.benchmark && content.benchmark.topNlpTerms) || [];
  const which = params && params.location; // 'headings' or 'body'

  const filtered = terms.filter((t) => {
    if (which === 'headings') return t.category === 'headings';
    if (which === 'body') return t.category === 'nlp' || !t.category;
    return false;
  });

  if (filtered.length === 0 && which) {
    const segments = [
      { id: 'overview', label: 'Terms', body: '_No NLP terms in this category._' },
    ];
    const rendered = anchors.render(segments);
    return {
      frontmatter: {
        id: `nlp-terms-${which}`,
        type: 'nlp-terms',
        source: 'benchmark',
        priority: 3,
        description: `NLP terms (${which})`,
        updated_at: Date.now(),
        anchors_version: ANCHORS_VERSION,
        anchors: rendered.anchors,
      },
      body: rendered.body,
    };
  }

  const segments = [
    {
      id: 'overview',
      label: 'Terms',
      body: filtered.map((t) => {
        const range = t.usageRange
          ? `${t.usageRange.min}-${t.usageRange.max} times (target ${t.usageRange.recommended})`
          : '';
        return `- **${t.term}** — ${range || `${t.count || 1} occurrences in benchmark`}`;
      }).join('\n'),
    },
    {
      id: 'guidance',
      label: 'Usage guidance',
      body: which === 'headings'
        ? 'Weave these into H2/H3 headings. At least one occurrence per term, preferably in a section heading.'
        : 'Distribute these naturally through body paragraphs. Avoid clustering; respect the usage range — over-stuffing degrades quality.',
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: `nlp-terms-${which}`,
      type: 'nlp-terms',
      source: 'benchmark',
      priority: 2,
      description: `NLP terms required in ${which}`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /draft/meta.md ──────────────────────────────────────────────────

function genDraftMeta({ content }) {
  const segments = [
    {
      id: 'overview',
      label: 'Draft metadata',
      body: [
        `- **Title**: ${content.title || 'Untitled'}`,
        `- **Description**: ${content.description || '(not set)'}`,
        `- **Target word count**: ${content.targetWordCount || 'not set'}`,
        `- **Current word count**: ${content.wordCount || 0}`,
        `- **Status**: ${content.status || 'draft'}`,
        `- **Mode**: ${content.mode || 'chat'}`,
      ].join('\n'),
    },
    {
      id: 'snapshot-note',
      label: 'Snapshot note',
      body: 'This file is a **pre-turn snapshot** in execute mode. For live document state mid-turn, the agent must use ReadCurrentDocument (M3+).',
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: 'draft-meta',
      type: 'draft',
      source: 'content',
      priority: 1,
      description: 'Draft metadata snapshot',
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /draft/outline.md ───────────────────────────────────────────────

function genDraftOutline({ content }) {
  const blocks = Array.isArray(content.blocks) ? content.blocks : [];
  const headings = blocks
    .filter((b) => /^h[1-6]$/.test(b.type))
    .map((b) => ({ level: Number(b.type[1]), text: stripHtmlMinimal(b.text || '') }));

  let body;
  if (headings.length === 0) {
    body = '_Draft has no headings yet._';
  } else {
    body = headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
  }

  const segments = [
    { id: 'outline', label: 'Outline', body },
    {
      id: 'snapshot-note',
      label: 'Snapshot note',
      body: 'Pre-turn snapshot. Use ReadCurrentDocument for live state during execute mode.',
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: 'draft-outline',
      type: 'draft',
      source: 'content',
      priority: 1,
      description: `Outline (${headings.length} headings)`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /draft/sections/{slug}.md ───────────────────────────────────────
// Sections are derived from blocks: each h1/h2/h3 starts a section, content
// runs until the next h1/h2/h3 (or end). Slug = blockHeadingSlug(heading).

function genDraftSection({ content, params }) {
  const blocks = Array.isArray(content.blocks) ? content.blocks : [];
  const requested = params && params.slug;
  const sections = splitIntoSections(blocks);
  // Disambiguated lookup; entry.slug used for the frontmatter id below.
  // (Bug 9 + Bug 2 from second-round review.)
  const entry = slug.assignUniqueSlugs(sections, (s) => slug.blockHeadingSlug(s.heading)).find((e) => e.slug === requested);
  const match = entry && entry.item;
  if (!match) return null;

  const segments = [
    { id: 'heading', label: 'Section heading', body: `## ${match.heading}` },
    {
      id: 'content',
      label: 'Section content',
      body: match.blocks.map(blockToMarkdownMinimal).filter(Boolean).join('\n\n'),
    },
    {
      id: 'stats',
      label: 'Section stats',
      body: `- Word count: ${countWords(match)}\n- Block count: ${match.blocks.length}`,
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: `section-${entry.slug}`,
      type: 'draft-section',
      source: 'content',
      priority: 2,
      description: `Section: ${match.heading}`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /plans/active.md ────────────────────────────────────────────────

function genPlanActive({ content, planContext }) {
  const plan = planContext && (planContext.proposed || planContext.draft || planContext.approved);
  if (!plan) {
    const segments = [
      { id: 'overview', label: 'Status', body: '_No active plan for this content._' },
    ];
    const rendered = anchors.render(segments);
    return {
      frontmatter: {
        id: 'plans-active',
        type: 'plan',
        source: 'plans',
        priority: 0,
        description: 'No active plan',
        updated_at: Date.now(),
        anchors_version: ANCHORS_VERSION,
        anchors: rendered.anchors,
      },
      body: rendered.body,
    };
  }

  return planToFile(plan, /*archived*/ false);
}

// ─── /plans/history/v-{n}.md ─────────────────────────────────────────

function genPlanHistory({ planContext, params }) {
  if (!planContext || !Array.isArray(planContext.history)) return null;
  const versionMatch = String(params && params.version).match(/^v-(\d+)$/);
  if (!versionMatch) return null;
  const version = Number(versionMatch[1]);
  const plan = planContext.history.find((p) => p.version === version);
  if (!plan) return null;
  return planToFile(plan, /*archived*/ true);
}

// ─── /style/brand-rules.md ───────────────────────────────────────────
// Placeholder until brand memory store lands (M5+).

function genStyleBrandRules() {
  const segments = [
    {
      id: 'overview',
      label: 'Brand rules',
      body: '_Brand memory store is not yet wired in this milestone. Style rules will surface here in M5+._',
    },
  ];
  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: 'style-brand-rules',
      type: 'style',
      source: 'brand-memory',
      priority: 3,
      description: 'Brand rules (placeholder)',
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /audit/latest.md ────────────────────────────────────────────────

function genAuditLatest({ content }) {
  const audits = Array.isArray(content.audits) ? content.audits : [];
  if (audits.length === 0) {
    const segments = [{ id: 'overview', label: 'Audit', body: '_No audit results yet._' }];
    const rendered = anchors.render(segments);
    return {
      frontmatter: {
        id: 'audit-latest',
        type: 'audit',
        source: 'content',
        priority: 3,
        description: 'No audit results',
        updated_at: Date.now(),
        anchors_version: ANCHORS_VERSION,
        anchors: rendered.anchors,
      },
      body: rendered.body,
    };
  }
  const a = audits[audits.length - 1];
  const segments = [
    {
      id: 'summary',
      label: 'Audit summary',
      body: [
        `- **Overall score**: ${a.overallScore}/100`,
        `- **Summary**: ${a.summary}`,
        `- **Model**: ${a.model}`,
      ].join('\n'),
    },
    {
      id: 'criteria',
      label: 'Criteria',
      body: (a.criteria || [])
        .map((c) => `- **${c.name}** (${c.status}, ${c.score}/10): ${c.feedback}`)
        .join('\n'),
    },
  ];
  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: 'audit-latest',
      type: 'audit',
      source: 'content',
      priority: 2,
      description: `Latest audit (${a.overallScore}/100)`,
      updated_at: a.createdAt || Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── /score/seo.md ───────────────────────────────────────────────────

function genScoreSeo({ content }) {
  const segments = [
    {
      id: 'overview',
      label: 'SEO score',
      body: [
        `- **Current score**: ${content.score || 0}/100`,
        `- **Word count**: ${content.wordCount || 0} / ${content.targetWordCount || '?'}`,
      ].join('\n'),
    },
  ];
  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: 'score-seo',
      type: 'score',
      source: 'computed',
      priority: 3,
      description: `SEO score (${content.score || 0}/100)`,
      updated_at: Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function planToFile(plan, isHistory) {
  const sections = Array.isArray(plan.sections) ? plan.sections : [];
  const alts = Array.isArray(plan.alternatives) ? plan.alternatives : [];
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const oqs = Array.isArray(plan.openQuestions) ? plan.openQuestions : [];
  const evidenceMap = plan.evidenceMap && typeof plan.evidenceMap === 'object'
    ? plan.evidenceMap
    : {};
  const sources = Array.isArray(plan.sources) ? plan.sources : [];

  const segments = [
    {
      id: 'strategic',
      label: 'Strategic frame',
      body: [
        `- **Target audience**: ${plan.targetAudience || '(not set)'}`,
        `- **Angle**: ${plan.angle || '(not set)'}`,
        `- **Thesis**: ${plan.thesis || '(not set)'}`,
        `- **Word budget**: ${plan.wordBudget || 0}`,
        `- **Status**: ${plan.status} (v${plan.version})`,
        plan.parentVersion ? `- **Parent**: v${plan.parentVersion}` : null,
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'sections',
      label: 'Sections',
      body: sections.length === 0
        ? '_No sections defined._'
        : sections.map((s) => {
            // Render each key point with its inline evidence refs. Without
            // this, the agent reading /plans/active.md sees text only and
            // can't tell which evidence is already attached where.
            const kps = (s.keyPoints || []).map((kp) => {
              const evidence = Array.isArray(kp.evidence) ? kp.evidence : [];
              if (evidence.length === 0) {
                return `  - ${kp.text}`;
              }
              const refs = evidence.map(formatRef).join(', ');
              return `  - ${kp.text}\n    evidence: ${refs}`;
            }).join('\n');
            return `- **${s.heading}** (H${s.headingLevel}, ${s.wordTarget || 0}w, id=${s.id})\n${kps}`;
          }).join('\n'),
    },
    {
      id: 'evidence-map',
      label: 'Evidence map',
      body: renderEvidenceMap(evidenceMap),
    },
    {
      id: 'sources',
      label: 'Sources',
      body: sources.length === 0
        ? '_No external sources recorded._'
        : sources.map((s) => {
            const stance = s.stance ? ` [${s.stance}]` : '';
            const title = s.title ? `**${s.title}** — ` : '';
            return `- ${title}${s.url}${stance}`;
          }).join('\n'),
    },
    {
      id: 'alternatives',
      label: 'Alternatives considered',
      body: alts.length === 0
        ? '_No alternatives recorded._'
        : alts.map((a) => `- **${a.label}**${a.chosen ? ' (chosen)' : ''}: ${a.reason || ''}`).join('\n'),
    },
    {
      id: 'risks',
      label: 'Risks',
      body: risks.length === 0
        ? '_No risks recorded._'
        : risks.map((r) => `- **${r.severity}**: ${r.description}${r.mitigation ? ` — mitigation: ${r.mitigation}` : ''}`).join('\n'),
    },
    {
      id: 'open-questions',
      label: 'Open questions',
      body: oqs.length === 0
        ? '_No open questions._'
        : oqs.map((q) => `- ${q.blocking ? '**BLOCKING** ' : ''}${q.question}${q.answer ? ` → ${q.answer}` : ''}`).join('\n'),
    },
  ];

  const rendered = anchors.render(segments);
  return {
    frontmatter: {
      id: isHistory ? `plan-v${plan.version}` : 'plans-active',
      type: 'plan',
      source: 'plans',
      priority: 1,
      description: isHistory
        ? `Plan v${plan.version} (${plan.status})`
        : `Active plan v${plan.version} (${plan.status})`,
      updated_at: plan.updatedAt ? new Date(plan.updatedAt).valueOf() : Date.now(),
      anchors_version: ANCHORS_VERSION,
      anchors: rendered.anchors,
    },
    body: rendered.body,
  };
}

// formatRef renders a ContextRef compactly: path with anchor or quote
// summary. Used by planToFile so the agent reading /plans/active.md can
// see exactly which evidence is attached where.
function formatRef(ref) {
  if (!ref || typeof ref !== 'object') return '_invalid ref_';
  const path = ref.path || '?';
  if (ref.anchor) {
    return `\`${path}#${ref.anchor}\``;
  }
  if (ref.quote) {
    const q = String(ref.quote).slice(0, 50);
    return `\`${path}\` (quote: "${q}${ref.quote.length > 50 ? '…' : ''}")`;
  }
  return `\`${path}\``;
}

// renderEvidenceMap lists evidence keyed by section id. The map structure
// (section.id → ContextRef[]) is preserved verbatim from the structured
// plan; this rendering exists so an agent can see "section s1 has refs to
// /a.md and /b.md" by reading /plans/active.md, not by introspecting the
// pushed Plan struct.
function renderEvidenceMap(evidenceMap) {
  const keys = Object.keys(evidenceMap || {}).sort();
  if (keys.length === 0) {
    return '_No evidence attached to any section yet._';
  }
  return keys.map((sectionId) => {
    const refs = Array.isArray(evidenceMap[sectionId]) ? evidenceMap[sectionId] : [];
    if (refs.length === 0) {
      return `- **${sectionId}**: _(empty)_`;
    }
    return `- **${sectionId}**:\n${refs.map((r) => `  - ${formatRef(r)}`).join('\n')}`;
  }).join('\n');
}

// Section boundaries: any of h1, h2, h3 starts a new section. Previously
// only h2 boundaries split, which produced zero sections for documents that
// use a different heading hierarchy (e.g. h1 + h3 only). (Spec #6 fix.)
//
// Each section carries `level` so callers can preserve the depth context.
const SECTION_HEADING_LEVELS = new Set(['h1', 'h2', 'h3']);

function splitIntoSections(blocks) {
  const sections = [];
  let current = null;
  for (const b of blocks) {
    if (SECTION_HEADING_LEVELS.has(b.type)) {
      if (current) sections.push(current);
      current = {
        heading: stripHtmlMinimal(b.text || 'Untitled'),
        level: Number(b.type[1]),
        blocks: [],
      };
    } else if (current) {
      current.blocks.push(b);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function stripHtmlMinimal(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function blockToMarkdownMinimal(b) {
  const t = stripHtmlMinimal(b.text || '');
  switch (b.type) {
    case 'h3': return `### ${t}`;
    case 'h4': return `#### ${t}`;
    case 'h5': return `##### ${t}`;
    case 'h6': return `###### ${t}`;
    case 'p': return t;
    case 'li': return `- ${t}`;
    case 'ol': return `1. ${t}`;
    case 'quote': return `> ${t}`;
    case 'img': return b.src ? `![${b.alt || ''}](${b.src})` : '';
    default: return t;
  }
}

function countWords(section) {
  return section.blocks.reduce((acc, b) => {
    const t = stripHtmlMinimal(b.text || '');
    return acc + (t ? t.split(/\s+/).length : 0);
  }, 0);
}

module.exports = {
  ANCHORS_VERSION,
  genIndex,
  genKeywordPrimary,
  genKeywordSecondary,
  genCompetitor,
  genSubtopic,
  genNlpTerms,
  genDraftMeta,
  genDraftOutline,
  genDraftSection,
  genPlanActive,
  genPlanHistory,
  genStyleBrandRules,
  genAuditLatest,
  genScoreSeo,
  // helpers
  splitIntoSections,
  stripHtmlMinimal,
  blockToMarkdownMinimal,
  countWords,
};
