/**
 * Plan validator (v4 spec, M1).
 *
 * Three responsibilities:
 *   1. validateCompleteness(plan, brief) — gate for ExitPlanMode. Returns
 *      structured feedback the agent or UI can act on. Mirrors the existing
 *      seo.ValidateOutline pattern: empty failures array = pass.
 *
 *   2. validateOps(ops) — JSON Patch op whitelist. Only specific paths are
 *      writable; unknown paths reject. Prevents the model from mutating
 *      status, version, contentId, etc. directly.
 *
 *   3. matchQuote(quote, body) — citation match policy (locked in v4):
 *      whitespace-normalized (collapse runs of whitespace to single space,
 *      trim ends), case-sensitive, exact substring match. No fuzzy.
 *      matchAnchor(anchor, anchorsVersion, fileFrontmatter) — anchor id must
 *      exist AND anchors_version must match.
 *
 * Citation re-resolution (the /verify call) is implemented in contextFs at
 * M2 — this file only defines the matching policy used there.
 */

// ─── 1. Completeness ──────────────────────────────────────────────────

// Evidence density floor. Both numbers are deliberately low: the gate exists
// to catch a plan that is thin everywhere, not to arbitrate how well-researched
// a reasonable plan is. Raising them without re-measuring against live runs is
// how plan mode becomes unpassable — the model burns its turn budget failing
// ExitPlanMode and the user sees no plan at all, which is strictly worse than a
// lightly-sourced one. See WRITING-PATHS-STATUS §5.5 for the measured baseline.
const MIN_EVIDENCE_PER_SECTION = 2;
const MIN_DISTINCT_SOURCES = 2;

/**
 * Every ContextRef attached to one section — its key points' evidence plus the
 * plan-level evidenceMap entry keyed by that section's id.
 */
function countSectionRefs(plan, section) {
  let n = 0;
  for (const kp of section.keyPoints || []) {
    if (Array.isArray(kp.evidence)) n += kp.evidence.length;
  }
  const mapped = section.id && plan.evidenceMap ? plan.evidenceMap[section.id] : null;
  if (Array.isArray(mapped)) n += mapped.length;
  return n;
}

/**
 * Every ContextRef in the plan, from both homes. Mirrors the Go-side
 * collectRefs in tools/plan/exit.go — if one grows a third home for refs, so
 * must the other, or the two gates disagree about what the plan cites.
 */
function collectPlanRefs(plan) {
  const out = [];
  for (const section of plan.sections || []) {
    for (const kp of section.keyPoints || []) {
      if (Array.isArray(kp.evidence)) out.push(...kp.evidence);
    }
  }
  for (const refs of Object.values(plan.evidenceMap || {})) {
    if (Array.isArray(refs)) out.push(...refs);
  }
  return out;
}

/**
 * Validate a Plan for ExitPlanMode readiness.
 *
 * @param {object} plan   — the Plan document (or POJO)
 * @param {object} brief  — optional ContentBrief from Mongo. Without it,
 *                          the section-count rule falls back to >= 3.
 * @returns {{ok: boolean, failures: Array<{rule: string, message: string}>}}
 */
