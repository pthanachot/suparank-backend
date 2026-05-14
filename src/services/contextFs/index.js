/**
 * contextFs — public API for the Context File System.
 *
 *   list(content, planContext, prefix?)              → [{path, type, description, priority}]
 *   read(content, planContext, path, opts?)          → {path, frontmatter, body, raw, truncated}
 *                                                       opts: {offset?, limit?, anchor?}
 *   grep(content, planContext, pattern, prefix?)     → [{path, line, snippet}]
 *   verify(content, planContext, refs)               → [{ref, ok, reason?}]
 *
 * planContext shape (built by buildPlanContext, called by routes/controller):
 *   { draft, proposed, approved, history: [], historyCount, activePlan }
 *
 * Reads are pure — they project Mongo data into virtual files on the fly.
 * No caching at this layer; the Go-side LRU and any HTTP-level cache live
 * elsewhere.
 */

const router = require('./router');
const anchorsLib = require('./anchors');
const frontmatter = require('./frontmatter');
const planValidator = require('../planValidator');

// ─── list ────────────────────────────────────────────────────────────

function list(content, planContext, prefix) {
  if (!content) return [];
  return router.list({ content, planContext }, prefix || '/');
}

// ─── read ────────────────────────────────────────────────────────────

const DEFAULT_READ_LIMIT = 200;

function read(content, planContext, path, opts = {}) {
  if (!content) return null;
  const resolved = router.resolve(path);
  if (!resolved) return null;
  const file = resolved.generator({ content, planContext, params: resolved.params });
  if (!file) return null;

  // Anchor slice takes precedence over offset/limit (it's a semantic seek)
  if (opts.anchor) {
    const slice = anchorsLib.slice(file.body, file.frontmatter.anchors, opts.anchor);
    if (slice == null) {
      return {
        path,
        frontmatter: file.frontmatter,
        body: '',
        raw: frontmatter.emitFile(file.frontmatter, ''),
        truncated: false,
        error: `Anchor "${opts.anchor}" not found in ${path}`,
      };
    }
    return {
      path,
      frontmatter: file.frontmatter,
      body: slice,
      raw: frontmatter.emitFile(file.frontmatter, slice),
      truncated: false,
    };
  }

  // offset/limit slice
  const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_READ_LIMIT;
  const { slice, truncated } = anchorsLib.sliceByLines(file.body, offset, limit);

  return {
    path,
    frontmatter: file.frontmatter,
    body: slice,
    raw: frontmatter.emitFile(file.frontmatter, slice),
    truncated,
  };
}

// ─── grep ────────────────────────────────────────────────────────────

// grep scan limits — prevent runaway scans across a huge plan history or
// pathologically long files. The CFS is read-only synth, so limits don't
// affect correctness — only how much we scan in one call. Caller sees a
// `truncated` flag when limits trip.
const GREP_MAX_LINES_PER_FILE = 5000;
const GREP_MAX_TOTAL_LINES = 50000;
const GREP_MAX_RESULTS = 500;

function grep(content, planContext, pattern, prefix) {
  if (!content || !pattern) return { results: [], truncated: false };
  const re = pattern instanceof RegExp ? pattern : new RegExp(escapeRegex(String(pattern)), 'i');
  const entries = list(content, planContext, prefix || '/');
  const results = [];
  let scanned = 0;
  let truncated = false;

  for (const entry of entries) {
    if (scanned >= GREP_MAX_TOTAL_LINES || results.length >= GREP_MAX_RESULTS) {
      truncated = true;
      break;
    }
    const file = read(content, planContext, entry.path, {
      offset: 0,
      limit: GREP_MAX_LINES_PER_FILE,
    });
    if (!file || !file.body) continue;
    if (file.truncated) truncated = true;
    const lines = file.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      scanned++;
      if (scanned > GREP_MAX_TOTAL_LINES) {
        truncated = true;
        break;
      }
      if (re.test(lines[i])) {
        results.push({
          path: entry.path,
          line: i + 1,
          snippet: lines[i].slice(0, 200),
        });
        if (results.length >= GREP_MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { results, truncated };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── verify ──────────────────────────────────────────────────────────
//
// Re-resolve a batch of ContextRefs against the current CFS state.
// Each ref points at a file path; resolution uses planValidator.resolveRef
// (which already implements the v4 match policy — anchor + anchors_version
// or whitespace-normalized exact-substring quote match).

function verify(content, planContext, refs) {
  if (!Array.isArray(refs)) return [];
  const cache = new Map(); // path → {frontmatter, body}
  const results = [];

  for (const ref of refs) {
    if (!ref || !ref.path) {
      results.push({ ref, ok: false, reason: 'missing path' });
      continue;
    }
    let file = cache.get(ref.path);
    if (!file) {
      const fullRead = read(content, planContext, ref.path, { offset: 0, limit: 100000 });
      if (!fullRead) {
        results.push({ ref, ok: false, reason: `path ${ref.path} not found` });
        continue;
      }
      file = { frontmatter: fullRead.frontmatter, body: fullRead.body };
      cache.set(ref.path, file);
    }
    const r = planValidator.resolveRef(ref, file);
    results.push({ ref, ok: r.ok, reason: r.reason });
  }
  return results;
}

// ─── helpers exported for controllers/tests ───────────────────────────

module.exports = {
  list,
  read,
  grep,
  verify,
  // exposed for testing
  _router: router,
};
