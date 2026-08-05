'use strict';

// Phase 4: inline `![alt](src)` must never be rewritten into a hyperlink.
//
// mdInlineToHtml's link rule matched the `[alt](src)` half of an image, so
// `see ![chart](url) here` became `see !<a href="url">chart</a> here`. Two
// losses at once: the image was gone, and because it was no longer an `img`
// block the save path never copied it to B2 — the engine's temporary URL then
// expired into a dead link. The user had paid for that image.
//
// Two behaviours, deliberately different:
//   paragraph  → the image is PROMOTED to its own img block (a paragraph can be
//                split around it, and only an img block gets re-hosted).
//   container  → list item, heading, blockquote: the markdown is left LITERAL.
//                Promoting would destroy the container; literal text keeps the
//                src, round-trips byte-for-byte, and shows the author something
//                is wrong instead of publishing a silently wrong link.
//
// The backend parser is the one the ENGINE's output flows through, so this is
// the copy that decides whether a generated image survives at all. The frontend
// mirror is covered in suparank/components/editor/imageBlocks.test.ts.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { markdownToBlocks } = require('../src/services/markdownToBlocks');
const { blocksToMarkdown } = require('../src/services/blocksToMarkdown');

const SRC = 'http://localhost:8090/api/images/img_a.png';
const textOf = (blocks) => blocks.map((b) => b.text || '').join(' ');

test('an inline image in a paragraph is promoted to its own img block', () => {
  const blocks = markdownToBlocks(`Here is the chart ![sales chart](${SRC}) shown inline.`);
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'img', 'p']);
  const img = blocks[1];
  assert.equal(img.src, SRC);
  assert.equal(img.alt, 'sales chart');
  assert.ok(!textOf(blocks).includes('!<a'), 'must not be rewritten as a link');
});

test('promotion is what makes the image re-hostable', () => {
  // The save path only re-hosts blocks of type 'img'. If the image stays inside
  // a paragraph's HTML it is never copied to durable storage, which is the
  // second half of the original bug.
  const blocks = markdownToBlocks(`text ![a](${SRC}) more`);
  assert.ok(blocks.some((b) => b.type === 'img' && b.src === SRC),
    'no img block means the save path will never re-host this image');
});

test('several inline images in one paragraph all survive', () => {
  const blocks = markdownToBlocks(`One ![a](${SRC}) two ![b](${SRC}) three`);
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'img', 'p', 'img', 'p']);
  assert.deepEqual(blocks.filter((b) => b.type === 'img').map((b) => b.alt), ['a', 'b']);
});

test('no empty paragraphs when the image leads or trails', () => {
  assert.deepEqual(markdownToBlocks(`![a](${SRC}) trailing`).map((b) => b.type), ['img', 'p']);
  assert.deepEqual(markdownToBlocks(`leading ![a](${SRC})`).map((b) => b.type), ['p', 'img']);
});

test('a markdown title becomes the caption', () => {
  const [, img] = markdownToBlocks(`text ![a](${SRC} "A caption") more`);
  assert.equal(img.caption, 'A caption');
});

// ─── Containers: literal, never a link ───────────────────────

const CONTAINERS = [
  ['list item', `- item with ![chart](${SRC}) inside`],
  ['ordered list item', `1. step with ![chart](${SRC}) inside`],
  ['heading', `## Heading with ![chart](${SRC})`],
  ['blockquote', `> quote with ![chart](${SRC})`],
];

for (const [label, md] of CONTAINERS) {
  test(`${label}: image is left literal and the src survives`, () => {
    const blocks = markdownToBlocks(md);
    assert.ok(!textOf(blocks).includes('!<a'), 'must not become a stray "!" plus a link');
    assert.ok(JSON.stringify(blocks).includes('img_a.png'), 'the src must not be lost');
  });

  test(`${label}: round-trips back to the same markdown`, () => {
    // Literal text is only an acceptable answer because nothing is lost on the
    // way out — htmlInlineToMd has no tag to strip, so the image survives a
    // save/load cycle and heals if it later lands on its own line.
    const out = blocksToMarkdown(markdownToBlocks(md));
    assert.ok(out.includes(`![chart](${SRC})`), `round trip lost the image: ${out}`);
  });
}

test('ordinary links are still converted everywhere', () => {
  assert.ok(markdownToBlocks('see [docs](https://example.com) here')[0].text
    .includes('<a href="https://example.com"'));
  assert.ok(markdownToBlocks('- see [docs](https://example.com) here')[0].text
    .includes('<a href="https://example.com"'));
  assert.ok(markdownToBlocks('## see [docs](https://example.com)')[0].text
    .includes('<a href="https://example.com"'));
});

test('a whole-line image is unaffected (handled by the line-level branch)', () => {
  const blocks = markdownToBlocks(`![solo](${SRC})`);
  assert.deepEqual(blocks.map((b) => b.type), ['img']);
  assert.equal(blocks[0].src, SRC);
});

test('images inside a fenced code block are not touched', () => {
  const md = ['```markdown', `![not an image](${SRC})`, '```'].join('\n');
  const blocks = markdownToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['code']);
  assert.ok(blocks[0].codeData.code.includes('!['), 'code fences must keep their literal text');
});
