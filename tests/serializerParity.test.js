'use strict';

/**
 * Express half of the serializer-parity suite (Phase 10,
 * CHANGE-PERCEPTION-AND-CRUD-PLAN).
 *
 * blocksToMarkdown.js and the frontend's blocksToMarkdown (engine audience,
 * suparank components/editor/utils.ts) are hand-mirrored serializers of one
 * wire format — this one feeds the engine's session document, the frontend's
 * feeds every apply round-trip. Drift is nasty in the sr:* anchor era: a
 * frontend that emits `<!-- sr:cta … -->` while the backend emits a plain
 * link (or vice versa) silently destroys cta/toc blocks on the very next
 * engine run.
 *
 * The fixture is duplicated at
 * suparank/components/editor/__fixtures__/serializer-parity.json because the
 * two live in separate git repos and neither can read the other's tree in CI
 * — edit BOTH copies or the parity silently stops being checked (the
 * planCompleteness parity-cases precedent).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { blocksToMarkdown } = require('../src/services/blocksToMarkdown');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/serializerParity/serializer-parity.json'), 'utf8'),
);

test('fixture is non-trivial (a truncated copy must not pass by asserting nothing)', () => {
  assert.ok(Array.isArray(fixture.blocks) && fixture.blocks.length >= 6);
  assert.ok(fixture.blocks.some((b) => b.type === 'cta'));
  assert.ok(fixture.blocks.some((b) => b.type === 'toc'));
  assert.ok(fixture.blocks.some((b) => b.type === 'faq'), 'Phase 11: faq must be pinned');
  assert.ok(fixture.engineMarkdown.includes('<!-- sr:'));
});

test('backend serializer output is byte-identical to the pinned engine markdown', () => {
  assert.strictEqual(blocksToMarkdown(fixture.blocks), fixture.engineMarkdown);
});

test('the backend PARSER treats anchor lines as zero-word non-blocks (review fix)', () => {
  // markdownToBlocks' one production consumer is conformance.js, which counts
  // words per section for execute-mode drift checks. An anchor parsed as a
  // paragraph would add its JSON tokens to the count and skew drift.
  const { markdownToBlocks } = require('../src/services/markdownToBlocks');
  const parsed = markdownToBlocks(fixture.engineMarkdown);
  assert.ok(!parsed.some((b) => (b.text || '').includes('sr:')), 'anchor leaked into parsed text');
  const types = parsed.map((b) => b.type);
  // Only the three anchor LINES are zero-word skips. The faq section's prose
  // still counts — and this parser has its own h2+h3+answer faq collapse
  // (one-paragraph answers, its established shape), so the trailing list item
  // sits outside the collapsed block.
  assert.deepStrictEqual(types, ['h1', 'p', 'p', 'faq', 'li', 'img', 'table'], 'expected only the real prose blocks');
});

test('the backend parser TERMINATES on image lines (pre-existing infinite loop, fixed in P12)', () => {
  // The paragraph collector excludes `![` lines and nothing consumed them —
  // any image-bearing document hung markdownToBlocks (and conformance.js on a
  // request thread) forever. This test existing AND finishing is the assertion;
  // the mangled form must also consume, visibly.
  const { markdownToBlocks } = require('../src/services/markdownToBlocks');
  const ok = markdownToBlocks('before\n\n![alt](/x.png "cap")\n\nafter');
  assert.deepStrictEqual(ok.map((b) => b.type), ['p', 'img', 'p']);
  const mangled = markdownToBlocks('![broken image line\n\nafter');
  assert.deepStrictEqual(mangled.map((b) => b.type), ['p', 'p']);
  assert.ok(mangled[0].text.includes('broken image line'));
});

test("the '>' escape holds — no payload can close the anchor comment early", () => {
  const md = blocksToMarkdown(fixture.blocks);
  const anchorLine = md.split('\n').find((l) => l.startsWith('<!-- sr:cta'));
  assert.ok(anchorLine, 'cta anchor line missing');
  // The only '>' on the line is the comment terminator itself.
  assert.strictEqual(anchorLine.indexOf('>'), anchorLine.length - 1);
  // And the payload still parses back to the original data.
  const json = anchorLine.replace(/^<!-- sr:cta\s+/, '').replace(/\s*-->$/, '');
  assert.deepStrictEqual(JSON.parse(json), fixture.blocks.find((b) => b.type === 'cta').ctaData);
});
