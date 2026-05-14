/**
 * Internal API auth — for endpoints the Go writing-engine calls back into
 * Express (CFS reads, plan writes, conformance checks). NOT user-facing.
 *
 * Auth is a single secret in the `x-internal-key` header, configured via
 * env. Dual-key (current + previous) supports zero-downtime rotation:
 * during a rotation window, both keys are accepted; once Go is restarted
 * with the new key, the old key can be removed.
 *
 * Constant-time compare prevents timing-side-channel attacks on the secret.
 *
 * If INTERNAL_API_KEY is not set, the middleware refuses ALL requests
 * (fail-closed). Production deployments must set the env explicitly.
 */

const crypto = require('crypto');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Lengths must match for timingSafeEqual; pad to the longer to avoid
  // length-based timing leak.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still do a constant-time compare against a same-length buffer to
    // prevent length-distinguishing timing differences.
    crypto.timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getKeys() {
  const current = process.env.INTERNAL_API_KEY;
  const previous = process.env.INTERNAL_API_KEY_PREVIOUS;
  const accepted = [];
  if (current) accepted.push(current);
  if (previous) accepted.push(previous);
  return accepted;
}

function internalAuth(req, res, next) {
  const accepted = getKeys();
  if (accepted.length === 0) {
    // Fail-closed: no key configured = endpoint is disabled.
    return res.status(503).json({
      error: 'Internal API is not configured (INTERNAL_API_KEY missing)',
    });
  }
  const provided = req.headers['x-internal-key'];
  if (!provided || typeof provided !== 'string') {
    return res.status(401).json({ error: 'Missing x-internal-key header' });
  }
  // Evaluate against EVERY accepted key — do not short-circuit. Array.some
  // would stop on the first match and leak via wall-clock whether the current
  // or previous key was used during rotation. (Bug 3 from M2 second-round
  // review.) The OR happens after all comparisons complete.
  let ok = false;
  for (const k of accepted) {
    if (safeEqual(provided, k)) ok = true;
  }
  if (!ok) {
    return res.status(401).json({ error: 'Invalid internal key' });
  }
  next();
}

module.exports = { internalAuth, safeEqual };
