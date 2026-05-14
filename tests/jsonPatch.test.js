const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyPatch, applyOp, parsePointer } = require('../src/services/jsonPatch');

describe('parsePointer', () => {
  it('parses empty pointer as root', () => {
    assert.deepEqual(parsePointer(''), []);
  });
  it('parses single segment', () => {
    assert.deepEqual(parsePointer('/angle'), ['angle']);
  });
  it('parses nested segments', () => {
    assert.deepEqual(parsePointer('/sections/0/heading'), ['sections', '0', 'heading']);
  });
  it('decodes ~1 to /', () => {
    assert.deepEqual(parsePointer('/a~1b'), ['a/b']);
  });
  it('decodes ~0 to ~', () => {
    assert.deepEqual(parsePointer('/a~0b'), ['a~b']);
  });
  it('rejects paths not starting with /', () => {
    assert.throws(() => parsePointer('angle'));
  });
});

describe('applyOp — objects', () => {
  it('replaces a scalar field', () => {
    const obj = { angle: 'old' };
    applyOp(obj, { op: 'replace', path: '/angle', value: 'new' });
    assert.equal(obj.angle, 'new');
  });
  it('adds a new field', () => {
    const obj = {};
    applyOp(obj, { op: 'add', path: '/angle', value: 'new' });
    assert.equal(obj.angle, 'new');
  });
  it('removes a field', () => {
    const obj = { angle: 'x' };
    applyOp(obj, { op: 'remove', path: '/angle' });
    assert.equal(obj.angle, undefined);
    assert.ok(!('angle' in obj));
  });
  it('traverses nested paths', () => {
    const obj = { sections: [{ heading: 'A' }] };
    applyOp(obj, { op: 'replace', path: '/sections/0/heading', value: 'B' });
    assert.equal(obj.sections[0].heading, 'B');
  });
});

describe('applyOp — arrays', () => {
  it('appends with "-"', () => {
    const obj = { sections: [{ heading: 'A' }] };
    applyOp(obj, { op: 'add', path: '/sections/-', value: { heading: 'B' } });
    assert.equal(obj.sections.length, 2);
    assert.equal(obj.sections[1].heading, 'B');
  });
  it('inserts at index', () => {
    const obj = { sections: [{ heading: 'A' }, { heading: 'C' }] };
    applyOp(obj, { op: 'add', path: '/sections/1', value: { heading: 'B' } });
    assert.deepEqual(obj.sections.map((s) => s.heading), ['A', 'B', 'C']);
  });
  it('replaces at index', () => {
    const obj = { sections: [{ heading: 'A' }, { heading: 'B' }] };
    applyOp(obj, { op: 'replace', path: '/sections/1', value: { heading: 'Z' } });
    assert.deepEqual(obj.sections.map((s) => s.heading), ['A', 'Z']);
  });
  it('removes at index', () => {
    const obj = { sections: [{ heading: 'A' }, { heading: 'B' }, { heading: 'C' }] };
    applyOp(obj, { op: 'remove', path: '/sections/1' });
    assert.deepEqual(obj.sections.map((s) => s.heading), ['A', 'C']);
  });
  it('rejects out-of-bounds replace', () => {
    const obj = { sections: [{ heading: 'A' }] };
    assert.throws(() => applyOp(obj, { op: 'replace', path: '/sections/5', value: {} }));
  });
  it('rejects replace targeting "-"', () => {
    const obj = { sections: [] };
    assert.throws(() => applyOp(obj, { op: 'replace', path: '/sections/-', value: {} }));
  });
});

describe('applyPatch — sequence', () => {
  it('applies multiple ops in order', () => {
    const obj = { angle: 'old', sections: [] };
    applyPatch(obj, [
      { op: 'replace', path: '/angle', value: 'new' },
      { op: 'add', path: '/sections/-', value: { heading: 'A' } },
      { op: 'add', path: '/sections/-', value: { heading: 'B' } },
      { op: 'replace', path: '/sections/0/heading', value: 'A1' },
    ]);
    assert.equal(obj.angle, 'new');
    assert.deepEqual(obj.sections.map((s) => s.heading), ['A1', 'B']);
  });

  it('rejects root replace', () => {
    assert.throws(() => applyOp({}, { op: 'replace', path: '', value: {} }));
  });

  it('rejects traversal through null', () => {
    assert.throws(() => applyOp({ a: null }, { op: 'replace', path: '/a/b', value: 'x' }));
  });
});

describe('prototype-pollution guard (Bug 6)', () => {
  it('rejects __proto__ as final segment', () => {
    assert.throws(
      () => applyOp({}, { op: 'add', path: '/__proto__', value: { polluted: true } }),
      /Forbidden segment/
    );
  });
  it('rejects __proto__ as intermediate segment', () => {
    assert.throws(
      () => applyOp({ a: {} }, { op: 'replace', path: '/__proto__/polluted', value: true }),
      /Forbidden segment/
    );
  });
  it('rejects constructor', () => {
    assert.throws(
      () => applyOp({}, { op: 'replace', path: '/constructor/prototype/polluted', value: true }),
      /Forbidden segment/
    );
  });
  it('rejects prototype', () => {
    assert.throws(
      () => applyOp({}, { op: 'add', path: '/prototype', value: {} }),
      /Forbidden segment/
    );
  });
  it('does not pollute Object.prototype on rejected ops', () => {
    try {
      applyPatch({}, [{ op: 'add', path: '/__proto__/polluted', value: 42 }]);
    } catch {
      // expected
    }
    assert.equal({}.polluted, undefined);
  });
});
