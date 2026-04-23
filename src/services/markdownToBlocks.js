/**
 * Convert markdown string to editor Block[].
 * Used ONLY for initial drafts (WriteTool output).
 * All subsequent edits use the patch system (mapEditsToPatches).
 *
 * Handles: headings, paragraphs, lists, quotes, images, code blocks,
 * tables, dividers, and inline formatting (bold, italic, links, strikethrough).
 */

let blockCounter = 0;

function nextId() {
  return 'ai_' + Date.now() + '_' + (++blockCounter);
}

/**
 * Convert markdown inline formatting to HTML.
 * Reverse of htmlInlineToMd — must produce HTML the editor can render.
 *
 * @param {string} md
 * @returns {string}
 */
function mdInlineToHtml(md) {
  if (!md) return '';
  let s = md;

  // Links: [text](url) → <a href="url">text</a>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (but not inside ** or __)
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  return s;
}

/**
 * Parse a markdown string into an array of editor blocks.
 *
 * @param {string} markdown
 * @returns {Array<{id: string, type: string, text: string, [key: string]: any}>}
 */
function markdownToBlocks(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const blocks = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Skip blank lines
    if (trimmed === '') {
      i++;
      continue;
    }

    // Headings: # to ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push({
        id: nextId(),
        type: 'h' + level,
        text: mdInlineToHtml(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Horizontal rule / divider
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ id: nextId(), type: 'divider', text: '' });
      i++;
      continue;
    }

    // Unordered list items: - item or * item
    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push({
        id: nextId(),
        type: 'li',
        text: mdInlineToHtml(trimmed.replace(/^[-*]\s+/, '')),
      });
      i++;
      continue;
    }

    // Ordered list items: 1. item
    if (/^\d+\.\s+/.test(trimmed)) {
      blocks.push({
        id: nextId(),
        type: 'ol',
        text: mdInlineToHtml(trimmed.replace(/^\d+\.\s+/, '')),
      });
      i++;
      continue;
    }

    // Block quote: > text
    if (trimmed.startsWith('> ')) {
      // Collect consecutive quote lines
      const quoteLines = [];
      while (i < lines.length && lines[i].trimEnd().startsWith('> ')) {
        quoteLines.push(lines[i].trimEnd().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        id: nextId(),
        type: 'quote',
        text: mdInlineToHtml(quoteLines.join(' ')),
      });
      continue;
    }

    // Image: ![alt](src) or ![alt](src "title")
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/);
    if (imgMatch) {
      blocks.push({
        id: nextId(),
        type: 'img',
        text: '',
        alt: imgMatch[1],
        src: imgMatch[2],
      });
      i++;
      continue;
    }

    // Code block: ```language
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimEnd().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({
        id: nextId(),
        type: 'code',
        text: '',
        codeData: { language: language || 'text', code: codeLines.join('\n') },
      });
      continue;
    }

    // Table: | header | header |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
        const headers = parseRow(tableLines[0]);
        // Skip separator row (| --- | --- |)
        const dataStart = tableLines[1].includes('---') ? 2 : 1;
        const rows = tableLines.slice(dataStart).map(parseRow);
        blocks.push({
          id: nextId(),
          type: 'table',
          text: '',
          tableData: { headers, rows },
        });
      }
      continue;
    }

    // Paragraph (default) — collect consecutive non-blank, non-special lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trimEnd() !== '' &&
      !lines[i].trimEnd().match(/^#{1,6}\s/) &&
      !lines[i].trimEnd().match(/^[-*]\s+/) &&
      !lines[i].trimEnd().match(/^\d+\.\s+/) &&
      !lines[i].trimEnd().startsWith('> ') &&
      !lines[i].trimEnd().startsWith('```') &&
      !lines[i].trimEnd().match(/^(-{3,}|_{3,}|\*{3,})$/) &&
      !(lines[i].trimEnd().startsWith('|') && lines[i].trimEnd().endsWith('|')) &&
      !lines[i].trimEnd().match(/^!\[/)
    ) {
      paraLines.push(lines[i].trimEnd());
      i++;
    }

    if (paraLines.length > 0) {
      blocks.push({
        id: nextId(),
        type: 'p',
        text: mdInlineToHtml(paraLines.join(' ')),
      });
    }
  }

  return postProcessFaqBlocks(blocks);
}

/**
 * Detect `## FAQ` followed by `### question` / paragraph pairs and
 * re-assemble them into a single `faq` block with `faqItems[]`.
 * This preserves the rich FAQ structure through the markdown round-trip.
 */
function postProcessFaqBlocks(blocks) {
  const result = [];
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];

    // Detect "## FAQ" or "## Frequently Asked Questions"
    if (
      b.type === 'h2' &&
      /^(faq|frequently\s+asked\s+questions)$/i.test(stripHtml(b.text || '').trim())
    ) {
      const faqItems = [];
      i++; // skip the h2

      // Collect h3 + paragraph pairs
      while (i < blocks.length) {
        if (blocks[i].type === 'h3') {
          const question = stripHtml(blocks[i].text || '');
          i++;
          // Collect answer paragraphs until next h3 or non-paragraph block
          const answerParts = [];
          while (i < blocks.length && blocks[i].type === 'p') {
            answerParts.push(blocks[i].text || '');
            i++;
          }
          faqItems.push({ question, answer: answerParts.join('\n\n') });
        } else {
          break; // end of FAQ section
        }
      }

      if (faqItems.length > 0) {
        result.push({ id: nextId(), type: 'faq', text: '', faqItems });
      } else {
        // No h3/p pairs found — keep the heading as-is
        result.push(b);
      }
    } else {
      result.push(b);
      i++;
    }
  }

  return result;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '');
}

module.exports = { markdownToBlocks, mdInlineToHtml };
