/**
 * Shared SSRF guard for server-side fetches of untrusted URLs.
 *
 * The IP-classification logic is the canonical copy (imageStorage.js imports
 * isPrivateIp/isBlockedHostname from here). Unlike imageStorage's own
 * assertSafeImageURL — which resolves via real DNS — assertUrlAllowed takes an
 * INJECTABLE resolver so callers with a DNS seam (e.g. the sitemap crawler) can
 * be tested hermetically. Fails closed: any parse/scheme/resolution problem
 * throws rather than allowing the fetch.
 */

const net = require('net');
const dnsp = require('dns').promises;

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata.google.internal', 'metadata', 'instance-data',
]);

// Decode an IPv4 embedded in an IPv6 address to a dotted quad, or null if `tail`
// isn't a 32-bit embedded-IPv4 form. Handles the dotted form ("169.254.169.254")
// and the two-hex-group form new URL() normalizes it to ("a9fe:a9fe").
function embeddedV4(tail) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

// Private / loopback / link-local / reserved ranges (IPv4 + IPv6).
function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0) return true;                                 // 0.0.0.0/8
    if (p[0] === 10) return true;                                // 10/8 private
    if (p[0] === 127) return true;                               // loopback
    if (p[0] === 169 && p[1] === 254) return true;              // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;  // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;             // 192.168/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    if (p[0] >= 224) return true;                              // multicast/reserved
    return false;
  }
  if (kind === 6) {
    const h = ip.toLowerCase();
    if (h === '::1' || h === '::') return true;                // loopback / unspecified
    if (/^fe[89ab]/.test(h)) return true;                     // link-local fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA fc00::/7
    // IPv4-mapped ::ffff:a.b.c.d — new URL rewrites the dotted form to hex
    // (::ffff:7f00:1). An unrecognized mapped form fails closed (returns true).
    if (h.startsWith('::ffff:')) {
      const v4 = embeddedV4(h.slice(7));
      return v4 ? isPrivateIp(v4) : true;
    }
    // NAT64 (64:ff9b::/96) tunnels an IPv4 target in the low 32 bits — routable to
    // the embedded IPv4 on DNS64/NAT64 networks. Fail closed on an unparseable tail.
    if (h.startsWith('64:ff9b::')) {
      const v4 = embeddedV4(h.slice('64:ff9b::'.length));
      return v4 ? isPrivateIp(v4) : true;
    }
    // Deprecated IPv4-compatible ::/96 (e.g. ::7f00:1 = 127.0.0.1). Only the 32-bit
    // embedded forms are IPv4; longer ::x:y:z are ordinary IPv6 and left alone.
    if (h.startsWith('::')) {
      const v4 = embeddedV4(h.slice(2));
      if (v4) return isPrivateIp(v4);
    }
    return false;
  }
  return false; // not an IP literal
}

function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  return h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost');
}

/**
 * Throw unless `urlStr` is safe to fetch server-side. Rejects non-http(s)
 * schemes, embedded credentials, blocked hostnames, and literal or DNS-resolved
 * private/loopback/link-local IPs. NOTE: this catches hosts whose records are all
 * private, but does NOT defeat DNS rebinding — the caller re-resolves at fetch
 * time, so the resolved IP must be pinned to close that window. `resolver(host)`
 * must return `[{ address }]` like dns.promises.lookup with { all: true };
 * defaults to real DNS when not supplied.
 */
async function assertUrlAllowed(urlStr, { resolver } = {}) {
  const lookup = resolver || ((h) => dnsp.lookup(h, { all: true }));

  let u;
  try { u = new URL(urlStr); } catch { throw new Error(`SSRF: invalid URL: ${urlStr}`); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`SSRF: scheme not allowed: ${u.protocol}`);
  }
  if (u.username || u.password) throw new Error('SSRF: credentials in URL not allowed');

  const host = u.hostname;
  if (!host) throw new Error('SSRF: missing host');
  if (isBlockedHostname(host)) throw new Error(`SSRF: host not allowed: ${host}`);

  // Literal IP host — check directly (no DNS). new URL keeps IPv6 hosts
  // bracketed ("[::1]") and net.isIP rejects brackets, so strip them first.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error(`SSRF: private IP not allowed: ${host}`);
    return;
  }

  // Hostname — resolve and reject if ANY record is private (anti-rebinding).
  let addrs;
  try { addrs = await lookup(host); } catch { throw new Error(`SSRF: DNS resolution failed: ${host}`); }
  if (!addrs || !addrs.length) throw new Error(`SSRF: no DNS records: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`SSRF: host resolves to private IP: ${host}`);
  }
}

module.exports = { isPrivateIp, isBlockedHostname, assertUrlAllowed };
