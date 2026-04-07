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
        lines.push('- ' + text);
        break;

      case 'ol':
        lines.push('1. ' + text);
        break;

      case 'quote':
        lines.push('> ' + text);
        break;

      case 'img': {
        const alt = b.alt || '';
        const src = b.src || '';
        lines.push(`![${alt}](${src})`);
        break;
      }

      case 'divider':
        lines.push('---');
        break;

      case 'faq':
        if (b.faqItems && b.faqItems.length > 0) {
          lines.push('## FAQ');
          lines.push('');
          b.faqItems.forEach((item) => {
            lines.push('### ' + (item.question || ''));
            lines.push('');
            lines.push(item.answer || '');
            lines.push('');
          });
        }
        break;

      case 'table':
        if (b.tableData) {
          const { headers, rows } = b.tableData;
          if (headers && headers.length > 0) {
            lines.push('| ' + headers.join(' | ') + ' |');
            lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
            if (rows) {
              rows.forEach((row) => {
                lines.push('| ' + row.join(' | ') + ' |');
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
        // Table of contents is an editor-only feature, skip in markdown
        break;

      case 'cta':
        // CTA is an editor-only feature, render as link
        if (b.ctaData) {
          lines.push(`[${b.ctaData.buttonText || 'Click here'}](${b.ctaData.url || '#'})`);
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
