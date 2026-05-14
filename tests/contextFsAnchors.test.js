const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const anchors = require('../src/services/contextFs/anchors');

describe('anchors.render', () => {
  it('returns empty for empty input', () => {
    const r = anchors.render([]);
    assert.equal(r.body, '');
    assert.deepEqual(r.anchors, []);
  });

  it('renders single segment as H2 + body', () => {
    const r = anchors.render([{ id: 'a', label: 'Alpha', body: 'first line' }]);
    assert.equal(r.body, '## Alpha\n\nfirst line');
    assert.equal(r.anchors.length, 1);
    assert.equal(r.anchors[0].id, 'a');
    assert.equal(r.anchors[0].label, 'Alpha');
    // Lines: "## Alpha", "", "first line" → 3
    assert.equal(r.anchors[0].line_count, 3);
  });

  it('joins multiple segments with a blank-line separator', () => {
    const r = anchors.render([
      { id: 'a', label: 'A', body: 'one' },
      { id: 'b', label: 'B', body: 'two' },
    ]);
    // Body: "## A\n\none\n\n## B\n\ntwo" → 7 lines
    // First segment owns: "## A", "", "one"  (3 lines)
    // Second segment owns: "", "## B", "", "two"  (4 lines — the separator's
    //   first '\n' just terminates the first segment's last line)
    assert.equal(r.body, '## A\n\none\n\n## B\n\ntwo');
    assert.equal(r.anchors[0].line_count, 3);
    assert.equal(r.anchors[1].line_count, 4);
  });

  it('line counts sum to body line count', () => {
    const r = anchors.render([
      { id: 'a', label: 'A', body: 'one\nline-two' },
      { id: 'b', label: 'B', body: 'three' },
    ]);
    const totalLines = r.body.split('\n').length;
    const sum = r.anchors.reduce((acc, a) => acc + a.line_count, 0);
    assert.equal(sum, totalLines, `body has ${totalLines} lines, anchors sum to ${sum}`);
  });
});

describe('anchors.slice (anchor read)', () => {
  const segments = [
    { id: 'a', label: 'Alpha', body: 'alpha-body' },
    { id: 'b', label: 'Bravo', body: 'bravo-body' },
    { id: 'c', label: 'Charlie', body: 'charlie-body' },
  ];
  const { body, anchors: meta } = anchors.render(segments);

  it('returns the slice for a named anchor', () => {
    const slice = anchors.slice(body, meta, 'b');
    assert.ok(slice.includes('## Bravo'));
    assert.ok(slice.includes('bravo-body'));
    assert.ok(!slice.includes('Alpha'));
    assert.ok(!slice.includes('Charlie'));
  });

  it('returns first anchor exactly', () => {
    const slice = anchors.slice(body, meta, 'a');
    assert.ok(slice.startsWith('## Alpha'));
    assert.ok(slice.includes('alpha-body'));
    assert.ok(!slice.includes('Bravo'));
  });

  it('returns null for unknown anchor', () => {
    assert.equal(anchors.slice(body, meta, 'z'), null);
  });

  it('returns null when anchors is not an array', () => {
    assert.equal(anchors.slice(body, null, 'a'), null);
  });
});

describe('anchors.sliceByLines (offset/limit)', () => {
  const body = 'line0\nline1\nline2\nline3\nline4';

  it('returns first N lines with limit', () => {
    const r = anchors.sliceByLines(body, 0, 3);
    assert.equal(r.slice, 'line0\nline1\nline2');
    assert.equal(r.truncated, true);
  });

  it('returns from offset onward', () => {
    const r = anchors.sliceByLines(body, 2, 100);
    assert.equal(r.slice, 'line2\nline3\nline4');
    assert.equal(r.truncated, false);
  });

  it('returns empty when offset beyond end', () => {
    const r = anchors.sliceByLines(body, 100, 10);
    assert.equal(r.slice, '');
    assert.equal(r.truncated, false);
  });

  it('clamps negative offset to 0', () => {
    const r = anchors.sliceByLines(body, -5, 2);
    assert.equal(r.slice, 'line0\nline1');
  });
});
