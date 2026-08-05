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
  //
  // The lookbehind is load-bearing: without it this rule matches the
  // `[alt](src)` half of an image, so `![alt](src)` became `!<a href="src">alt</a>`
  // — a paid image silently downgraded to a hyperlink with a stray "!".
  //
  // Paragraphs never reach here with an image in them (pushParagraph promotes
  // those to img blocks first). Everywhere else — list items, headings,
  // blockquotes, table cells — an image cannot be promoted without destroying
  // the container, so the markdown is left LITERAL. That is deliberate: it
  // preserves the src, round-trips byte-for-byte through htmlInlineToMd (which
  // has no tags to strip), and shows the author something is wrong rather than
  // quietly publishing a wrong link.
  s = s.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

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

/** Matches an inline image anywhere in a line: ![alt](src) or ![alt](src "title"). */
const INLINE_IMAGE_RE = /!\[([^\]]*)\]\((\S+?)(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;

/**
 * Push a paragraph, promoting any inline images inside it to their own `img`
 * blocks and keeping the surrounding prose as paragraphs around them.
 *
 * Without this an inline image was DESTROYED: mdInlineToHtml's link rule
 * matches the `[alt](src)` half of `![alt](src)` and leaves the `!` stranded,
 * so `see ![chart](url) here` became `see !<a href="url">chart</a> here` — the
 * image silently downgraded to a hyperlink. It also stopped being an `img`
 * block, so the save path never re-hosted it to B2 and the engine's temporary
 * URL expired into a dead link an hour later.
 *
 * Promotion (rather than an inline <img> tag) is the only representation that
 * survives a round trip: blocksToMarkdown's htmlInlineToMd strips every tag it
 * has no rule for, so an <img> embedded in paragraph HTML would serialize to
 * nothing at all.
 */
function pushParagraph(blocks, text, nextId) {
  // Defensive only: exec() already resets lastIndex when it returns null, and
  // the loop below always runs to exhaustion. This matters only if a future
  // edit adds an early break — at which point a module-level /g regex would
  // start every subsequent call mid-string.
  INLINE_IMAGE_RE.lastIndex = 0;
  let last = 0;
  let m;
  let found = false;
  while ((m = INLINE_IMAGE_RE.exec(text)) !== null) {
    found = true;
    const before = text.slice(last, m.index).trim();
    if (before) blocks.push({ id: nextId(), type: 'p', text: mdInlineToHtml(before) });
    const img = { id: nextId(), type: 'img', text: '', alt: m[1], src: m[2] };
    if (m[3]) img.caption = m[3].replace(/\\(.)/g, '$1');
    blocks.push(img);
    last = m.index + m[0].length;
  }
  if (!found) {
    blocks.push({ id: nextId(), type: 'p', text: mdInlineToHtml(text) });
    return;
  }
  const after = text.slice(last).trim();
  if (after) blocks.push({ id: nextId(), type: 'p', text: mdInlineToHtml(after) });
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

    // Phase 10 (CHANGE-PERCEPTION plan): <!-- sr:* --> anchor tokens carry
    // editor blocks (CTA, table of contents). This parser's one production
    // consumer is conformance.js, which COUNTS WORDS — an anchor parsed as a
    // paragraph would add its JSON tokens to a section's word count and skew
    // drift checks. Zero words is the honest value for an anchor: skip it.
    if (/^<!--\s*sr:\/?(toc|cta|faq)\b.*-->\s*$/.test(trimmed)) {
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

    // Image line: ![alt](src) or ![alt](src "title"). MUST consume the line
    // unconditionally: the paragraph collector below EXCLUDES `![` lines, and
    // with no branch owning them the outer while never advanced — an
    // image-bearing document hung this parser (and conformance.js with it) in
    // an infinite loop. Pre-existing; surfaced by the Phase 12 parity fixture,
    // the first test input containing an image.
    if (trimmed.startsWith('![')) {
      const imgMatch = trimmed.match(/^!\[([^\]]*)\]\((\S+?)(?:\s+"((?:[^"\\]|\\.)*)")?\)$/);
      if (imgMatch) {
        blocks.push({ id: nextId(), type: 'img', text: '', alt: imgMatch[1], src: imgMatch[2] });
      } else {
        // Not a WHOLE-line image — most often a real image with prose after it
        // (`![a](src) and here is why`). The strict regex above is anchored, so
        // this branch owns that case, and pushing a plain paragraph would drop
        // the image: no img block means the save path never re-hosts it.
        // pushParagraph promotes any image it finds and otherwise degrades to
        // exactly the paragraph this used to emit, so genuinely mangled syntax
        // still stays visible rather than looping or vanishing.
        pushParagraph(blocks, trimmed, nextId);
      }
      i++;
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
      pushParagraph(blocks, paraLines.join(' '), nextId);
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

module.exports = { markdownToBlocks, mdInlineToHtml, stripHtml };
