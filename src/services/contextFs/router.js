/**
 * Path router — maps virtual CFS paths to generator functions and enumerates
 * valid children for `list`. Two categories:
 *
 *   Exact paths: /INDEX.md, /keywords/primary.md, /draft/outline.md, etc.
 *   Glob paths:  /competitors/{slug}.md, /subtopics/{slug}.md, etc.
 *
 * The router has two operations:
 *   resolve(path)  → {generator, params, exact} or null
 *   list(content, planContext, prefix?) → [{path, type, description, priority}]
 */

const g = require('./generators');
const slug = require('./slug');

// ─── Resolve ─────────────────────────────────────────────────────────

const EXACT = {
  '/INDEX.md':                  { generator: g.genIndex },
  '/keywords/primary.md':       { generator: g.genKeywordPrimary },
  '/nlp-terms/headings.md':     { generator: (ctx) => g.genNlpTerms({ ...ctx, params: { location: 'headings' } }) },
  '/nlp-terms/body.md':         { generator: (ctx) => g.genNlpTerms({ ...ctx, params: { location: 'body' } }) },
  '/draft/meta.md':             { generator: g.genDraftMeta },
  '/draft/outline.md':          { generator: g.genDraftOutline },
  '/plans/active.md':           { generator: g.genPlanActive },
  '/style/brand-rules.md':      { generator: g.genStyleBrandRules },
  '/audit/latest.md':           { generator: g.genAuditLatest },
  '/score/seo.md':              { generator: g.genScoreSeo },
};

// Glob patterns: [{regex, generator, paramExtractor(match) → params}]
const GLOB = [
  {
    regex: /^\/keywords\/secondary\/([A-Za-z0-9._-]+)\.md$/,
    generator: g.genKeywordSecondary,
    extract: (m) => ({ slug: m[1] }),
  },
  {
    regex: /^\/competitors\/([A-Za-z0-9._-]+)\.md$/,
    generator: g.genCompetitor,
    extract: (m) => ({ slug: m[1] }),
  },
  {
    regex: /^\/subtopics\/([A-Za-z0-9._-]+)\.md$/,
    generator: g.genSubtopic,
    extract: (m) => ({ slug: m[1] }),
  },
  {
    regex: /^\/draft\/sections\/([A-Za-z0-9._-]+)\.md$/,
    generator: g.genDraftSection,
    extract: (m) => ({ slug: m[1] }),
  },
  {
    regex: /^\/plans\/history\/(v-\d+)\.md$/,
    generator: g.genPlanHistory,
    extract: (m) => ({ version: m[1] }),
  },
];

function resolve(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const exact = EXACT[path];
  if (exact) return { generator: exact.generator, params: {}, path };
  for (const g of GLOB) {
    const m = path.match(g.regex);
    if (m) return { generator: g.generator, params: g.extract(m), path };
  }
  return null;
}

// ─── List ────────────────────────────────────────────────────────────

/**
 * Enumerate the files visible at a given prefix path.
 *   list(content, planContext)            → root + everything available
 *   list(content, planContext, '/keywords') → just keyword files
 *
 * Returns descriptors (no body) so listings stay cheap.
 */
function list({ content, planContext }, prefix = '/') {
  const entries = [];
  const norm = prefix.replace(/\/$/, '');

  // Helper to push if prefix matches
  const push = (path, type, description, priority = 3) => {
    if (norm === '' || norm === '/' || path.startsWith(norm + '/') || path === norm) {
      entries.push({ path, type, description, priority });
    }
  };

  // Root
  push('/INDEX.md', 'index', `Workspace index for "${content.title || 'Untitled'}"`, 0);

  // Keywords — primary + disambiguated secondaries (Bug 9 fix)
  const keywords = Array.isArray(content.targetKeywords) ? content.targetKeywords : [];
  if (keywords.length > 0) {
    push('/keywords/primary.md', 'keyword', `Primary keyword: ${keywords[0]}`, 1);
    const secondaries = keywords.slice(1);
    slug.assignUniqueSlugs(secondaries, slug.keywordSlug).forEach(({ item: k, slug: s }) => {
      if (s) push(`/keywords/secondary/${s}.md`, 'keyword', `Secondary keyword: ${k}`, 2);
    });
  }

  // Competitors — disambiguate slug collisions (Bug 9 fix)
  const competitors = Array.isArray(content.competitors) ? content.competitors : [];
  slug.assignUniqueSlugs(competitors, slug.competitorSlug).forEach(({ item: c, slug: s }) => {
    if (s) push(`/competitors/${s}.md`, 'competitor', `Competitor: ${c.title || c.url || 'unknown'}`, 1);
  });

  // Subtopics — disambiguate slug collisions
  const subtopics = (content.benchmark && content.benchmark.subtopics) || [];
  slug.assignUniqueSlugs(subtopics, slug.subtopicSlug).forEach(({ item: st, slug: s }) => {
    if (s) {
      const pct = st.docPercent ? Math.round(st.docPercent * 100) : 0;
      push(`/subtopics/${s}.md`, 'subtopic', `Subtopic: ${st.label} (${pct}% coverage)`, pct >= 70 ? 1 : 2);
    }
  });

  // NLP terms
  const nlpTerms = (content.benchmark && content.benchmark.topNlpTerms) || [];
  if (nlpTerms.some((t) => t.category === 'headings')) {
    push('/nlp-terms/headings.md', 'nlp-terms', 'NLP terms required in headings', 2);
  }
  if (nlpTerms.some((t) => t.category === 'nlp' || !t.category)) {
    push('/nlp-terms/body.md', 'nlp-terms', 'NLP terms for body distribution', 2);
  }

  // Draft
  push('/draft/meta.md', 'draft', 'Draft metadata snapshot', 1);
  push('/draft/outline.md', 'draft', 'Outline snapshot', 1);
  const sections = g.splitIntoSections(content.blocks || []);
  slug.assignUniqueSlugs(sections, (s) => slug.blockHeadingSlug(s.heading)).forEach(({ item: s, slug: sl }) => {
    if (sl) push(`/draft/sections/${sl}.md`, 'draft-section', `Section: ${s.heading}`, 2);
  });

  // Style
  push('/style/brand-rules.md', 'style', 'Brand rules (placeholder)', 3);

  // Audit
  push('/audit/latest.md', 'audit', `Latest audit (${(content.audits || []).length} runs)`, 2);

  // Score
  push('/score/seo.md', 'score', `SEO score (${content.score || 0}/100)`, 3);

  // Plans
  push('/plans/active.md', 'plan', planContext && (planContext.proposed || planContext.draft || planContext.approved)
    ? 'Active plan'
    : 'No active plan', 1);
  if (planContext && Array.isArray(planContext.history)) {
    planContext.history.forEach((p) => {
      push(`/plans/history/v-${p.version}.md`, 'plan', `Plan v${p.version} (${p.status})`, 3);
    });
  }

  // Sort by priority then path for deterministic output
  entries.sort((a, b) => (a.priority - b.priority) || a.path.localeCompare(b.path));
  return entries;
}

module.exports = { resolve, list };
