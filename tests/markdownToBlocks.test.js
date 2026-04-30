const { markdownToBlocks, mdInlineToHtml } = require('../src/services/markdownToBlocks');
const { blocksToMarkdown } = require('../src/services/blocksToMarkdown');

// ── markdownToBlocks ────────────────────────────────────────

describe('markdownToBlocks', () => {
  test('returns empty array for null/undefined input', () => {
    expect(markdownToBlocks(null)).toEqual([]);
    expect(markdownToBlocks(undefined)).toEqual([]);
    expect(markdownToBlocks('')).toEqual([]);
  });

  test('parses headings h1-h6', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(6);
    expect(blocks[0].type).toBe('h1');
    expect(blocks[1].type).toBe('h2');
    expect(blocks[2].type).toBe('h3');
    expect(blocks[3].type).toBe('h4');
    expect(blocks[4].type).toBe('h5');
    expect(blocks[5].type).toBe('h6');
  });

  test('parses unordered list items (- and *)', () => {
    const md = '- Item one\n* Item two';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('li');
    expect(blocks[0].text).toBe('Item one');
    expect(blocks[1].type).toBe('li');
    expect(blocks[1].text).toBe('Item two');
  });

  test('parses ordered list items', () => {
    const md = '1. First\n2. Second';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('ol');
    expect(blocks[1].type).toBe('ol');
  });

  test('parses block quotes', () => {
    const md = '> This is a quote';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('quote');
    expect(blocks[0].text).toBe('This is a quote');
  });

  test('parses multi-line block quotes as single block', () => {
    const md = '> Line one\n> Line two';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('quote');
    expect(blocks[0].text).toContain('Line one');
    expect(blocks[0].text).toContain('Line two');
  });

  test('parses images with alt text', () => {
    const md = '![sunset photo](https://example.com/sunset.jpg)';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('img');
    expect(blocks[0].alt).toBe('sunset photo');
    expect(blocks[0].src).toBe('https://example.com/sunset.jpg');
  });

  test('parses images with optional title', () => {
    const md = '![alt](https://example.com/img.png "My Title")';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('img');
    expect(blocks[0].alt).toBe('alt');
    expect(blocks[0].src).toBe('https://example.com/img.png');
  });

  test('parses code blocks with language', () => {
    const md = '```javascript\nconst x = 1;\n```';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].codeData.language).toBe('javascript');
    expect(blocks[0].codeData.code).toBe('const x = 1;');
  });

  test('parses code blocks without language', () => {
    const md = '```\nhello world\n```';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].codeData.language).toBe('text');
    expect(blocks[0].codeData.code).toBe('hello world');
  });

  test('parses dividers (---)', () => {
    const md = '---';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('divider');
  });

  test('parses tables', () => {
    const md = '| Name | Score |\n| --- | --- |\n| Alice | 90 |\n| Bob | 85 |';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].tableData.headers).toEqual(['Name', 'Score']);
    expect(blocks[0].tableData.rows).toEqual([['Alice', '90'], ['Bob', '85']]);
  });

  test('parses paragraphs (default)', () => {
    const md = 'This is a paragraph.\n\nThis is another.';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('p');
    expect(blocks[1].type).toBe('p');
  });
});

// ── FAQ post-processing ─────────────────────────────────────

describe('postProcessFaqBlocks (via markdownToBlocks)', () => {
  test('assembles ## FAQ + ### questions into faq block', () => {
    const md = '## FAQ\n\n### What is SEO?\n\nSearch engine optimization.\n\n### Why does it matter?\n\nIt drives traffic.';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('faq');
    expect(blocks[0].faqItems).toHaveLength(2);
    expect(blocks[0].faqItems[0].question).toBe('What is SEO?');
    expect(blocks[0].faqItems[0].answer).toContain('Search engine optimization.');
    expect(blocks[0].faqItems[1].question).toBe('Why does it matter?');
  });

  test('assembles ## Frequently Asked Questions variant', () => {
    const md = '## Frequently Asked Questions\n\n### Q1?\n\nAnswer 1.';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('faq');
    expect(blocks[0].faqItems).toHaveLength(1);
  });

  test('keeps ## FAQ as h2 if no h3 pairs follow', () => {
    const md = '## FAQ\n\nJust a paragraph, no questions.';
    const blocks = markdownToBlocks(md);
    // Should keep the h2 since there are no h3 pairs
    const h2 = blocks.find((b) => b.type === 'h2');
    expect(h2).toBeDefined();
  });
});

// ── mdInlineToHtml ──────────────────────────────────────────

