/**
 * Conformance / drift detection — Express-side mirror of Go's
 * internal/engine/conformance.ComputeDrift.
 *
 * Both implementations use the same severity ladder so the UI doesn't
 * need branching code per source. Express uses markdownToBlocks (block-
 * parser-based) so fenced code blocks, list items, etc. don't bleed
 * into heading detection. Slug parity uses the same blockHeadingSlug
 * helper as the CFS generators so heading match between plan and doc
 * is byte-identical with Go's slug.Slugify.
 *
 * Severity ladder:
 *   violation: missing planned section
 *   violation: word budget <50% or >150% of target
 *   warning:   unplanned H2 section in doc not present in plan
 *   warning:   word budget 20-50% off target
 *   info:      word budget 10-20% off target
 *
 * Returns: { ok, violations: [{type, sectionId?, heading?, severity, detail}], summary }
 */

const { markdownToBlocks, stripHtml } = require('./markdownToBlocks');
const { blockHeadingSlug } = require('./contextFs/slug');

const WORD_RE = /[A-Za-z0-9]+/g;

function plainText(htmlOrText) {
  if (!htmlOrText) return '';
  // markdownToBlocks emits HTML-inlined text. Strip tags for word counting.
  return typeof stripHtml === 'function' ? stripHtml(htmlOrText) : String(htmlOrText);
}

function countWords(text) {
  if (!text) return 0;
  const matches = String(text).match(WORD_RE);
  return matches ? matches.length : 0;
}

/**
 * Parse the document into a flat list of section snapshots.
 * Returns: [{ level, heading, slug, wordCount }, ...]
 *
 * Slicing rule: a section spans from one heading (h1-h3) to the next
 * heading of equal-or-higher level (lower numeric level). All non-
 * heading blocks in between accumulate into the section's word count.
 * Sub-headings (h4+) are NOT treated as section boundaries; the plan
 * never enumerates them.
 */
function parseDocSections(markdown) {
  const blocks = markdownToBlocks(markdown);
  const sections = [];
  let current = null;

  for (const b of blocks) {
    const headingMatch = /^h([1-6])$/.exec(b.type);
    if (headingMatch) {
      const level = Number(headingMatch[1]);
      // Top-level boundary = h1, h2, h3. Deeper levels (h4-h6) stay
      // inside the current section.
      if (level <= 3) {
        if (current) sections.push(current);
        const headingText = plainText(b.text);
        current = {
          level,
          heading: headingText,
          slug: blockHeadingSlug(headingText),
          wordCount: 0,
        };
      }
      // Heading text (boundary OR sub-heading) does NOT count toward
      // the section's word budget — Go's parser excludes heading text
      // for budget-rule parity. Skip the word-count branch below.
      continue;
    }
    if (!current) continue; // text before first heading: ignore
    current.wordCount += countWords(plainText(b.text || ''));
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Compute drift between a document (markdown) and a plan (Mongoose doc
 * or POJO). Mirrors Go's ComputeDrift output exactly.
 */
function computeDrift(documentMarkdown, plan) {
  if (!plan || !Array.isArray(plan.sections) || plan.sections.length === 0) {
    return { ok: true, violations: [], summary: '' };
  }

  // Empty doc but plan exists — every planned section is missing.
  if (!documentMarkdown || !String(documentMarkdown).trim()) {
    const violations = plan.sections.map((ps) => ({
      type: 'missing_section',
      sectionId: ps.id,
      heading: ps.heading,
      severity: 'violation',
      detail: `Section "${ps.heading}" is in the plan but absent from the document.`,
    }));
    return { ok: false, violations, summary: summarize(violations) };
  }

  const docSections = parseDocSections(documentMarkdown);

  // Duplicate H2 slugs: coalesce word counts + emit a warning per dup.
  // Mirrors Go's Bug #5 fix.
  const docBySlug = new Map();
  const violations = [];
  for (const ds of docSections) {
    if (docBySlug.has(ds.slug)) {
      const existing = docBySlug.get(ds.slug);
      existing.wordCount += ds.wordCount;
      violations.push({
        type: 'duplicate_section',
        heading: ds.heading,
        severity: 'warning',
        detail: `Section "${ds.heading}" appears more than once in the document — merge or rename.`,
      });
      continue;
    }
    docBySlug.set(ds.slug, { ...ds });
  }

  const planSlugs = new Set();

  for (const ps of plan.sections) {
    const slug = blockHeadingSlug(ps.heading || '');
    planSlugs.add(slug);
    const ds = docBySlug.get(slug);
    if (!ds) {
      violations.push({
        type: 'missing_section',
        sectionId: ps.id,
        heading: ps.heading,
        severity: 'violation',
        detail: `Section "${ps.heading}" is in the plan but absent from the document.`,
      });
      continue;
    }
    if (ps.wordTarget && ps.wordTarget > 0) {
      const ratio = ds.wordCount / ps.wordTarget;
      const delta = Math.abs(ratio - 1);
      if (ratio < 0.5) {
        violations.push({
          type: 'word_budget_undershoot',
          sectionId: ps.id,
          heading: ps.heading,
          severity: 'violation',
          detail: `Section "${ps.heading}" has ${ds.wordCount} words but target is ${ps.wordTarget} (<50% of target).`,
        });
      } else if (ratio > 1.5) {
        violations.push({
          type: 'word_budget_overshoot',
          sectionId: ps.id,
          heading: ps.heading,
          severity: 'violation',
          detail: `Section "${ps.heading}" has ${ds.wordCount} words but target is ${ps.wordTarget} (>150% of target).`,
        });
      } else if (delta > 0.2) {
        violations.push({
          type: 'word_budget_drift',
          sectionId: ps.id,
          heading: ps.heading,
          severity: 'warning',
          detail: `Section "${ps.heading}" has ${ds.wordCount} words vs target ${ps.wordTarget} (${Math.round(delta * 100)}% off).`,
        });
      } else if (delta > 0.1) {
        violations.push({
          type: 'word_budget_drift',
          sectionId: ps.id,
          heading: ps.heading,
          severity: 'info',
          detail: `Section "${ps.heading}" has ${ds.wordCount} words vs target ${ps.wordTarget} (${Math.round(delta * 100)}% off).`,
        });
      }
    }
  }

  // Unplanned sections — only flag H1/H2 level (top-level), dedup by slug.
  const seenUnplanned = new Set();
  for (const ds of docSections) {
    if (ds.level > 2) continue;
    if (planSlugs.has(ds.slug)) continue;
    if (seenUnplanned.has(ds.slug)) continue;
    seenUnplanned.add(ds.slug);
    violations.push({
      type: 'unplanned_section',
      heading: ds.heading,
      severity: 'warning',
      detail: `Section "${ds.heading}" is in the document but not in the approved plan.`,
    });
  }

  return {
    ok: violations.every((v) => v.severity !== 'violation'),
    violations,
    summary: summarize(violations),
  };
}

function summarize(violations) {
  if (!violations.length) return '';
  let critical = 0, warn = 0, info = 0;
  for (const v of violations) {
    if (v.severity === 'violation') critical++;
    else if (v.severity === 'warning') warn++;
    else if (v.severity === 'info') info++;
  }
  const parts = [];
  if (critical) parts.push(`${critical} violation(s)`);
  if (warn) parts.push(`${warn} warning(s)`);
  if (info) parts.push(`${info} info`);
  return 'Plan drift: ' + parts.join(', ');
}

module.exports = { computeDrift, parseDocSections, summarize };
