/**
 * normalizeUrl — canonicalize a URL for equality matching between GSC page URLs
 * and stored publishedUrl values. Lowercases scheme + host, strips a single
 * trailing slash from the path (keeping root "/"), drops tracking query params
 * (utm_*, gclid, fbclid, mc_cid, mc_eid), and removes the fragment. Returns ''
 * for empty/unparseable input.
 *
 * Shared by Rec 15 (decay page ↔ content matching); Rec 10 (drift detection)
 * should reuse this rather than duplicate normalization.
 */
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const TRACKING = new Set(['gclid', 'fbclid', 'mc_cid', 'mc_eid']);
  const drop = [];
  for (const key of u.searchParams.keys()) {
    if (/^utm_/i.test(key) || TRACKING.has(key.toLowerCase())) drop.push(key);
  }
  for (const key of drop) u.searchParams.delete(key);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

module.exports = { normalizeUrl };
