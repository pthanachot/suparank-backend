/**
 * QA B26: checklist items, backend half. A checklist item is an `li` block
 * with `checked: boolean`. The schema must keep the field (strict mode would
 * strip it), every serializer must carry the state, and the done lock must
 * treat a checkbox change as a content change.
 */
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');
const contentController = require('../src/controllers/contentController');
const imageStorage = require('../src/services/imageStorage');
const { blocksToMarkdown, taskMarker } = require('../src/services/blocksToMarkdown');
const { markdownToBlocks } = require('../src/services/markdownToBlocks');
const { renderBlocksHtml } = require('../src/services/exportService');
const { blockToMarkdownMinimal } = require('../src/services/contextFs/generators');
const { changesContent } = require('../src/services/doneLock');
const { sanitizeBlocks } = require('../src/utils/sanitizeBlockHtml');

const li = (id, text, checked, extra = {}) => ({ id, type: 'li', text, ...(checked === undefined ? {} : { checked }), ...extra });

describe('serializers', () => {
  test('taskMarker: only li blocks with a boolean checked', () => {
    assert.equal(taskMarker(li('a', 'x', false)), '[ ] ');
    assert.equal(taskMarker(li('a', 'x', true)), '[x] ');
    assert.equal(taskMarker(li('a', 'x')), '');
    assert.equal(taskMarker({ type: 'p', checked: true }), '');
    assert.equal(taskMarker(null), '');
  });

  test('blocksToMarkdown ↔ markdownToBlocks round-trips the state', () => {
    const md = blocksToMarkdown([li('a', 'One', false), li('b', 'Two', true), li('c', 'Plain')]);
    assert.equal(md, '- [ ] One\n\n- [x] Two\n\n- Plain');
    const back = markdownToBlocks(md);
    assert.deepEqual(back.map((b) => [b.type, b.text, b.checked]), [['li', 'One', false], ['li', 'Two', true], ['li', 'Plain', undefined]]);
  });

  test('markdownToBlocks: empty item, upper-case X, no-space stays text', () => {
    const back = markdownToBlocks('- [ ]\n\n- [X] Caps\n\n- [x]tight');
    assert.deepEqual(back.map((b) => [b.text, b.checked]), [['', false], ['Caps', true], ['[x]tight', undefined]]);
  });

  test('a plain bullet starting with "[ ]" is escaped and parsed back as a plain bullet', () => {
    const md = blocksToMarkdown([li('a', '[ ] Buy milk'), li('b', '[x] Done already')]);
    assert.equal(md, '- \\[ ] Buy milk\n\n- \\[x] Done already');
    const back = markdownToBlocks(md);
    assert.deepEqual(back.map((b) => [b.text, b.checked]), [['[ ] Buy milk', undefined], ['[x] Done already', undefined]]);
  });

  test('nested list items (two spaces per level) are list items, not paragraphs', () => {
    const back = markdownToBlocks('- [ ] a\n\n  - [x] b\n\n    - c\n\n1. one\n\n  1. nested');
    assert.deepEqual(back.map((b) => [b.type, b.text, b.checked, b.indent]), [
      ['li', 'a', false, undefined], ['li', 'b', true, 1], ['li', 'c', undefined, 2],
      ['ol', 'one', undefined, undefined], ['ol', 'nested', undefined, 1],
    ]);
  });

  test('CRLF parses like LF', () => {
    const back = markdownToBlocks('- [ ] One\r\n- [x] Two\r\n');
    assert.deepEqual(back.map((b) => [b.text, b.checked]), [['One', false], ['Two', true]]);
  });

  test('context-file markdown keeps the state', () => {
    assert.equal(blockToMarkdownMinimal(li('a', 'Do <b>it</b>', true)), '- [x] Do it');
    assert.equal(blockToMarkdownMinimal(li('a', 'Plain')), '- Plain');
  });

  test('export HTML: a checklist is its own task list, never merged with bullets', () => {
    const html = renderBlocksHtml([li('a', 'Bullet'), li('b', 'Todo', false), li('c', 'Done', true), li('d', 'Bullet 2')]);
    assert.match(html, /<ul class="contains-task-list">/);
    assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled> Todo<\/li>/);
    assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled checked> Done<\/li>/);
    assert.equal((html.match(/<ul/g) || []).length, 3);
  });

  test('the sanitizer keeps checked', () => {
    const r = sanitizeBlocks([li('a', 'x <script>bad()</script>', true)]);
    assert.equal(r.blocks[0].checked, true);
    assert.doesNotMatch(r.blocks[0].text, /script/);
  });

  test('done lock: ticking a box is a content change; an identical checklist is not', () => {
    const stored = { blocks: [li('a', 'Ship', false)] };
    assert.equal(changesContent(Content, stored, { blocks: [li('a', 'Ship', true)] }), true);
    assert.equal(changesContent(Content, stored, { blocks: [li('a', 'Ship')] }), true, 'checklist → bullet');
    assert.equal(changesContent(Content, stored, { blocks: [li('a', 'Ship', false)] }), false);
  });
});

describe('persistence (real MongoDB)', () => {
  const saved = [];
  before(async () => {
    await connect();
    await Content.init();
    saved.push([imageStorage, 'isEnabled', imageStorage.isEnabled]);
    imageStorage.isEnabled = () => false;
  });
  after(async () => {
    for (const [o, k, v] of saved) o[k] = v;
    await disconnect();
  });
  beforeEach(async () => { await clear(); });

  const WS = new mongoose.Types.ObjectId();
  const USER = new mongoose.Types.ObjectId();

  test('a saved checklist comes back with its state (schema keeps `checked`)', async () => {
    await Content.create({ userId: USER, workspaceId: WS, contentNumber: 7001, blocks: [li('a', 'Todo', false), li('b', 'Done', true), li('c', 'Plain')] });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await contentController.updateContent({
      workspace: { _id: WS, organizationId: null }, params: { contentNumber: '7001' },
      body: { blocks: [li('a', 'Todo', true), li('b', 'Done', true), li('c', 'Plain')] }, user: { userId: String(USER) },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.content.blocks.map((b) => b.checked), [true, true, undefined]);
    const stored = await Content.findOne({ contentNumber: 7001 }).lean();
    assert.deepEqual(stored.blocks.map((b) => b.checked), [true, true, undefined]);
  });

  test('a done article refuses a checkbox tick (409 ARTICLE_DONE)', async () => {
    await Content.create({ userId: USER, workspaceId: WS, contentNumber: 7002, status: 'done', blocks: [li('a', 'Ship', false)] });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await contentController.updateContent({
      workspace: { _id: WS, organizationId: null }, params: { contentNumber: '7002' },
      body: { blocks: [li('a', 'Ship', true)] }, user: { userId: String(USER) },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'ARTICLE_DONE');
  });
});
