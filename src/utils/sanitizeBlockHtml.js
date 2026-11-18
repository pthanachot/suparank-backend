/**
 * Server-side allowlist sanitizer for editor block HTML (QA Nov 2026: N1).
 *
 * Defence in depth. The editor assigns block text to innerHTML, so anything
 * stored in block.text is executable markup the next time any collaborator
 * opens the document. The client paste path is being fixed separately; this
 * makes the SAVE path refuse to persist markup that can run or load anything,
 * whatever client (or crafted request) sent it.
 *
 * Allowlist (everything else is unwrapped, keeping its text, or dropped whole):
 *   b strong i em u s del strike code a br span sub sup mark
 *   a:     href (http, https, mailto, tel, or relative / #anchor), target, rel
 *   all:   title, class, data-sr-* markers, and a FILTERED style
 * Style survives only as a list of known-safe properties with plain values
 * (colour, background colour, weight, emphasis, decoration, cursor, display
 * and the box properties the editor's own CTA links use). No url(), no
 * expression(), no escapes, no comments, no javascript:.
 * Dropped with their content: script, style, iframe, object, embed, svg, math,
 * template, noscript, img/media, form controls, and anything that loads.
 *
 * Parsing uses cheerio (parse5 under the hood — the same HTML5 algorithm the
 * browser runs on innerHTML), never a regex, so the tree we judge is the tree
 * the browser will build. When nothing in that tree is disallowed the ORIGINAL
 * string is returned untouched: a clean document is never rewritten, so saves
 * don't churn stored text (entity spelling, attribute order) and a clean
 * autosave stays byte-identical. Only a string that contained something
 * disallowed is re-serialized from the cleaned tree.
 */

const cheerio = require('cheerio');

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'code', 'a', 'br', 'span', 'sub', 'sup', 'mark',
]);
const VOID_TAGS = new Set(['br']);
// Block types whose `text` is edited in a plain <input>/<textarea>, never
// rendered as HTML (see sanitizeBlock).
const PLAIN_TEXT_TYPES = new Set(['cta', 'code']);
// Removed together with everything inside them.
const DROP_WHOLE = new Set([
  'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template',
  'head', 'title', 'meta', 'link', 'base', 'svg', 'math', 'img', 'image', 'picture', 'source', 'video',
  'audio', 'track', 'canvas', 'form', 'input', 'textarea', 'select', 'option', 'button', 'xmp',
  'plaintext', 'noembed', 'noframes', 'param', 'portal',
]);

