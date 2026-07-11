/**
 * Phase 18B — zero-dependency tar.gz encoder (src/utils/tar.js).
 *
 * Verifies the ustar output by parsing it back in-process: header field
 * decoding, the 6-octal-digit checksum, size/padding math, gzip round-trip, and
 * nested paths + UTF-8. (Also validated manually against the system `tar`.)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { createTar, createTarGz } = require('../src/utils/tar');

// Minimal ustar parser: returns [{ name, size, data, checksumOk }].
function parseTar(buf) {
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break; // zero block → end of archive
    const size = parseInt(buf.toString('ascii', off + 124, off + 136).replace(/[\0 ]+$/, ''), 8);
    const stored = parseInt(buf.toString('ascii', off + 148, off + 156).replace(/[\0 ].*$/, ''), 8);
    // ustar prefix field → full path is `prefix + '/' + name`
    const prefix = buf.toString('utf8', off + 345, off + 500).replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;

    const hdr = Buffer.from(buf.subarray(off, off + 512));
    hdr.write('        ', 148, 8, 'ascii'); // blank the checksum field
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += hdr[i];

    const data = buf.toString('utf8', off + 512, off + 512 + size);
    files.push({ name: fullName, size, data, checksumOk: sum === stored, magic: buf.toString('ascii', off + 257, off + 262) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('tar encoder', () => {
  it('round-trips names, data, sizes, and valid checksums', () => {
    const entries = [
      { name: 'manifest.json', data: JSON.stringify({ n: 42 }) },
      { name: 'content/1-post.md', data: '# Title\n\nBody — with unicode ✓ €.\n' },
      { name: 'a/b/c/deep.txt', data: 'x'.repeat(1000) }, // spans >1 block
    ];
    const files = parseTar(createTar(entries, 1751000000));

    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => f.name), ['manifest.json', 'content/1-post.md', 'a/b/c/deep.txt']);
    assert.ok(files.every((f) => f.checksumOk), 'every header checksum validates');
    assert.ok(files.every((f) => f.magic === 'ustar'), 'ustar magic present');
    assert.equal(files[0].data, JSON.stringify({ n: 42 }));
    assert.equal(files[1].data, '# Title\n\nBody — with unicode ✓ €.\n');
    assert.equal(files[2].size, 1000);
    assert.equal(files[2].data.length, 1000);
  });

  it('ends with two zero blocks (1024 trailing zero bytes)', () => {
    const tar = createTar([{ name: 'x', data: 'y' }]);
    const tail = tar.subarray(tar.length - 1024);
    assert.ok(tail.every((b) => b === 0), 'archive terminates with two zero blocks');
  });

  it('empty-file entry encodes with zero size', () => {
    const files = parseTar(createTar([{ name: 'empty', data: '' }]));
    assert.equal(files[0].size, 0);
    assert.equal(files[0].data, '');
    assert.ok(files[0].checksumOk);
  });

  it('createTarGz gunzips back to a valid tar', () => {
    const gz = createTarGz([{ name: 'r.json', data: '{"ok":true}' }]);
    // gzip magic bytes
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    const files = parseTar(zlib.gunzipSync(gz));
    assert.equal(files[0].name, 'r.json');
    assert.deepEqual(JSON.parse(files[0].data), { ok: true });
  });

  it('uses the ustar prefix field for a path >100 bytes and round-trips the full path', () => {
    const longName = `workspaces/${'a'.repeat(50)}/content/${'b'.repeat(50)}/deep.json`;
    assert.ok(Buffer.byteLength(longName) > 100, 'test path exceeds a single 100-byte field');
    const files = parseTar(createTar([{ name: longName, data: '{}' }]));
    assert.equal(files[0].name, longName, 'full path reconstructed from prefix + name');
    assert.ok(files[0].checksumOk);
  });

  it('rejects a single path component longer than 100 bytes (unsplittable)', () => {
    assert.throws(() => createTar([{ name: 'a'.repeat(101), data: 'x' }]), /path too long/);
  });
});
