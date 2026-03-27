// Lightweight HTML parsing for user content — mirrors Go scorer's parseHTMLContent

function stripTags(html) {
  let result = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') { inTag = true; continue; }
    if (ch === '>') { inTag = false; result += ' '; continue; }
    if (!inTag) result += ch;
  }
  return result.replace(/\s+/g, ' ').trim();
}

function extractTagContents(html, tag) {
  const results = [];
  const openTag = '<' + tag;
  const closeTag = '</' + tag + '>';
  let search = html.toLowerCase();

  while (true) {
    const idx = search.indexOf(openTag);
    if (idx === -1) break;

    const gtIdx = search.indexOf('>', idx);
    if (gtIdx === -1) break;

    const contentStart = gtIdx + 1;
    const endIdx = search.indexOf(closeTag, contentStart);
    if (endIdx === -1) break;

    const content = stripTags(search.substring(contentStart, endIdx)).trim();
    if (content) results.push(content);

    search = search.substring(endIdx + closeTag.length);
  }
  return results;
}

function extractExactTag(html, tag) {
  const results = [];
  const openTag = '<' + tag;
  const closeTag = '</' + tag + '>';
  let search = html.toLowerCase();

  while (true) {
    const idx = search.indexOf(openTag);
    if (idx === -1) break;

    const afterTag = idx + openTag.length;
    if (afterTag < search.length) {
      const ch = search[afterTag];
      if (ch !== '>' && ch !== ' ' && ch !== '\t' && ch !== '\n') {
        search = search.substring(afterTag);
        continue;
      }
    }

    const gtIdx = search.indexOf('>', idx);
    if (gtIdx === -1) break;

    const contentStart = gtIdx + 1;
    const endIdx = search.indexOf(closeTag, contentStart);
    if (endIdx === -1) break;

    const content = stripTags(search.substring(contentStart, endIdx)).trim();
    if (content) results.push(content);

    search = search.substring(endIdx + closeTag.length);
  }
  return results;
}

function countTag(html, tag) {
  let count = 0;
  const openTag = '<' + tag;
  let search = html.toLowerCase();
  while (true) {
    const idx = search.indexOf(openTag);
    if (idx === -1) break;
    const afterTag = idx + openTag.length;
    if (afterTag < search.length) {
      const ch = search[afterTag];
      if (ch === '>' || ch === ' ' || ch === '\t' || ch === '\n') count++;
    }
    search = search.substring(afterTag);
  }
  return count;
}

function countFAQElements(html) {
  const lower = html.toLowerCase();
  let count = 0;

  count += countTag(lower, 'details');

  if (lower.includes('faqpage') || lower.includes('qapage')) count += 5;

  let questionCount = 0;
  for (const tag of ['h2', 'h3']) {
    for (const heading of extractTagContents(lower, tag)) {
      const h = heading.toLowerCase().trim();
      if (h.endsWith('?') ||
        h.startsWith('what ') || h.startsWith('how ') || h.startsWith('why ') ||
        h.startsWith('when ') || h.startsWith('where ') || h.startsWith('who ') ||
        h.startsWith('is ') || h.startsWith('can ') || h.startsWith('does ')) {
        questionCount++;
      }
    }
  }
  if (questionCount >= 3) count += questionCount;

  return count;
}

function parseHTML(htmlContent) {
  const lower = htmlContent.toLowerCase();
  const bodyText = stripTags(htmlContent);
  const words = bodyText.split(/\s+/).filter(Boolean);

  const h1s = extractTagContents(lower, 'h1');
  const h2s = extractTagContents(lower, 'h2');
  const h3s = extractTagContents(lower, 'h3');
  const h4s = extractTagContents(lower, 'h4');

  // Title
  let title = '';
  const titleIdx = lower.indexOf('<title>');
  if (titleIdx !== -1) {
    const titleEnd = lower.indexOf('</title>', titleIdx);
    if (titleEnd !== -1) title = stripTags(htmlContent.substring(titleIdx + 7, titleEnd)).trim();
  }

  // Meta description
  let metaDescription = '';
  const metaIdx = lower.indexOf('name="description"');
  if (metaIdx !== -1) {
    const start = Math.max(0, metaIdx - 200);
    const end = Math.min(lower.length, metaIdx + 200);
    const region = lower.substring(start, end);
    const ci = region.indexOf('content="');
    if (ci !== -1) {
      const s = ci + 9;
      const e = region.indexOf('"', s);
      if (e !== -1) metaDescription = region.substring(s, e);
    }
  }

  // Count images
  let imageCount = 0;
  let imgSearch = lower;
  while (true) {
    const idx = imgSearch.indexOf('<img');
    if (idx === -1) break;
    const afterTag = idx + 4;
    if (afterTag < imgSearch.length) {
      const ch = imgSearch[afterTag];
      if (ch === '>' || ch === ' ' || ch === '/') imageCount++;
    }
    imgSearch = imgSearch.substring(afterTag);
  }

  // Count links
  let internalLinks = 0;
  let externalLinks = 0;
  let linkSearch = lower;
  while (true) {
    const idx = linkSearch.indexOf('<a ');
    if (idx === -1) break;
    const hrefIdx = linkSearch.indexOf('href=', idx);
    if (hrefIdx !== -1 && hrefIdx < idx + 200) {
      const after = linkSearch.substring(hrefIdx + 6, hrefIdx + 30);
      if (after.startsWith('http://') || after.startsWith('https://')) {
        externalLinks++;
      } else {
        internalLinks++;
      }
    }
    linkSearch = linkSearch.substring(idx + 3);
  }

  return {
    title,
    metaDescription,
    h1s,
    h2s,
    h3s,
    h4s,
    bodyText,
    wordCount: words.length,
    imageCount,
    internalLinks,
    externalLinks,
    listCount: countTag(lower, 'ul') + countTag(lower, 'ol'),
    tableCount: countTag(lower, 'table'),
    faqCount: countFAQElements(htmlContent),
  };
}

module.exports = { parseHTML, stripTags, extractTagContents, extractExactTag };
