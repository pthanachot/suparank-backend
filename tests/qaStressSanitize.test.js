/**
 * QA Nov 2026 stress pass — sanitizeBlockHtml (N1) against an XSS corpus,
 * judged by RE-PARSING the output with parse5 (the HTML5 algorithm innerHTML
 * runs), plus non-regression for what the editor really stores (see the
 * frontend: SupaEditor applyLink / applyFontSize, cleanInlineHtml paste).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const parse5 = require('parse5');

const {
  sanitizeInlineHtml, sanitizeBlocks, sanitizeVersions,
} = require('../src/utils/sanitizeBlockHtml');

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'code', 'a', 'br', 'span', 'sub', 'sup', 'mark']);
const ALLOWED_ATTR = /^(href|target|rel|title|class|style|data-sr-[a-z0-9-]+)$/;

function audit(html) {
  const problems = [];
  const visit = (node) => {
    if (node.tagName) {
      if (!ALLOWED.has(node.tagName) || (node.namespaceURI && !node.namespaceURI.endsWith('xhtml'))) {
        problems.push(`tag <${node.tagName}>`);
      }
      for (const a of node.attrs || []) {
        if (!ALLOWED_ATTR.test(a.name)) problems.push(`attr ${a.name}`);
        if (a.name === 'href') {
          const c = a.value.toLowerCase().replace(/[\u0000- \u007f-\u009f]/g, '');
          const m = /^([a-z][a-z0-9+.-]*):/.exec(c);
          if (m && !['http', 'https', 'mailto', 'tel'].includes(m[1])) problems.push(`href ${a.value}`);
        }
        if (a.name === 'style' && /url\(|expression|javascript|\\|@import/i.test(a.value)) problems.push(`style ${a.value}`);
      }
    }
    if (node.nodeName === '#comment') problems.push('comment');
    for (const c of node.childNodes || []) visit(c);
    if (node.content) visit(node.content);
  };
  visit(parse5.parseFragment(html));
  return problems;
}

const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
  '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<math href="javascript:alert(1)">x</math>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href="\u0001javascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="javascript&#58alert(1)">x</a>',
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<a href="https://ok" onclick="alert(1)">x</a>',
  '<a href="https://ok"/onclick=alert(1)>x</a>',
  '<a href="https://ok" target="javascript:alert(1)">x</a>',
  '<a href="https://ok" rel="x" ping="https://evil">x</a>',
  '<b/onmouseover=alert(1)>x</b>',
  '<b onmouseover=alert(1)>x</b>',
  '<span style="background:url(javascript:alert(1))">x</span>',
  '<span style="background-image:url(https://evil/x.png)">x</span>',
  '<span style="width:expression(alert(1))">x</span>',
  '<span style="color:red;-moz-binding:url(x)">x</span>',
  '<span style="color:\\72 ed">x</span>',
  '<span style="color:red/**/;background:url(x)">x</span>',
  '<span style="color: rgb(1,2,3) ; background : u\\rl(x)">x</span>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<form><button formaction="javascript:alert(1)">x</button></form>',
  '<input autofocus onfocus=alert(1)>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel=stylesheet href="https://evil/x.css">',
  '<style>@import "https://evil";</style>',
  '<video><source onerror=alert(1)></video>',
  '<details open ontoggle=alert(1)>',
  '<marquee onstart=alert(1)>',
  '<body onload=alert(1)>',
  // mXSS / raw-text nesting
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<title><img src=x onerror=alert(1)></title>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<template><img src=x onerror=alert(1)></template>',
  '<select><template><style><img src=x onerror=alert(1)></style></template></select>',
  '<xmp><img src=x onerror=alert(1)></xmp>',
  '<noembed><img src=x onerror=alert(1)></noembed>',
  '<noframes><img src=x onerror=alert(1)></noframes>',
  '<plaintext><img src=x onerror=alert(1)>',
  '<listing><img src=x onerror=alert(1)></listing>',
  '<table><caption><svg><style><img src=x onerror=alert(1)>',
  '<div><svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<!--<img src=x onerror=alert(1)>-->',
  '<!--><img src=x onerror=alert(1)>-->',
  '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<?xml version="1.0"?><img src=x onerror=alert(1)>',
  // attribute breaking
  '<b title="a&quot; onmouseover=alert(1) x=&quot;">t</b>',
  '<b title=\'"><img src=x onerror=alert(1)>\'>t</b>',
  '<b title="`onmouseover=alert(1)">t</b>',
  '<b <img src=x onerror=alert(1)>>',
  '<a href="https://ok?<img src=x onerror=alert(1)>">x</a>',
  '<span class="x" onmouseover="alert(1)" class="y">x</span>',
  '<span data-sr-x="1" data-onload="alert(1)">x</span>',
];

