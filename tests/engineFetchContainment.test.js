/**
 * Phase C2 — engine-client containment. The two bugs the audit found (dropped
 * X-Internal-Key, WRITING_ENGINE_URL/ENGINE_URL cross-wiring) both came from a
 * call site re-deriving the engine base URL by hand. This test locks the fix:
 * `process.env.ENGINE_URL` / `process.env.WRITING_ENGINE_URL` may only be read
 * inside the two client modules (and the boot validator). Any new direct read
 * elsewhere fails here, forcing the caller through engineFetch / the exported
 * WRITING_ENGINE_URL const instead.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../src');

// The ONLY files allowed to read the engine URL env vars directly.
const ALLOWED = new Set([
  path.join(SRC, 'services/analysisEngine.js'),   // owns ENGINE_URL
  path.join(SRC, 'services/writingEngine.js'),    // owns WRITING_ENGINE_URL
  path.join(SRC, 'config/validateEngineConfig.js'), // boot check reads NODE_ENV + both (via env param, but be lenient)
]);

// Catch every realistic way to read the vars off process.env: dot access,
// bracket access, and destructuring. (A destructure of ENGINE_URL from
// process.env is precisely what we forbid, so it can't false-positive.)
const PATTERNS = [
  /process\.env\.(ENGINE_URL|WRITING_ENGINE_URL)\b/,                       // process.env.ENGINE_URL
  /process\.env\s*\[\s*['"](ENGINE_URL|WRITING_ENGINE_URL)['"]\s*\]/,      // process.env['ENGINE_URL']
  /\{[^}]*\b(ENGINE_URL|WRITING_ENGINE_URL)\b[^}]*\}\s*=\s*process\.env/,  // const { ENGINE_URL } = process.env
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('engine-URL env reads are confined to the client modules', () => {
  it('no other backend/src file reads process.env.ENGINE_URL / WRITING_ENGINE_URL', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (PATTERNS.some((re) => re.test(text))) offenders.push(path.relative(SRC, file));
    }
    assert.deepEqual(
      offenders,
      [],
      `These files read the engine URL env vars directly — route them through `
      + `engineFetch (analysis) or the exported WRITING_ENGINE_URL (writing) instead:\n  ${offenders.join('\n  ')}`
    );
  });

  it('the allowlisted client files still exist (guards against a rename silently voiding this test)', () => {
    for (const f of ALLOWED) {
      assert.ok(fs.existsSync(f), `expected client module missing: ${f}`);
    }
  });
});
