/**
 * Slug helpers — derive stable, safe path segments from arbitrary strings.
 * Used for CFS paths like /competitors/{domain}.md and /subtopics/{slug}.md.
 *
 * Output guarantee: matches /^[a-z0-9._-]+$/ — safe to embed in URLs and
 * matches the planValidator/Plan section-id regex shape closely (we allow
 * dots for domains).
 */

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** Extract host from URL, fall back to slug of title. */
function competitorSlug(competitor) {
  if (!competitor) return 'unknown';
  if (competitor.url) {
    try {
      const u = new URL(competitor.url);
      return u.hostname.replace(/^www\./, '');
    } catch {
      // not a URL — fall through
    }
  }
  return slugify(competitor.title || 'unknown');
}

function subtopicSlug(s) {
  return slugify((s && s.label) || 'untitled');
}

function keywordSlug(k) {
  return slugify(String(k || ''));
}

/** Generic block-id slug (for /draft/sections/{id}.md). */
function blockHeadingSlug(text) {
  return slugify(String(text || '').slice(0, 80) || 'section');
}

/**
 * Disambiguate slug collisions deterministically by iterating in array order:
 *   first occurrence keeps its base slug
 *   subsequent occurrences get -2, -3, ... appended
 *
 * Track every ASSIGNED slug (not just base slugs) in a Set so a synthesized
 * suffix can't collide with a naturally-occurring one. Without this guard,
 * input `[notion, notion, notion-2]` produces `[notion, notion-2, notion-2]`
 * — the disambiguation re-introduces the duplicate it was supposed to prevent.
 *
 * Returns [{item, slug}] in the same order as the input. Items whose slugFn
 * returns falsy get slug: null and the caller should skip them.
 */
function assignUniqueSlugs(items, slugFn) {
  if (!Array.isArray(items)) return [];
  const used = new Set();
  return items.map((item) => {
    const base = slugFn(item);
    if (!base) return { item, slug: null };
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${n}`;
      n++;
    }
    used.add(candidate);
    return { item, slug: candidate };
  });
}

module.exports = {
  slugify,
  competitorSlug,
  subtopicSlug,
  keywordSlug,
  blockHeadingSlug,
  assignUniqueSlugs,
};