const SAFE_STYLE_PROPS = new Set([
  // font-size: the editor's own size control stores <span style="font-size:Npx">
  // (SupaEditor applyFontSize); dropping it erased user formatting on save.
  'color', 'background-color', 'background', 'font-weight', 'font-style', 'font-size', 'text-decoration',
  'text-decoration-line', 'cursor', 'display', 'padding', 'border-radius', 'vertical-align',
]);
// A plain CSS value: words, numbers, units, #hex, rgb()/rgba()/hsl() with
// numeric arguments, var(--token) names. No url, quotes, escapes or comments.
const SAFE_STYLE_VALUE = /^(?:[a-z0-9#%.\-\s,]+|(?:rgba?|hsla?)\([\d\s.,%]+\)|var\(--[a-z0-9-]+\))+$/i;
const DANGEROUS_CSS = /url\s*\(|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|\\|\/\*|<|>/i;

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const SAFE_TARGETS = new Set(['_blank', '_self', '_parent', '_top']);

/** http(s)/mailto/tel, or a scheme-less relative/anchor URL. */
function safeHref(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  // Browsers strip control chars and whitespace before resolving a scheme
  // ("java\nscript:"), so detection must too.
  const compact = url.toLowerCase().replace(/[\u0000- \u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  if (scheme && !SAFE_SCHEMES.has(scheme[1])) return null;
  return url;
}

function safeStyle(raw) {
  const decls = String(raw || '').split(';');
  const kept = [];
  for (const d of decls) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    const prop = d.slice(0, i).trim().toLowerCase();
    const value = d.slice(i + 1).trim();
    if (!SAFE_STYLE_PROPS.has(prop) || !value) continue;
    if (DANGEROUS_CSS.test(value) || !SAFE_STYLE_VALUE.test(value)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.join(';');
}

/**
 * Every declaration as written, in safeStyle's output spelling. Equal to
 * safeStyle(raw) only when safeStyle dropped nothing; any non-blank segment
 * it would skip (no colon, empty value) keeps them unequal.
 */
function normalizeStyle(raw) {
  return String(raw || '').split(';')
    .map((d) => {
      const i = d.indexOf(':');
      if (i < 0) return d.trim() ? '\u0000' : '';
      return `${d.slice(0, i).trim().toLowerCase()}:${d.slice(i + 1).trim()}`;
    })
    .filter(Boolean)
    .join(';');
}

function escText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
}
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
}

/**
 * Filter one element's attributes. Returns [kept attrs, changed?].
 * Any attribute dropped or rewritten marks the string as changed.
 */
function filterAttrs(tag, attribs) {
  const out = [];
  let changed = false;
  for (const [nameRaw, value] of Object.entries(attribs || {})) {
    const name = nameRaw.toLowerCase();
    let keep = null;
    if (name === 'href' && tag === 'a') keep = safeHref(value);
    else if (name === 'target' && tag === 'a') keep = SAFE_TARGETS.has(String(value).toLowerCase()) ? value : null;
    else if (name === 'rel' && tag === 'a') keep = /^[a-z\s-]*$/i.test(value) ? value : null;
    else if (name === 'title') keep = value;
    else if (name === 'class') keep = /^[a-z0-9_\s-]*$/i.test(value) ? value : null;
    else if (/^data-sr-[a-z0-9-]+$/.test(name)) keep = value;
    else if (name === 'style') {
      const st = safeStyle(value);
      // Nothing was filtered out → keep the value as written. Comparing to the
      // raw string flagged mere spacing ("font-size: 24px", Chrome's own
      // execCommand output) as a change and rewrote clean documents on save.
      keep = st && st === normalizeStyle(value) ? value : (st || null);
      if (keep !== null && keep !== value) changed = true;
    }
    if (keep === null) { changed = true; continue; }
    if (keep !== value) changed = true;
    out.push([name, keep]);
  }
  return [out, changed];
}

function walk(nodes, state) {
  let html = '';
  for (const node of nodes || []) {
    if (node.type === 'text') {
      html += escText(node.data || '');
      continue;
    }
    if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      const tag = String(node.name || '').toLowerCase();
      if (DROP_WHOLE.has(tag) || node.type !== 'tag') { state.changed = true; continue; }
      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown container (div, p, font, h2...): keep the text, lose the tag.
        state.changed = true;
        html += walk(node.children, state);
        continue;
      }
      const [attrs, attrChanged] = filterAttrs(tag, node.attribs);
      if (attrChanged) state.changed = true;
      if (tag === 'a' && !attrs.some(([n]) => n === 'href') && node.attribs && 'href' in node.attribs) {
        // An anchor whose href was unsafe becomes plain text, not a dead link.
        html += walk(node.children, state);
        continue;
      }
      const attrStr = attrs.map(([n, v]) => ` ${n}="${escAttr(String(v))}"`).join('');
      if (VOID_TAGS.has(tag)) { html += `<${tag}${attrStr}>`; continue; }
      html += `<${tag}${attrStr}>${walk(node.children, state)}</${tag}>`;
      continue;
    }
    // comment, directive, cdata, processing instruction: never kept.
    state.changed = true;
  }
  return html;
}

/**
 * Sanitize one HTML fragment. Non-strings pass through unchanged (the schema
 * casts/validates types elsewhere).
 */
function sanitizeInlineHtml(input) {
  if (typeof input !== 'string' || input === '') return input;
  // Fast path: no markup and no entity → nothing a parser could turn into an
  // element. Plain prose ("a < b" included) is returned as typed.
  if (!/[<&]/.test(input)) return input;
  const $ = cheerio.load(input, null, false);
  const state = { changed: false };
  const out = walk($.root()[0].children, state);
  return state.changed ? out : input;
}

/**
 * Sanitize every rendered text field of one block, in place-safe copy form.
 * Returns { block, changed }.
 */
function sanitizeBlock(block) {
  if (!block || typeof block !== 'object') return { block, changed: false };
  let changed = false;
  const clean = (v) => {
    const next = sanitizeInlineHtml(v);
    if (next !== v) changed = true;
    return next;
  };
  const b = { ...block };
  // Only `text` is rich HTML (the editor renders it through innerHTML). The
  // structured fields (FAQ question/answer, table cells and caption, toggle
  // summary/content, CTA button and block text, image caption, code) are
  // plain-text inputs in the editor, rendered as React text, and both exports
  // (backend exportService, frontend blocksToHtml) escape or sanitize them at
  // render time. Running them through the HTML sanitizer protected nothing
  // and destroyed legitimate prose such as a FAQ answer explaining "<script>".
  if (typeof b.text === 'string' && !PLAIN_TEXT_TYPES.has(b.type)) b.text = clean(b.text);
  return { block: b, changed };
}

/** Sanitize a blocks array. Returns { blocks, changed } (blocks is a new array). */
function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return { blocks, changed: false };
  let changed = false;
  const out = blocks.map((blk) => {
    const r = sanitizeBlock(blk);
    if (r.changed) changed = true;
    return r.block;
  });
  return { blocks: out, changed };
}

/** Sanitize blocks inside version snapshots too (a restore puts them back). */
function sanitizeVersions(versions) {
  if (!Array.isArray(versions)) return { versions, changed: false };
  let changed = false;
  const out = versions.map((v) => {
    if (!v || !Array.isArray(v.blocks)) return v;
    const r = sanitizeBlocks(v.blocks);
    if (r.changed) changed = true;
    return { ...v, blocks: r.blocks };
  });
  return { versions: out, changed };
}

// Patterns the audit script reports (stored content that would execute).
const SUSPICIOUS_PATTERNS = [/on[a-z]+\s*=/i, /<\s*script/i, /javascript\s*:/i];

module.exports = {
  sanitizeInlineHtml,
  sanitizeBlock,
  sanitizeBlocks,
  sanitizeVersions,
  safeHref,
  safeStyle,
  SUSPICIOUS_PATTERNS,
};
