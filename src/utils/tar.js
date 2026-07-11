/**
 * Minimal, zero-dependency tar.gz encoder (POSIX ustar).
 *
 * We deliberately avoid adding an archive dependency (archiver/jszip/…) for the
 * Phase 18 data-export feature. tar.gz is universally extractable (macOS/Linux
 * `tar -xzf`, Windows 10+, 7-Zip) and the ustar format is simple enough to emit
 * correctly here — verified in tests by extracting with the system `tar`.
 *
 * Regular files only (no dirs — a `/` in a name creates parent dirs on extract).
 * Long paths use the ustar `prefix` field (name[100] + prefix[155] → up to ~255
 * bytes, split at a `/`); a single path component >100 bytes still throws. Whole
 * archive is built in memory; fine for occasional exports, not unbounded data.
 */

const zlib = require('zlib');

const BLOCK = 512;

/** Write an octal numeric field: (len-1) zero-padded digits + a trailing NUL. */
function writeOctal(buf, value, offset, len) {
  const s = value.toString(8);
  // Guard the octal fields (size is 12 → 11 digits → 8 GiB max). Overflowing
  // would silently truncate into a corrupt archive; fail loudly instead.
  if (s.length > len - 1) {
    throw new Error(`tar: numeric field overflow (${value} needs ${s.length} octal digits, field holds ${len - 1})`);
  }
  buf.write(s.padStart(len - 1, '0') + '\0', offset, len, 'ascii');
}

/**
 * Split a path into ustar (prefix, name) so name ≤100 and prefix ≤155 bytes, on a
 * `/` boundary — extractors rejoin as `prefix + '/' + name`. Picks the largest
 * name ≤100 (smallest prefix). Throws only if the path can't fit in 255 bytes /
 * a single component exceeds 100.
 */
function splitName(fullName) {
  if (Buffer.byteLength(fullName, 'utf8') <= 100) return { name: fullName, prefix: '' };
  const parts = fullName.split('/');
  for (let i = 1; i < parts.length; i++) {
    const name = parts.slice(i).join('/');
    const prefix = parts.slice(0, i).join('/');
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`tar: path too long for ustar (>255 bytes or a single component >100): ${fullName}`);
}

/** Build a single 512-byte ustar header block for a regular file. */
function buildHeader(fullName, size, mtime) {
  const { name, prefix } = splitName(fullName);

  const buf = Buffer.alloc(BLOCK, 0);
  Buffer.from(name, 'utf8').copy(buf, 0);   // name        [0,100)
  writeOctal(buf, 0o644, 100, 8);       // mode        [100,108)
  writeOctal(buf, 0, 108, 8);           // uid         [108,116)
  writeOctal(buf, 0, 116, 8);           // gid         [116,124)
  writeOctal(buf, size, 124, 12);       // size        [124,136)
  writeOctal(buf, mtime, 136, 12);      // mtime       [136,148)
  buf.write('        ', 148, 8, 'ascii'); // chksum placeholder = 8 spaces
  buf.write('0', 156, 1, 'ascii');      // typeflag '0' = regular file
  buf.write('ustar\0', 257, 6, 'ascii'); // magic
  buf.write('00', 263, 2, 'ascii');     // version
  if (prefix) Buffer.from(prefix, 'utf8').copy(buf, 345); // prefix [345,500)

  // Checksum = unsigned sum of all header bytes (with chksum field as spaces),
  // written as 6 octal digits + NUL + space.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  return buf;
}

/**
 * Encode entries into an uncompressed tar Buffer.
 * @param {Array<{name: string, data: string|Buffer}>} entries
 * @param {number} [mtime] unix seconds stamped on every entry (default: now)
 */
function createTar(entries, mtime = Math.floor(Date.now() / 1000)) {
  const chunks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    chunks.push(buildHeader(e.name, data.length, mtime));
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // two zero blocks = end of archive
  return Buffer.concat(chunks);
}

/** Encode entries into a gzipped tar (.tar.gz) Buffer. */
function createTarGz(entries, mtime) {
  return zlib.gzipSync(createTar(entries, mtime));
}

module.exports = { createTar, createTarGz };
