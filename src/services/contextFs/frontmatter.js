/**
 * Minimal YAML frontmatter emitter, scoped to the shape CFS generators
 * produce. Not a general YAML serializer — handles the keys/types we use:
 *   - string, number, boolean, null
 *   - arrays of scalars
 *   - arrays of flat objects (e.g. anchors: [{id, label, line_count}])
 *
 * We don't need a parser: generators return both the rendered string AND
 * the structured frontmatter object, so anchor-aware reads access fields
 * via the object directly. Re-parsing our own output would be wasted work.
 */

function needsQuoting(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  // YAML special chars at start or anywhere problematic
  if (/^[-?:|>!&*%@`#]/.test(s)) return true;
  if (/[:#\n\r"'`]/.test(s)) return true;
  // Boolean-like or number-like strings that could be misparsed
  if (/^(true|false|null|yes|no|on|off)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  return false;
}

function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') {
    return needsQuoting(v) ? JSON.stringify(v) : v;
  }
  // Fallback — should not happen with our schema
  return JSON.stringify(v);
}

function emitField(key, value, indent = 0) {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}: []`;

    // Array of flat objects → list of mappings
    if (typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0])) {
      const lines = [`${pad}${key}:`];
      for (const item of value) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${pad}  - {}`);
          continue;
        }
        entries.forEach(([k, v], i) => {
          const prefix = i === 0 ? '- ' : '  ';
          lines.push(`${pad}  ${prefix}${k}: ${formatScalar(v)}`);
        });
      }
      return lines.join('\n');
    }

    // Array of scalars
    return [`${pad}${key}:`, ...value.map((v) => `${pad}  - ${formatScalar(v)}`)].join('\n');
  }

  // Scalar
  return `${pad}${key}: ${formatScalar(value)}`;
}

function emitFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return '---\n---';
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(emitField(k, v));
  }
  lines.push('---');
  return lines.join('\n');
}

function emitFile(frontmatter, body) {
  const fm = emitFrontmatter(frontmatter);
  return fm + '\n' + (body || '');
}

module.exports = { emitFrontmatter, emitFile, formatScalar, needsQuoting };
