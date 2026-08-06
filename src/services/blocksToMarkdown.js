/**
 * Convert editor Block[] to markdown string.
 * Ported from frontend utils.ts — must stay in sync.
 *
 * Used by the AI integration layer to send document content
 * to the Writing Engine in markdown format.
 */

/**
 * Convert inline HTML to markdown.
 * Handles: links, bold, italic, underline, strikethrough.
 * @param {string} html
 * @returns {string}
 */
function htmlInlineToMd(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<u>(.*?)<\/u>/gi, '$1');
  s = s.replace(/<(strike|s|del)>(.*?)<\/\1>/gi, '~~$2~~');
  s = s.replace(/<[^>]*>/g, '');
  return s;
}

/**
 * Strip all HTML tags from text.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Escape double quotes for safe embedding in an HTML attribute.
 * @param {string} s
 * @returns {string}
 */
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

/**
 * Convert an array of editor blocks to a markdown string.
 * Handles: headings, paragraphs, lists, quotes, images, FAQ, tables, code, dividers.
 *
 * @param {Array<{id: string, type: string, text: string, src?: string, alt?: string, width?: number, align?: string, faqItems?: Array, tableData?: Object, codeData?: Object}>} blocks
 * @returns {string}
 */
function blocksToMarkdown(blocks) {
  if (!blocks || !Array.isArray(blocks)) return '';

  const lines = [];

  blocks.forEach((b) => {
    const text = htmlInlineToMd(b.text);

    switch (b.type) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = parseInt(b.type[1], 10);
        lines.push('#'.repeat(level) + ' ' + text);
        break;
      }

      case 'li':
        lines.push('  '.repeat(b.indent || 0) + '- ' + text);
        break;

      case 'ol':
        lines.push('  '.repeat(b.indent || 0) + '1. ' + text);
        break;

      case 'quote':
        lines.push('> ' + text);
        break;

      case 'img': {
        const alt = b.alt || '';
        const src = b.src || '';
        // Phase 12: caption as the markdown TITLE — the engine can edit it,
        // and the old separate `*caption*` line (with its stray-paragraph
        // side effects) is retired. Mirror of the frontend serializer; the
        // parity fixture pins the escaping.
        if (b.caption) {
          const title = String(b.caption).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*\n\s*/g, ' ');
          lines.push(`![${alt}](${src} "${title}")`);
        } else {
          lines.push(`![${alt}](${src})`);
        }
        break;
      }

      case 'divider':
        lines.push('---');
        break;

      case 'faq':
        if (b.faqItems && b.faqItems.length > 0) {
          // Phase 11: the anchor announces "an faq block starts here" — the
          // frontend rebuild keys on it (creation from scratch becomes
          // possible; hand-written "## FAQ" sections stay untouched). Mirror
          // of the frontend's engine audience; the parity fixture pins it.
          lines.push('<!-- sr:faq -->');
          lines.push('');
          lines.push('## FAQ');
          lines.push('');
          b.faqItems.forEach((item) => {
            lines.push('### ' + (item.question || ''));
            lines.push('');
            lines.push(item.answer || '');
            lines.push('');
          });
          // Phase 11 (review fix): the terminator bounds the section — the
          // frontend parser's last answer would otherwise absorb whatever
          // follows the faq. Mirror of the frontend's engine audience.
          lines.push('<!-- sr:/faq -->');
        }
        break;

      case 'table':
        if (b.tableData) {
          const { headers, rows, columnAligns } = b.tableData;
          if (headers && headers.length > 0) {
            // Phase 12: pipe-escaped cells + per-column alignment in the
            // separator row. Mirror of the frontend serializer. The ` | `
            // padding in the joins is LOAD-BEARING (see the frontend's
            // comment): it guarantees delimiters are space-preceded, which is
            // what keeps a trailing-backslash cell from swallowing its
            // delimiter under the frontend's escape-aware split.
            const cell = (c) => String(c == null ? '' : c).replace(/\|/g, '\\|');
            const sep = (idx) => {
              const a = columnAligns && columnAligns[idx];
              return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
            };
            lines.push('| ' + headers.map(cell).join(' | ') + ' |');
            lines.push('| ' + headers.map((_, idx) => sep(idx)).join(' | ') + ' |');
            if (rows) {
              rows.forEach((row) => {
                // Guard null/non-array rows — Mongoose can persist a null slot in
                // a [[String]] array, which would otherwise throw on .join.
                lines.push('| ' + (Array.isArray(row) ? row : []).map(cell).join(' | ') + ' |');
              });
            }
          }
        }
        break;

      case 'code':
        if (b.codeData) {
          lines.push('```' + (b.codeData.language || ''));
          lines.push(b.codeData.code || '');
          lines.push('```');
        }
        break;

      case 'toc':
        // Phase 10 (CHANGE-PERCEPTION plan): a position-carrying anchor token
        // the model preserves verbatim / moves / omits-to-delete, so a rewrite
        // keeps the TOC where the author put it. This is the ENGINE-audience
        // form ONLY — this serializer never produces user-facing markdown.
        // MUST stay byte-identical with the frontend's engine audience
        // (components/editor/utils.ts) — the serializer-parity fixture in both
        // repos pins it.
        lines.push('<!-- sr:toc -->');
        break;

      case 'cta':
        // Phase 10: full payload in the anchor JSON so the engine can move,
        // edit or delete the block like any other line. ">" is emitted as its
        // unicode escape so no payload can close the comment early. Mirror of
        // the frontend's engine audience — see the toc note above.
        if (b.ctaData) {
          lines.push(`<!-- sr:cta ${JSON.stringify(b.ctaData).replace(/>/g, '\\u003e')} -->`);
        }
        break;

      case 'toggle':
        // Serialized as a raw-HTML <details> block so the content survives
        // the engine round-trip (the editor reconstructs it on apply —
        // reconstructStructuredBlocks in the frontend). Dropping it here
        // destroyed toggle blocks on every agent run.
        if (b.toggleData) {
          lines.push('<details>');
          lines.push(`<summary>${b.toggleData.summary || 'Toggle'}</summary>`);
          lines.push('');
          lines.push(b.toggleData.content || '');
          lines.push('');
          lines.push('</details>');
        }
        break;

      case 'embed':
        // Serialized as a raw-HTML iframe carrying the original url +
        // embed type in data attributes so the editor can reconstruct the
        // embed block after the engine round-trip.
        if (b.embedData && b.embedData.url) {
          const src = escapeAttr(b.embedData.embedUrl || b.embedData.url);
          const type = escapeAttr(b.embedData.embedType || 'generic');
          const url = escapeAttr(b.embedData.url);
          lines.push(`<iframe src="${src}" data-embed-type="${type}" data-url="${url}"></iframe>`);
        }
        break;

      default:
        // paragraph or unknown — output as plain text
        lines.push(text);
        break;
    }

    lines.push('');
  });

  return lines.join('\n').trim();
}

module.exports = { blocksToMarkdown, htmlInlineToMd, stripHtml };
