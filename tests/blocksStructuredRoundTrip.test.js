/**
 * P0 (writing-moment UX plan): toggle/embed data-loss fix.
 *
 * Before this fix:
 *  - blocksToMarkdown dropped toggle/embed entirely (empty text via default
 *    case), so any agent run destroyed those blocks;
 *  - the Mongo blockSchema silently stripped toggleData/embedData/caption/
 *    indent on every save (Mongoose strict mode).
 *
 * These tests lock the serialized forms (shared verbatim with the frontend
 * blocksToMarkdown in suparank/components/editor/utils.ts — must stay in
 * sync) and the schema round-trip.
 */
const test = require('node:test');
const assert = require('node:assert');

const { blocksToMarkdown } = require('../src/services/blocksToMarkdown');
const Content = require('../src/models/Content');

test('toggle block serializes as a <details> HTML block', () => {
  const md = blocksToMarkdown([
    {
      id: 'b1',
      type: 'toggle',
      text: '',
      toggleData: { summary: 'More info', content: 'Hidden <strong>details</strong> here' },
    },
  ]);
  assert.strictEqual(
    md,
    '<details>\n<summary>More info</summary>\n\nHidden <strong>details</strong> here\n\n</details>'
  );
});

test('embed block serializes as an iframe with data attributes', () => {
  const md = blocksToMarkdown([
    {
      id: 'b1',
      type: 'embed',
      text: '',
      embedData: {
        url: 'https://www.youtube.com/watch?v=abc123',
        embedType: 'youtube',
        embedUrl: 'https://www.youtube.com/embed/abc123',
      },
    },
  ]);
  assert.strictEqual(
    md,
    '<iframe src="https://www.youtube.com/embed/abc123" data-embed-type="youtube" data-url="https://www.youtube.com/watch?v=abc123"></iframe>'
  );
});

test('embed without embedUrl uses url as src; quotes are attribute-escaped', () => {
  const md = blocksToMarkdown([
    {
      id: 'b1',
      type: 'embed',
      text: '',
      embedData: { url: 'https://example.com/x?q="hi"', embedType: 'generic' },
    },
  ]);
  assert.ok(md.includes('src="https://example.com/x?q=&quot;hi&quot;"'));
  assert.ok(md.includes('data-embed-type="generic"'));
});

test('embed with no url emits nothing', () => {
  const md = blocksToMarkdown([{ id: 'b1', type: 'embed', text: '', embedData: {} }]);
  assert.strictEqual(md, '');
});

test('li/ol indent and img caption serialize (frontend parity)', () => {
  const md = blocksToMarkdown([
    { id: 'b1', type: 'li', text: 'top' },
    { id: 'b2', type: 'li', text: 'nested', indent: 1 },
    { id: 'b3', type: 'ol', text: 'deep', indent: 2 },
    { id: 'b4', type: 'img', text: '', src: 'https://x.com/a.png', alt: 'A', caption: 'A caption' },
  ]);
  const lines = md.split('\n').filter(Boolean);
  assert.strictEqual(lines[0], '- top');
  assert.strictEqual(lines[1], '  - nested');
  assert.strictEqual(lines[2], '    1. deep');
  assert.strictEqual(lines[3], '![A](https://x.com/a.png)');
  assert.strictEqual(lines[4], '*A caption*');
});

test('Content blockSchema preserves toggleData/embedData/caption/indent', () => {
  const doc = new Content({
    title: 't',
    blocks: [
      {
        id: 'b1',
        type: 'toggle',
        text: '',
        toggleData: { summary: 'S', content: 'C' },
      },
      {
        id: 'b2',
        type: 'embed',
        text: '',
        embedData: { url: 'https://youtu.be/x', embedType: 'youtube', embedUrl: 'https://www.youtube.com/embed/x' },
      },
      { id: 'b3', type: 'img', text: '', src: 's', caption: 'cap' },
      { id: 'b4', type: 'li', text: 'nested', indent: 2 },
    ],
  });
  const obj = doc.toObject();
  assert.deepStrictEqual(obj.blocks[0].toggleData, { summary: 'S', content: 'C' });
  assert.deepStrictEqual(obj.blocks[1].embedData, {
    url: 'https://youtu.be/x',
    embedType: 'youtube',
    embedUrl: 'https://www.youtube.com/embed/x',
  });
  assert.strictEqual(obj.blocks[2].caption, 'cap');
  assert.strictEqual(obj.blocks[3].indent, 2);
});

/**
 * Same failure mode as the toggle/embed case above, one feature later: the
 * editor measures an image and stores its intrinsic size (for the export's
 * width/height attributes and the low-resolution warning) plus a transient
 * autoSize flag for imported images awaiting their first load. Strict mode
 * would drop all three on save, so the export would silently lose its
 * reserved-box attributes and imported images would never get sized.
 */
test('Content blockSchema preserves intrinsic image dimensions and autoSize', () => {
  const doc = new Content({
    title: 't',
    blocks: [
      { id: 'b1', type: 'img', text: '', src: 's', width: 41, align: 'center', intrinsicWidth: 1080, intrinsicHeight: 1920 },
      { id: 'b2', type: 'img', text: '', src: 's2', autoSize: true },
    ],
  });
  const obj = doc.toObject();
  assert.strictEqual(obj.blocks[0].intrinsicWidth, 1080);
  assert.strictEqual(obj.blocks[0].intrinsicHeight, 1920);
  assert.strictEqual(obj.blocks[0].width, 41);
  assert.strictEqual(obj.blocks[0].align, 'center');
  assert.strictEqual(obj.blocks[1].autoSize, true);
});

test('Content blockSchema rejects an invalid embedType via cast error on validate', () => {
  const doc = new Content({
    title: 't',
    blocks: [{ id: 'b1', type: 'embed', text: '', embedData: { url: 'u', embedType: 'vimeo' } }],
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error for embedType outside the enum');
});