test('XSS corpus: no output re-parses into a disallowed tag, attribute, scheme or style', () => {
  for (const input of XSS) {
    const out = sanitizeInlineHtml(input);
    assert.deepEqual(audit(out), [], `${JSON.stringify(input)} → ${JSON.stringify(out)}`);
  }
});

test('XSS corpus: sanitizing is idempotent (no mutation on a second pass)', () => {
  for (const input of XSS) {
    const once = sanitizeInlineHtml(input);
    assert.equal(sanitizeInlineHtml(once), once, JSON.stringify(input));
  }
});

test('XSS corpus: rich text is sanitized in blocks and versions; plain-text fields stay verbatim', () => {
  const payload = '<img src=x onerror=alert(1)><b>ok</b>';
  const input = [
    { id: 'p', type: 'p', text: payload },
    { id: 'i', type: 'img', src: 'https://x/y.png', caption: payload },
    { id: 'f', type: 'faq', faqItems: [{ question: payload, answer: payload }, null] },
    { id: 't', type: 'table', tableData: { headers: [payload], rows: [[payload, 'plain'], 'not-a-row'], caption: payload } },
    { id: 'g', type: 'toggle', toggleData: { summary: payload, content: payload } },
    { id: 'c', type: 'cta', text: payload, ctaData: { buttonText: payload, url: 'https://ok' } },
  ];
  const { blocks, changed } = sanitizeBlocks(input);
  assert.equal(changed, true);
  assert.equal(blocks[0].text, '<b>ok</b>');
  assert.deepEqual(audit(blocks[0].text), []);
  // Plain-text inputs in the editor, escaped by both exports.
  for (let i = 1; i < input.length; i++) assert.deepEqual(blocks[i], input[i], input[i].id);
  assert.equal(blocks[1].src, 'https://x/y.png', 'image src untouched');
  const v = sanitizeVersions([{ id: 'v', timestamp: 1, blocks: [{ id: 'p', type: 'p', text: payload }] }, { id: 'w', timestamp: 2 }]);
  assert.equal(v.versions[0].blocks[0].text, '<b>ok</b>');
  assert.deepEqual(v.versions[1], { id: 'w', timestamp: 2 });
});

// ─── non-regression: what the editor actually stores ─────────

