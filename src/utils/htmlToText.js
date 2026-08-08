/**
 * Derive a plain-text alternative from an email's HTML body.
 *
 * WHY. Every email this platform sends is HTML-only — `sendEmail` never set
 * nodemailer's `text` field. A missing text/plain part is a measurable
 * spam-score penalty (SpamAssassin's MIME_HTML_ONLY among others), and this
 * domain also carries password resets and receipts, so the deliverability of
 * the whole domain is the thing at stake.
 *
 * WHY NOT A LIBRARY. `html-to-text` would be the obvious dependency, but
 * nodemailer is currently the only mail package and this runs on the boot
 * path. We control every byte of the markup being converted (it all comes out
 * of emailPortalController), so a targeted converter is enough and adds no
 * supply-chain surface. It is deliberately NOT a general-purpose HTML parser.
 *
 * Order matters in `htmlToText` and each step is commented — several of them
 * are only correct because they run after the one above.
 */

const { htmlUnescape } = require('./htmlEscape');

/** Elements whose CONTENT must never reach the text part. */
const DROPPED_CONTENT = ['head', 'style', 'script', 'title'];

/** Block-level tags that should force a line break. */
const BLOCKS = ['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'table', 'blockquote'];

/**
 * Zero-width and hair-space characters used to pad the preheader. They are
 * invisible in HTML and would be invisible-but-present in the text part, so
 * they are dropped once decoded rather than matched as entities (the same
 * character can arrive as `&#8203;`, `&#x200B;` or raw).
 */
const INVISIBLE = /[​-‍͏    ﻿]/g;

/**
 * Named entities the templates hand-write, which htmlUnescape does not cover.
 * Deliberately a short explicit list rather than a full HTML entity table:
 * we author every template, `tests/emailPlainText.test.js` fails if one
 * appears that is not handled here, and a 2000-entry table would be dead
 * weight on the boot path.
 */
const NAMED = {
  '&mdash;': '—',
  '&ndash;': '–',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&hellip;': '…',
  '&nbsp;': ' ',
  '&zwnj;': '',
  '&middot;': '·',
  '&bull;': '•',
};

/**
 * Decode one numeric character reference.
 * `String.fromCharCode` truncates to 16 bits, which silently mangles anything
 * above U+FFFF — an emoji in a prompt or a brand name would come out as a
 * stray surrogate. `fromCodePoint` throws on out-of-range input, so invalid
 * references are left as the literal text they were.
 */
function codePoint(value, original) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return original;
  }
}

function htmlToText(html) {
  if (!html) return '';
  let s = String(html);

  // 1. Conditional comments FIRST. Outlook's `<!--[if mso]>…<![endif]-->`
  //    wraps real markup, and a generic comment strip would leave that markup
  //    behind as duplicated content.
  s = s.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2. The preheader is the inbox-snippet line; it exists to be read INSTEAD
  //    of the body's opening, so repeating it at the top of the text part is
  //    noise. Matched by its marker class, not by display:none — parsing
  //    inline styles with a regex is exactly the wrong tool.
  s = s.replace(/<div class="sr-preheader"[\s\S]*?<\/div>/gi, '');

  // 3. Drop <head>, <style>, <script>, <title> WITH their content. Without
  //    this the shell's CSS reset lands in the plain-text body as a wall of
  //    selectors — the single most common bug in hand-rolled converters.
  for (const tag of DROPPED_CONTENT) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
  }

  // 4. Links become "label (url)" so the text part stays actionable — a
  //    password-reset mail whose button vanished is useless. Skip when the
  //    label already IS the url, and skip mailto/anchor hrefs.
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const text = label.replace(/<[^>]+>/g, '').trim();
    const url = href.trim();
    if (!url || url.startsWith('#') || url.startsWith('mailto:')) return text;
    if (!text) return url;
    if (text === url) return url;
    return `${text} (${url})`;
  });

  // 5. Explicit breaks, then block boundaries.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:td|th)>\s*(?=<(?:td|th))/gi, '\t'); // keep table columns apart
  for (const tag of BLOCKS) {
    s = s.replace(new RegExp(`</${tag}>`, 'gi'), '\n');
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '\n');
  }

  // 6. Everything else goes.
  s = s.replace(/<[^>]+>/g, '');

  // 7. Entities LAST, so a decoded "<" from `&lt;` can never be mistaken for
  //    a tag by the steps above.
  //
  //    NUMERIC BEFORE NAMED, and this order is not interchangeable. htmlEscape
  //    turns a user's literal "&" into "&amp;", so someone who types "&#60;"
  //    into a contact form produces "&amp;#60;" in the HTML, which must read
  //    back as "&#60;" — not as "<". Decoding named entities first would turn
  //    it into "&#60;" and the numeric pass would then finish the job and
  //    yield "<". Going numeric-first, "&amp;#60;" has no "&#\d+;" to match
  //    (the "#60;" is preceded by ";"), so only the named pass fires and the
  //    text round-trips. Same invariant htmlUnescape documents internally.
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePoint(parseInt(hex, 16), m));
  s = s.replace(/&#(\d+);/g, (m, dec) => codePoint(Number(dec), m));
  //    Named entities beyond the five htmlEscape produces. htmlUnescape only
  //    knows those five — by design, since it is the exact inverse of
  //    htmlEscape — but the templates hand-write typographic ones in their
  //    copy, and without this the text part reads "Hi Alex &mdash; ...".
  for (const [entity, char] of Object.entries(NAMED)) {
    s = s.replace(new RegExp(entity, 'gi'), char);
  }
  s = htmlUnescape(s);
  s = s.replace(INVISIBLE, '');

  // 8. Tidy: trailing spaces, runs of blank lines, leading/trailing blanks.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/, ''))
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

module.exports = { htmlToText };