describe('mdInlineToHtml', () => {
  test('converts markdown links to HTML', () => {
    expect(mdInlineToHtml('[click](https://example.com)')).toBe('<a href="https://example.com">click</a>');
  });

  test('converts bold **text**', () => {
    expect(mdInlineToHtml('**bold**')).toBe('<strong>bold</strong>');
  });

  test('converts italic *text*', () => {
    expect(mdInlineToHtml('*italic*')).toBe('<em>italic</em>');
  });

  test('converts strikethrough ~~text~~', () => {
    expect(mdInlineToHtml('~~deleted~~')).toBe('<del>deleted</del>');
  });

  test('handles null/empty', () => {
    expect(mdInlineToHtml(null)).toBe('');
    expect(mdInlineToHtml('')).toBe('');
  });
});

// ── Round-trip fidelity ─────────────────────────────────────

describe('round-trip: blocks → markdown → blocks', () => {
  test('headings survive round-trip', () => {
    const original = [
      { id: '1', type: 'h1', text: 'Title' },
      { id: '2', type: 'h2', text: 'Section' },
      { id: '3', type: 'h3', text: 'Sub' },
    ];
    const md = blocksToMarkdown(original);
    const result = markdownToBlocks(md);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('h1');
    expect(result[1].type).toBe('h2');
    expect(result[2].type).toBe('h3');
  });

  test('paragraphs survive round-trip', () => {
    const original = [
      { id: '1', type: 'p', text: 'First paragraph' },
      { id: '2', type: 'p', text: 'Second paragraph' },
    ];
    const md = blocksToMarkdown(original);
    const result = markdownToBlocks(md);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('p');
    expect(result[0].text).toBe('First paragraph');
  });

  test('images survive round-trip', () => {
    const original = [
      { id: '1', type: 'img', text: '', src: 'https://example.com/img.png', alt: 'test' },
    ];
    const md = blocksToMarkdown(original);
    const result = markdownToBlocks(md);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('img');
    expect(result[0].src).toBe('https://example.com/img.png');
    expect(result[0].alt).toBe('test');
  });

  test('FAQ blocks survive round-trip', () => {
    const original = [{
      id: '1', type: 'faq', text: '',
      faqItems: [
        { question: 'Q1?', answer: 'A1.' },
        { question: 'Q2?', answer: 'A2.' },
      ],
    }];
    const md = blocksToMarkdown(original);
    expect(md).toContain('## FAQ');
    expect(md).toContain('### Q1?');
    const result = markdownToBlocks(md);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('faq');
    expect(result[0].faqItems).toHaveLength(2);
    expect(result[0].faqItems[0].question).toBe('Q1?');
  });

  test('tables survive round-trip', () => {
    const original = [{
      id: '1', type: 'table', text: '',
      tableData: { headers: ['A', 'B'], rows: [['1', '2']] },
    }];
    const md = blocksToMarkdown(original);
    const result = markdownToBlocks(md);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('table');
    expect(result[0].tableData.headers).toEqual(['A', 'B']);
    expect(result[0].tableData.rows).toEqual([['1', '2']]);
  });

  test('code blocks survive round-trip', () => {
    const original = [{
      id: '1', type: 'code', text: '',
      codeData: { language: 'python', code: 'print("hi")' },
    }];
    const md = blocksToMarkdown(original);
    const result = markdownToBlocks(md);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('code');
    expect(result[0].codeData.language).toBe('python');
    expect(result[0].codeData.code).toBe('print("hi")');
  });

  test('mixed document survives round-trip', () => {
    const original = [
      { id: '1', type: 'h1', text: 'My Article' },
      { id: '2', type: 'p', text: 'Intro paragraph.' },
      { id: '3', type: 'h2', text: 'Section 1' },
      { id: '4', type: 'li', text: 'Item A' },
      { id: '5', type: 'li', text: 'Item B' },
      { id: '6', type: 'img', text: '', src: 'https://example.com/photo.jpg', alt: 'photo' },
      { id: '7', type: 'divider', text: '' },
      { id: '8', type: 'h2', text: 'Conclusion' },
      { id: '9', type: 'p', text: 'Final thoughts.' },
    ];
    const md = blocksToMarkdown(original);
    const result = markdownToBlocks(md);
    expect(result.length).toBeGreaterThanOrEqual(original.length);
    expect(result[0].type).toBe('h1');
    expect(result.find((b) => b.type === 'img')).toBeTruthy();
    expect(result.find((b) => b.type === 'divider')).toBeTruthy();
  });

  test('inline formatting survives round-trip (bold, italic, links)', () => {
    const original = [
      { id: '1', type: 'p', text: 'This is <strong>bold</strong> and <em>italic</em> with a <a href="https://x.com">link</a>' },
    ];
    const md = blocksToMarkdown(original);
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
    expect(md).toContain('[link](https://x.com)');
    const result = markdownToBlocks(md);
    expect(result[0].text).toContain('<strong>bold</strong>');
    expect(result[0].text).toContain('<em>italic</em>');
    expect(result[0].text).toContain('<a href="https://x.com">link</a>');
  });
});