const UNCHANGED = [
  'Plain prose with no markup at all.',
  'a < b and c > d & e',
  'Some <strong>bold</strong>, <em>italic</em>, <b>b</b>, <i>i</i>, <u>u</u>, <s>s</s>, <del>d</del>, <strike>k</strike>',
  'H<sub>2</sub>O and x<sup>2</sup><br>next line',
  'Inline <code>&lt;div class="x"&gt;</code> sample',
  'Tom &amp; Jerry &nbsp;spaced&nbsp;out &copy; 2026',
  // applyLink (toolbar)
  '<a href="https://example.com/a?b=1&amp;c=2" title="Example" target="_blank" rel="noopener" style="color:var(--sr-primary-700);text-decoration:underline;cursor:pointer">link</a>',
  // paste (cleanInlineHtml) link with the Docs underline inside
  '<a href="https://docs.example/x" title="t" style="color:#4338ca;text-decoration:underline;cursor:pointer" target="_blank" rel="noopener noreferrer"><u>link</u></a>',
  '<a href="mailto:a@b.co">mail</a> <a href="tel:+15551234">call</a> <a href="/relative/path">rel</a> <a href="#section">anchor</a>',
  // highlight + font size (editor's own controls)
  '<mark style="background-color:#fde68a">highlight</mark>',
  '<span style="background-color:rgb(253, 230, 138)">old highlight</span>',
  '<span style="font-size:18px">bigger</span>',
  '<span style="font-size: 24px">spaced decl</span>',
  // CTA-style link
  '<a href="https://x.com" style="display:inline-block;padding:8px 16px;border-radius:4px;background:#000;color:#fff">CTA</a>',
  '<span class="sr-x" data-sr-anchor="1">marker</span>',
];

test('legitimate editor markup is returned byte-identical', () => {
  for (const input of UNCHANGED) {
    assert.equal(sanitizeInlineHtml(input), input, input);
  }
});

test('non-string and empty fields pass through untouched', () => {
  for (const v of [undefined, null, '', 0, 42, true, ['x'], { a: 1 }]) {
    assert.deepEqual(sanitizeInlineHtml(v), v);
  }
  const blk = { id: 'c', type: 'code', text: '', codeData: { language: 'html', code: '<div class="x"><script>1</script></div>' } };
  const { blocks, changed } = sanitizeBlocks([blk]);
  assert.equal(changed, false);
  assert.equal(blocks[0].codeData.code, blk.codeData.code, 'raw code in codeData is never touched');
});

test('a clean document is not churned: sanitizeBlocks reports unchanged', () => {
  const blocks = UNCHANGED.map((text, i) => ({ id: `b${i}`, type: 'p', text }));
  const r = sanitizeBlocks(blocks);
  assert.equal(r.changed, false);
  assert.deepEqual(r.blocks, blocks);
});

test('Google Docs paste residue: formatting kept, unsafe/unknown parts dropped', () => {
  const docs = '<b id="docs-internal-guid-1" style="font-weight:normal;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:700;vertical-align:baseline;white-space:pre-wrap;">Bold</span></b>';
  const out = sanitizeInlineHtml(docs);
  assert.deepEqual(audit(out), []);
  assert.match(out, /Bold/);
  assert.match(out, /font-weight:700/);
  assert.match(out, /font-size:11pt/);
  assert.doesNotMatch(out, /docs-internal-guid|font-family/);
});

test('unwrapping a container keeps its text, and an unsafe link becomes plain text', () => {
  assert.equal(sanitizeInlineHtml('<div><b>bold</b> tail</div>'), '<b>bold</b> tail');
  assert.equal(sanitizeInlineHtml('<a href="javascript:alert(1)"><b>x</b></a>'), '<b>x</b>');
  assert.equal(sanitizeInlineHtml('<font color=red>f</font>'), 'f');
});

test('style: spacing alone is not a change, but any dropped segment still rewrites', () => {
  assert.equal(sanitizeInlineHtml('<span style="font-weight: normal; ">x</span>'), '<span style="font-weight: normal; ">x</span>');
  assert.equal(sanitizeInlineHtml('<span style="color:red; garbage">x</span>'), '<span style="color:red">x</span>');
  assert.equal(sanitizeInlineHtml('<span style="color:red;background:">x</span>'), '<span style="color:red">x</span>');
  assert.equal(sanitizeInlineHtml('<span style="color:red;font-family:Arial">x</span>'), '<span style="color:red">x</span>');
});

test('nbsp survives a re-serialization as &nbsp; (no space collapse)', () => {
  const out = sanitizeInlineHtml('x  y <i onclick=1>z</i>');
  assert.equal(out, 'x&nbsp;&nbsp;y <i>z</i>');
});
