const { blocksToMarkdown, htmlInlineToMd, stripHtml } = require('../src/services/blocksToMarkdown');

// ── blocksToMarkdown ────────────────────────────────────────

describe('blocksToMarkdown', () => {
  test('returns empty string for null/undefined input', () => {
    expect(blocksToMarkdown(null)).toBe('');
    expect(blocksToMarkdown(undefined)).toBe('');
    expect(blocksToMarkdown('not an array')).toBe('');
  });

  test('converts headings h1-h6 to markdown #', () => {
    const blocks = [
      { id: '1', type: 'h1', text: 'Title' },
      { id: '2', type: 'h2', text: 'Section' },
      { id: '3', type: 'h3', text: 'Subsection' },
      { id: '4', type: 'h4', text: 'Deep' },
      { id: '5', type: 'h5', text: 'Deeper' },
      { id: '6', type: 'h6', text: 'Deepest' },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('# Title');
    expect(md).toContain('## Section');
    expect(md).toContain('### Subsection');
    expect(md).toContain('#### Deep');
    expect(md).toContain('##### Deeper');
    expect(md).toContain('###### Deepest');
  });

  test('converts paragraph blocks to plain text', () => {
    const blocks = [{ id: '1', type: 'p', text: 'Hello world' }];
    expect(blocksToMarkdown(blocks)).toBe('Hello world');
  });

  test('converts unordered list items', () => {
    const blocks = [
      { id: '1', type: 'li', text: 'Item one' },
      { id: '2', type: 'li', text: 'Item two' },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('- Item one');
    expect(md).toContain('- Item two');
  });

  test('converts ordered list items', () => {
    const blocks = [
      { id: '1', type: 'ol', text: 'First' },
      { id: '2', type: 'ol', text: 'Second' },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('1. First');
    expect(md).toContain('1. Second');
  });

  test('converts quote blocks', () => {
    const blocks = [{ id: '1', type: 'quote', text: 'A wise saying' }];
    expect(blocksToMarkdown(blocks)).toBe('> A wise saying');
  });

  test('converts image blocks', () => {
    const blocks = [{ id: '1', type: 'img', text: '', src: 'https://example.com/img.png', alt: 'example image' }];
    expect(blocksToMarkdown(blocks)).toBe('![example image](https://example.com/img.png)');
  });

  test('converts image blocks with empty alt', () => {
    const blocks = [{ id: '1', type: 'img', text: '', src: 'https://example.com/img.png' }];
    expect(blocksToMarkdown(blocks)).toBe('![](https://example.com/img.png)');
  });

  test('converts divider blocks', () => {
    const blocks = [{ id: '1', type: 'divider', text: '' }];
    expect(blocksToMarkdown(blocks)).toBe('---');
  });

  test('converts FAQ blocks to ## FAQ with ### questions', () => {
    const blocks = [{
      id: '1', type: 'faq', text: '',
      faqItems: [
        { question: 'What is SEO?', answer: 'Search engine optimization.' },
        { question: 'Why does it matter?', answer: 'It drives traffic.' },
      ],
    }];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('## FAQ');
    expect(md).toContain('### What is SEO?');
    expect(md).toContain('Search engine optimization.');
    expect(md).toContain('### Why does it matter?');
    expect(md).toContain('It drives traffic.');
  });

  test('converts table blocks to pipe-delimited markdown', () => {
    const blocks = [{
      id: '1', type: 'table', text: '',
      tableData: {
        headers: ['Name', 'Score'],
        rows: [['Alice', '90'], ['Bob', '85']],
      },
    }];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('| Name | Score |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Alice | 90 |');
    expect(md).toContain('| Bob | 85 |');
  });

  test('converts code blocks with language', () => {
    const blocks = [{
      id: '1', type: 'code', text: '',
      codeData: { language: 'javascript', code: 'const x = 1;' },
    }];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('```javascript');
    expect(md).toContain('const x = 1;');
    expect(md).toContain('```');
  });

  test('skips TOC blocks (editor-only)', () => {
    const blocks = [
      { id: '1', type: 'h1', text: 'Title' },
      { id: '2', type: 'toc', text: '' },
      { id: '3', type: 'p', text: 'Content' },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).not.toContain('toc');
    expect(md).toContain('# Title');
    expect(md).toContain('Content');
  });

  test('converts CTA blocks to markdown link', () => {
    const blocks = [{
      id: '1', type: 'cta', text: '',
      ctaData: { buttonText: 'Sign Up', url: 'https://example.com/signup' },
    }];
    expect(blocksToMarkdown(blocks)).toBe('[Sign Up](https://example.com/signup)');
  });

  test('converts CTA with missing data to defaults', () => {
    const blocks = [{ id: '1', type: 'cta', text: '', ctaData: {} }];
    expect(blocksToMarkdown(blocks)).toBe('[Click here](#)');
  });
});

// ── htmlInlineToMd ──────────────────────────────────────────

describe('htmlInlineToMd', () => {
  test('converts links', () => {
    expect(htmlInlineToMd('<a href="https://example.com">click</a>')).toBe('[click](https://example.com)');
  });

  test('converts bold (strong and b tags)', () => {
    expect(htmlInlineToMd('<strong>bold</strong>')).toBe('**bold**');
    expect(htmlInlineToMd('<b>bold</b>')).toBe('**bold**');
  });

  test('converts italic (em and i tags)', () => {
    expect(htmlInlineToMd('<em>italic</em>')).toBe('*italic*');
    expect(htmlInlineToMd('<i>italic</i>')).toBe('*italic*');
  });

  test('converts strikethrough', () => {
    expect(htmlInlineToMd('<del>removed</del>')).toBe('~~removed~~');
    expect(htmlInlineToMd('<s>removed</s>')).toBe('~~removed~~');
    expect(htmlInlineToMd('<strike>removed</strike>')).toBe('~~removed~~');
  });

  test('strips underline tags (no md equivalent)', () => {
    expect(htmlInlineToMd('<u>underlined</u>')).toBe('underlined');
  });

  test('strips unknown HTML tags', () => {
    expect(htmlInlineToMd('<span class="x">text</span>')).toBe('text');
  });

  test('handles null/empty input', () => {
    expect(htmlInlineToMd(null)).toBe('');
    expect(htmlInlineToMd('')).toBe('');
  });

  test('converts mixed inline formatting', () => {
    const html = 'This is <strong>bold</strong> and <em>italic</em> with a <a href="https://x.com">link</a>';
    const md = htmlInlineToMd(html);
    expect(md).toBe('This is **bold** and *italic* with a [link](https://x.com)');
  });
});

// ── stripHtml ───────────────────────────────────────────────

describe('stripHtml', () => {
  test('strips all HTML tags', () => {
    expect(stripHtml('<strong>bold</strong> text')).toBe('bold text');
  });

  test('handles null/empty input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});