function validateCompleteness(plan, brief) {
  const failures = [];

  if (!plan || typeof plan !== 'object') {
    return { ok: false, failures: [{ rule: 'shape', message: 'Plan is missing or not an object' }] };
  }

  // Strategic frame
  for (const field of ['targetAudience', 'angle', 'thesis']) {
    if (!plan[field] || String(plan[field]).trim() === '') {
      failures.push({ rule: `strategic.${field}`, message: `Plan.${field} is required` });
    }
  }

  // Alternatives — required once we're considering proposing
  if (!Array.isArray(plan.alternatives) || plan.alternatives.length < 2) {
    failures.push({
      rule: 'alternatives.min',
      message: 'Plan must consider at least 2 alternatives',
    });
  } else {
    const chosenCount = plan.alternatives.filter((a) => a.chosen).length;
    if (chosenCount !== 1) {
      failures.push({
        rule: 'alternatives.chosen',
        message: 'Exactly one alternative must be marked chosen',
      });
    }
    plan.alternatives.forEach((alt, i) => {
      if (alt.chosen && (!alt.reason || alt.reason.trim() === '')) {
        failures.push({
          rule: `alternatives[${i}].reason`,
          message: 'Chosen alternative must include a reason',
        });
      }
    });
  }

  // Risks
  if (!Array.isArray(plan.risks) || plan.risks.length < 1) {
    failures.push({ rule: 'risks.min', message: 'Plan must surface at least 1 risk' });
  }

  // Sections
  const minSections = Math.max(
    3,
    Array.isArray(brief && brief.subtopics) ? brief.subtopics.length : 0
  );
  if (!Array.isArray(plan.sections) || plan.sections.length < minSections) {
    failures.push({
      rule: 'sections.min',
      message: `Plan must have at least ${minSections} sections (has ${
        Array.isArray(plan.sections) ? plan.sections.length : 0
      })`,
    });
  }

  // Duplicate section headings: each H2 should be unique. The Go-side drift
  // heuristic keys on slug(heading) to match doc → plan; duplicate headings
  // there would emit doubled word-budget violations. Catch the misconfig
  // here so it's blocked at ExitPlanMode instead of confusing the writer.
  if (Array.isArray(plan.sections) && plan.sections.length > 1) {
    const seen = new Set();
    plan.sections.forEach((section, i) => {
      const key = String(section && section.heading || '').trim().toLowerCase();
      if (!key) return;
      if (seen.has(key)) {
        failures.push({
          rule: `sections[${i}].heading.duplicate`,
          message: `Section heading "${section.heading}" is duplicated — each section must have a unique heading`,
        });
      } else {
        seen.add(key);
      }
    });
  }

  // Per-section: key points + word target + evidence on every key point
  (plan.sections || []).forEach((section, i) => {
    if (!Array.isArray(section.keyPoints) || section.keyPoints.length === 0) {
      failures.push({
        rule: `sections[${i}].keyPoints`,
        message: `Section "${section.heading || i}" needs at least one key point`,
      });
    }
    if (!section.wordTarget || section.wordTarget <= 0) {
      failures.push({
        rule: `sections[${i}].wordTarget`,
        message: `Section "${section.heading || i}" needs a word target`,
      });
    }
    let missingEvidence = false;
    (section.keyPoints || []).forEach((kp, j) => {
      if (!Array.isArray(kp.evidence) || kp.evidence.length === 0) {
        missingEvidence = true;
        failures.push({
          rule: `sections[${i}].keyPoints[${j}].evidence`,
          message: `Key point "${(kp.text || '').slice(0, 40)}" in section "${
            section.heading || i
          }" needs at least one evidence ref`,
        });
      }
    });

    // Evidence density floor. The per-key-point rule above is satisfied by a
    // section with one key point carrying one citation, which is how a plan
    // could pass this gate while being barely researched: measured across
    // three passing runs, citation counts were 49, 13 and 37 over ten sections
    // — roughly 4.9, 1.3 and 3.7 per section. All three were "complete".
    //
    // Counting both homes for a ref matters: evidenceMap is keyed by section
    // id and is where the model puts section-level support that is not tied to
    // a single key point. Ignoring it would fail sections that are in fact
    // well-sourced.
    //
    // Skipped when a key point already reported missing evidence — that
    // failure is the more specific one, and stacking a second complaint about
    // the same section makes the feedback list harder to act on.
    if (!missingEvidence) {
      const refs = countSectionRefs(plan, section);
      if (refs < MIN_EVIDENCE_PER_SECTION) {
        failures.push({
          rule: `sections[${i}].evidence.density`,
          message:
            `Section "${section.heading || i}" rests on ${refs} citation${refs === 1 ? '' : 's'} — ` +
            `needs at least ${MIN_EVIDENCE_PER_SECTION}. Add another key point with its own ` +
            `evidence, or cite a second source for an existing point.`,
        });
      }
    }
  });

  // Source breadth. A plan can hit the per-section floor while quoting one
  // file over and over, which is restatement rather than research. This is a
  // floor against monoculture, not a quality lever: all three measured runs
  // drew on 2-4 distinct paths, so it is set where it catches the pathological
  // case without second-guessing runs that already look reasonable.
  if (Array.isArray(plan.sections) && plan.sections.length > 0) {
    const paths = new Set();
    for (const ref of collectPlanRefs(plan)) {
      if (ref && ref.path) paths.add(String(ref.path));
    }
    if (paths.size > 0 && paths.size < MIN_DISTINCT_SOURCES) {
      failures.push({
        rule: 'evidence.sources',
        message:
          `Every citation in the plan points at ${[...paths].join(', ')} — ` +
          `a plan must draw on at least ${MIN_DISTINCT_SOURCES} distinct sources. ` +
          `Call ListContext and cite a second file.`,
      });
    }
  }

  // Word budget — sum of section targets within 10% of brief target
  if (brief && brief.targetWordCount && Array.isArray(plan.sections)) {
    const sum = plan.sections.reduce((acc, s) => acc + (s.wordTarget || 0), 0);
    const target = brief.targetWordCount;
    const delta = Math.abs(sum - target);
    const allowed = target * 0.1;
    if (delta > allowed) {
      failures.push({
        rule: 'wordBudget',
        message: `Sum of section word targets (${sum}) is more than 10% off brief target (${target})`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

// ─── 2. JSON Patch op whitelist ───────────────────────────────────────

// Path-pattern whitelist. Each pattern matches an exact path or a path with
// a numeric index or a Map key. Patterns use `*` for any single segment.
// We intentionally do NOT allow direct writes to: status, version, contentId,
// workspaceId, contentNumber, parentVersion, approvedAt, approvedBy,
// evidenceVerified, predictedSeoScore, createdAt, updatedAt.
const PATCH_ALLOWED_PATHS = [
  // Strategic
  /^\/targetAudience$/,
  /^\/angle$/,
  /^\/thesis$/,
  /^\/differentiation$/,
  /^\/differentiation\/-$/,                              // append
  /^\/differentiation\/\d+$/,                            // replace/remove element
  /^\/differentiation\/\d+\/(competitorPath|gap|ourMove)$/,

  // Structural
  /^\/sections$/,
  /^\/sections\/-$/,
  /^\/sections\/\d+$/,
  /^\/sections\/\d+\/(id|heading|headingLevel|wordTarget)$/,
  /^\/sections\/\d+\/keyPoints$/,
  /^\/sections\/\d+\/keyPoints\/-$/,
  /^\/sections\/\d+\/keyPoints\/\d+$/,
  /^\/sections\/\d+\/keyPoints\/\d+\/text$/,
  /^\/sections\/\d+\/keyPoints\/\d+\/evidence$/,
  /^\/sections\/\d+\/keyPoints\/\d+\/evidence\/-$/,
  /^\/sections\/\d+\/keyPoints\/\d+\/evidence\/\d+$/,
  /^\/sections\/\d+\/keyPoints\/\d+\/evidence\/\d+\/(path|anchor|anchorsVersion|quote|reason)$/,
  /^\/sections\/\d+\/internalLinks$/,
  /^\/sections\/\d+\/internalLinks\/-$/,
  /^\/sections\/\d+\/internalLinks\/\d+$/,
  /^\/wordBudget$/,

  // Evidence map — keys are section ids, values are arrays of ContextRef
  /^\/evidenceMap$/,
  /^\/evidenceMap\/[A-Za-z0-9_-]+$/,
  /^\/evidenceMap\/[A-Za-z0-9_-]+\/-$/,
  /^\/evidenceMap\/[A-Za-z0-9_-]+\/\d+$/,
  /^\/evidenceMap\/[A-Za-z0-9_-]+\/\d+\/(path|anchor|anchorsVersion|quote|reason)$/,

  // Sources
  /^\/sources$/,
  /^\/sources\/-$/,
  /^\/sources\/\d+$/,
  /^\/sources\/\d+\/(url|title|snippet|stance|addedAt)$/,

  // Deliberation
  /^\/alternatives$/,
  /^\/alternatives\/-$/,
  /^\/alternatives\/\d+$/,
  /^\/alternatives\/\d+\/(label|chosen|reason)$/,
  /^\/alternatives\/\d+\/(pros|cons)$/,
  /^\/alternatives\/\d+\/(pros|cons)\/-$/,
  /^\/alternatives\/\d+\/(pros|cons)\/\d+$/,
  /^\/risks$/,
  /^\/risks\/-$/,
  /^\/risks\/\d+$/,
  /^\/risks\/\d+\/(description|mitigation|severity)$/,
  /^\/openQuestions$/,
  /^\/openQuestions\/-$/,
  /^\/openQuestions\/\d+$/,
  /^\/openQuestions\/\d+\/(id|question|blocking|answer)$/,
];

const PATCH_ALLOWED_OPS = new Set(['add', 'replace', 'remove']);

/**
 * Validate a JSON Patch op array. Rejects unknown ops and unknown paths.
 * Does NOT apply the patch — apply happens in the controller after validation.
 *
 * @param {Array<{op: string, path: string, value?: any}>} ops
 * @returns {{ok: boolean, failures: Array<{op: object, message: string}>}}
 */
function validateOps(ops) {
  if (!Array.isArray(ops)) {
    return { ok: false, failures: [{ op: null, message: 'ops must be an array' }] };
  }
  const failures = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') {
      failures.push({ op, message: 'op must be an object' });
      continue;
    }
    if (!PATCH_ALLOWED_OPS.has(op.op)) {
      failures.push({ op, message: `op.op "${op.op}" is not allowed (use add/replace/remove)` });
      continue;
    }
    if (typeof op.path !== 'string' || !op.path.startsWith('/')) {
      failures.push({ op, message: 'op.path must be a string starting with "/"' });
      continue;
    }
    const pathAllowed = PATCH_ALLOWED_PATHS.some((re) => re.test(op.path));
    if (!pathAllowed) {
      failures.push({ op, message: `op.path "${op.path}" is not in the writable whitelist` });
      continue;
    }
    if ((op.op === 'add' || op.op === 'replace') && op.value === undefined) {
      failures.push({ op, message: `op "${op.op}" requires a value` });
    }
  }
  return { ok: failures.length === 0, failures };
}

// ─── 3. Citation matching policy ──────────────────────────────────────

/**
 * Normalize whitespace per v4 spec: collapse runs of whitespace to a single
 * space, then trim. Case-sensitive (no .toLowerCase()).
 */
function normalizeForQuoteMatch(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Match a quote-style citation against a file body.
 * Whitespace-normalized, case-sensitive, exact substring match.
 *
 * @param {string} quote — the verbatim quote recorded in the citation
 * @param {string} body  — the current file body
 * @returns {boolean}
 */
function matchQuote(quote, body) {
  if (!quote || !body) return false;
  const q = normalizeForQuoteMatch(quote);
  const b = normalizeForQuoteMatch(body);
  if (q.length === 0) return false;
  return b.includes(q);
}

/**
 * Match an anchor-style citation against a file's frontmatter.
 * Anchor id must exist AND anchors_version must match.
 *
 * @param {string} anchorId
 * @param {number} citationAnchorsVersion
 * @param {{anchors_version?: number, anchors?: Array<{id: string}>}} fileFrontmatter
 * @returns {boolean}
 */
function matchAnchor(anchorId, citationAnchorsVersion, fileFrontmatter) {
  if (!anchorId || !fileFrontmatter) return false;
  if (fileFrontmatter.anchors_version !== citationAnchorsVersion) return false;
  const anchors = Array.isArray(fileFrontmatter.anchors) ? fileFrontmatter.anchors : [];
  return anchors.some((a) => a && a.id === anchorId);
}

/**
 * Resolve a single ContextRef against a file's frontmatter + body.
 * The ref is valid if EITHER its anchor matches OR its quote matches.
 *
 * @param {{anchor?: string, anchorsVersion?: number, quote?: string}} ref
 * @param {{frontmatter?: object, body?: string}} file
 * @returns {{ok: boolean, reason?: string}}
 */
function resolveRef(ref, file) {
  if (!ref) return { ok: false, reason: 'ref is missing' };
  if (!file) return { ok: false, reason: 'file is missing' };
  const hasAnchor = !!ref.anchor;
  const hasQuote = !!ref.quote;
  if (!hasAnchor && !hasQuote) {
    return { ok: false, reason: 'ref has neither anchor nor quote' };
  }
  if (hasAnchor && matchAnchor(ref.anchor, ref.anchorsVersion, file.frontmatter || {})) {
    return { ok: true };
  }
  if (hasQuote && matchQuote(ref.quote, file.body || '')) {
    return { ok: true };
  }
  return { ok: false, reason: 'neither anchor nor quote resolved' };
}

module.exports = {
  validateCompleteness,
  validateOps,
  matchQuote,
  matchAnchor,
  resolveRef,
  normalizeForQuoteMatch,
  PATCH_ALLOWED_PATHS,
  PATCH_ALLOWED_OPS,
  MIN_EVIDENCE_PER_SECTION,
  MIN_DISTINCT_SOURCES,
};
