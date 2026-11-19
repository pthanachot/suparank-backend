/**
 * QA Nov 2026 (N1) — server-side block HTML sanitizer.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeInlineHtml: s, sanitizeBlock, sanitizeBlocks, sanitizeVersions, safeHref, SUSPICIOUS_PATTERNS,
} = require('../src/utils/sanitizeBlockHtml');

const noExec = (out) => {
  for (const re of SUSPICIOUS_PATTERNS) assert.doesNotMatch(out, re, `${re} survived in ${out}`);
};

test('the QA payload: escaped clipboard text that decodes into an onerror img', () => {
  const out = s('hello <img src=x onerror=alert(1)> world');
  assert.equal(out, 'hello  world');
  noExec(out);
});

test('event handlers are stripped from allowed tags, the tag and text stay', () => {
  assert.equal(s('<strong onclick="alert(1)">bold</strong>'), '<strong>bold</strong>');
  assert.equal(s('<em onmouseover=x>it</em>'), '<em>it</em>');
  assert.equal(s('<b ONLOAD="x" title="t">b</b>'), '<b title="t">b</b>');
});

test('scripts and loaders are dropped with their content', () => {
  for (const bad of [
    '<script>alert(1)</script>', '<style>body{}</style>', '<iframe src="javascript:alert(1)"></iframe>',
    '<svg onload=alert(1)><circle/></svg>', '<math><mi>x</mi></math>', '<object data=x></object>',
    '<noscript><img src=x onerror=alert(1)></noscript>', '<template><img src=x onerror=1></template>',
    '<video><source onerror=alert(1)></video>', '<form action="javascript:x"><button>go</button></form>',
  ]) {
    const out = s(`a${bad}b`);
    assert.equal(out, 'ab', bad);
  }
});

test('javascript:, vbscript:, data: hrefs are removed (link becomes text)', () => {
  for (const href of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', '&#106;avascript:alert(1)', 'vbscript:x', 'data:text/html,<script>1</script>']) {
    const out = s(`<a href="${href}">click</a>`);
    assert.equal(out, 'click', href);
    noExec(out);
  }
});

test('safe links keep href, target and rel', () => {
  const link = '<a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">x</a>';
  assert.equal(s(link), link, 'a clean link is returned byte-identical');
  assert.equal(s('<a href="mailto:a@b.co">m</a>'), '<a href="mailto:a@b.co">m</a>');
  assert.equal(s('<a href="tel:+15551234">t</a>'), '<a href="tel:+15551234">t</a>');
  assert.equal(s('<a href="/relative">r</a>'), '<a href="/relative">r</a>');
  assert.equal(s('<a href="#section">h</a>'), '<a href="#section">h</a>');
  assert.equal(s('<a href="x" target="evil">x</a>'), '<a href="x">x</a>');
});

test('the editor\'s own link and highlight markup survives untouched', () => {
  const editorLink = '<a href="https://x.com" title="https://x.com" style="color:#4338ca;text-decoration:underline;cursor:pointer" target="_blank" rel="noopener">x</a>';
  assert.equal(s(editorLink), editorLink);
  const varLink = '<a href="https://x.com" style="color:var(--sr-primary-700);text-decoration:underline;cursor:pointer">x</a>';
  assert.equal(s(varLink), varLink);
  const mark = '<mark style="background-color:#fde68a">hi</mark>';
  assert.equal(s(mark), mark);
  const rgba = '<mark style="background-color:rgba(253, 230, 138, 0.5)">hi</mark>';
  assert.equal(s(rgba), rgba);
  const cta = '<a data-sr-cta="primary" href="https://x.com">Buy</a>';
  assert.equal(s(cta), cta);
});

test('style-based script is removed, safe declarations kept', () => {
  assert.equal(s('<span style="background:url(javascript:alert(1))">x</span>'), '<span>x</span>');
  assert.equal(s('<span style="width:expression(alert(1))">x</span>'), '<span>x</span>');
  assert.equal(s('<span style="color:red;behavior:url(x.htc)">x</span>'), '<span style="color:red">x</span>');
  assert.equal(s('<span style="color:\\72 ed">x</span>'), '<span>x</span>', 'CSS escapes are refused');
  assert.equal(s('<span style="position:fixed;top:0">x</span>'), '<span>x</span>', 'layout hijack refused');
});

test('formatting allowlist is kept; other containers are unwrapped', () => {
  const ok = '<b>b</b><strong>s</strong><i>i</i><em>e</em><u>u</u><s>s</s><del>d</del><code>c</code><sub>1</sub><sup>2</sup><mark>m</mark><span>sp</span>a<br>b';
  assert.equal(s(ok), ok);
  assert.equal(s('<div><p>para</p></div>'), 'para');
  assert.equal(s('<font color="red">x</font>'), 'x');
});

test('plain text and entities are left as typed', () => {
  assert.equal(s('a < b and c > d'), 'a < b and c > d');
  assert.equal(s('Tom &amp; Jerry&nbsp;rock'), 'Tom &amp; Jerry&nbsp;rock');
  assert.equal(s('&lt;img src=x onerror=alert(1)&gt;'), '&lt;img src=x onerror=alert(1)&gt;', 'escaped text stays escaped (it is inert)');
  assert.equal(s(''), '');
  assert.equal(s(undefined), undefined);
  assert.equal(s(42), 42);
});

test('comments are dropped', () => {
  assert.equal(s('a<!-- <img src=x onerror=1> -->b'), 'ab');
});

test('idempotent: sanitizing the output again changes nothing', () => {
  const nasty = '<p onclick=x>Hi <b style="color:red;position:absolute">b</b><a href="javascript:1">l</a> &amp; <img src=x onerror=1></p>';
  const once = s(nasty);
  assert.equal(s(once), once);
  noExec(once);
});

test('sanitizeBlock sanitizes rich text only; plain-text structured fields are kept as typed', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const input = {
    id: '1', type: 'table', text: `t${evil}`, caption: `c${evil}`,
    tableData: { headers: [`h${evil}`], rows: [[`r${evil}`, 'ok']], caption: `tc${evil}` },
    faqItems: [{ question: `q${evil}`, answer: `a${evil}` }],
    toggleData: { summary: `s${evil}`, content: `x${evil}` },
    ctaData: { buttonText: `b${evil}`, url: 'https://x.com', style: 'primary' },
  };
  const { block, changed } = sanitizeBlock(input);
  assert.equal(changed, true);
  // `text` is the one field the editor renders through innerHTML.
  noExec(block.text);
  assert.equal(block.text, 't');
  // The rest are <input>/<textarea> values rendered as React text and escaped
  // by both exports: stored verbatim so prose about markup is never lost.
  assert.deepEqual(block.tableData, input.tableData);
  assert.deepEqual(block.faqItems, input.faqItems);
  assert.deepEqual(block.toggleData, input.toggleData);
  assert.deepEqual(block.ctaData, input.ctaData);
  assert.equal(block.caption, input.caption);
});

test('plain-text block types keep their text verbatim (cta, code)', () => {
  for (const type of ['cta', 'code']) {
    const text = 'Use <script>alert(1)</script> & <div> carefully';
    const { block, changed } = sanitizeBlock({ id: 'x', type, text });
    assert.equal(changed, false, type);
    assert.equal(block.text, text, type);
  }
});

test('sanitizeBlocks / sanitizeVersions report changed only when something changed', () => {
  const clean = [{ id: '1', type: 'p', text: 'hello <strong>world</strong>' }];
  assert.equal(sanitizeBlocks(clean).changed, false);
  assert.equal(sanitizeBlocks(clean).blocks[0].text, clean[0].text);
  const v = sanitizeVersions([{ id: 'v', timestamp: 1, blocks: [{ id: '1', type: 'p', text: '<b onclick=1>x</b>' }] }]);
  assert.equal(v.changed, true);
  assert.equal(v.versions[0].blocks[0].text, '<b>x</b>');
});

test('safeHref', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('https://x.com'), 'https://x.com');
  assert.equal(safeHref(''), null);
});

test('audit script: finds stored payloads in live blocks and structured fields (pure, no DB)', () => {
  const { blockHits } = require('../src/scripts/auditStoredXss');
  const hits = [...blockHits({
    id: 'b1', type: 'table', text: 'x<img src=x onerror=alert(1)>',
    tableData: { rows: [['ok', '<a href="javascript:1">y</a>']] },
    faqItems: [{ question: 'q', answer: '<script>1</script>' }],
  }, 'live')].map(([w]) => w);
  assert.deepEqual(hits, ['live block=b1(table) text', 'live block=b1(table) faq[0].answer', 'live block=b1(table) table[0][1]']);
  assert.deepEqual([...blockHits({ id: 'b2', type: 'p', text: 'clean <strong>text</strong>' }, 'live')], []);
});
