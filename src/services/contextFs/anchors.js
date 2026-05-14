/**
 * Anchor segments — the building block CFS generators use to construct file
 * bodies. Each anchor is a labeled chunk of markdown that becomes an H2
 * section. The generator declares anchors as [{id, label, body}]; this
 * module renders them to a contiguous markdown string AND emits the line
 * counts that go into frontmatter.anchors.
 *
 * Read-by-anchor (contextFs.read(path, {anchor})) uses these line counts to
 * slice the body without re-parsing.
 */

const SEPARATOR = '\n\n';

/**
 * @param {Array<{id: string, label: string, body: string}>} segments
 * @returns {{body: string, anchors: Array<{id, label, line_count}>}}
 */
function render(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { body: '', anchors: [] };
  }

  const anchors = [];
  const parts = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const header = `## ${seg.label}`;
    const block = `${header}\n\n${seg.body || ''}`;
    const piece = (i === 0 ? '' : SEPARATOR) + block;
    parts.push(piece);
    // Count the lines this piece contributes to the concatenated body. For
    // segments after the first, the leading '\n' of the separator terminates
    // the previous piece's last line rather than starting a new one — so we
    // subtract 1 to avoid double-counting the boundary line. With this, the
    // sum of line_counts always equals body.split('\n').length.
    const rawLines = piece.split('\n').length;
    const lineCount = i === 0 ? rawLines : rawLines - 1;
    anchors.push({ id: seg.id, label: seg.label, line_count: lineCount });
  }

  return { body: parts.join(''), anchors };
}

/**
 * Extract the body lines belonging to a named anchor.
 *
 * @param {string} body — the rendered body string (no frontmatter)
 * @param {Array<{id, line_count}>} anchors — from frontmatter
 * @param {string} anchorId
 * @returns {string|null} — the slice, or null if anchor not found
 */
function slice(body, anchors, anchorId) {
  if (!Array.isArray(anchors)) return null;
  let start = 0;
  for (const a of anchors) {
    if (a.id === anchorId) {
      const lines = body.split('\n');
      return lines.slice(start, start + a.line_count).join('\n');
    }
    start += a.line_count;
  }
  return null;
}

/**
 * Slice by offset/limit (line-based, RFC 6902-style numbering from 0).
 * If body has fewer lines than offset, returns ''.
 *
 * @param {string} body
 * @param {number} offset
 * @param {number} limit
 * @returns {{slice: string, truncated: boolean}}
 */
function sliceByLines(body, offset, limit) {
  const lines = body.split('\n');
  const start = Math.max(0, offset || 0);
  const end = limit != null ? Math.min(lines.length, start + limit) : lines.length;
  const truncated = end < lines.length;
  return { slice: lines.slice(start, end).join('\n'), truncated };
}

module.exports = { render, slice, sliceByLines };
