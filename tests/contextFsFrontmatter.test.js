const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { emitFrontmatter, emitFile, formatScalar, needsQuoting } = require('../src/services/contextFs/frontmatter');

describe('needsQuoting', () => {
  it('quotes empty strings', () => assert.equal(needsQuoting(''), true));
  it('quotes strings with leading/trailing whitespace', () => assert.equal(needsQuoting(' x '), true));
  it('quotes strings starting with YAML special chars', () => {
    for (const c of ['-', '?', ':', '|', '>', '!', '&', '*', '%', '@', '`', '#']) {
      assert.equal(needsQuoting(c + 'x'), true, `should quote: ${c}x`);
    }
  });
  it('quotes strings with special chars inside', () => {
    assert.equal(needsQuoting('contains: colon'), true);
    assert.equal(needsQuoting('has\nnewline'), true);
    assert.equal(needsQuoting('has "quotes"'), true);
  });
  it('quotes booleanish strings', () => {
    assert.equal(needsQuoting('true'), true);
    assert.equal(needsQuoting('NO'), true);
  });
  it('quotes numericish strings', () => {
    assert.equal(needsQuoting('42'), true);
    assert.equal(needsQuoting('-3.14'), true);
  });
  it('leaves normal identifiers alone', () => {
    assert.equal(needsQuoting('keyword-saas-onboarding'), false);
    assert.equal(needsQuoting('Hello world'), false);
  });
});

describe('formatScalar', () => {
  it('serializes null/undefined as null', () => {
    assert.equal(formatScalar(null), 'null');
    assert.equal(formatScalar(undefined), 'null');
  });
  it('serializes booleans', () => {
    assert.equal(formatScalar(true), 'true');
    assert.equal(formatScalar(false), 'false');
  });
  it('serializes finite numbers', () => assert.equal(formatScalar(42), '42'));
  it('quotes strings that need quoting', () => {
    assert.equal(formatScalar('has: colon'), '"has: colon"');
  });
});

describe('emitFrontmatter', () => {
  it('emits empty frontmatter', () => {
    assert.equal(emitFrontmatter({}), '---\n---');
    assert.equal(emitFrontmatter(null), '---\n---');
  });
  it('emits scalar fields', () => {
    const out = emitFrontmatter({ id: 'x', priority: 1, anchors_version: 2 });
    assert.equal(out, '---\nid: x\npriority: 1\nanchors_version: 2\n---');
  });
  it('emits arrays of scalars', () => {
    const out = emitFrontmatter({ tags: ['a', 'b'] });
    assert.ok(out.includes('tags:\n  - a\n  - b'));
  });
  it('emits arrays of flat objects (anchors shape)', () => {
    const out = emitFrontmatter({
      anchors: [
        { id: 'h', label: 'Headings', line_count: 12 },
        { id: 'k', label: 'Key claims', line_count: 8 },
      ],
    });
    assert.ok(out.includes('anchors:'));
    assert.ok(out.includes('- id: h'));
    assert.ok(out.includes('  label: Headings'));
    assert.ok(out.includes('  line_count: 12'));
    assert.ok(out.includes('- id: k'));
  });
});

describe('emitFile', () => {
  it('joins frontmatter + body with a single newline', () => {
    const out = emitFile({ id: 'x' }, 'hello world');
    assert.equal(out, '---\nid: x\n---\nhello world');
  });
  it('handles empty body', () => {
    const out = emitFile({ id: 'x' }, '');
    assert.equal(out, '---\nid: x\n---\n');
  });
});
