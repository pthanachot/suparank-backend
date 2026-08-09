/**
 * Tenant custom domains (Phase 8) + tenant-aware base URLs (Phase 9).
 *
 * Verification flow:
 *   1. createDomain     → doc in 'pending_dns' with a 32-hex TXT token
 *   2. customer adds    CNAME <hostname> → CF_FALLBACK_ORIGIN
 *                       TXT   _suparank-verify.<hostname> → token
 *   3. verifyDomain     → DNS checks pass → Cloudflare custom hostname
 *                         ('pending_ssl'), first poll may flip to 'active'
 *   4. cron re-check    → refreshDomainStatus keeps pending_ssl/active honest
 *
 * INVARIANT I1: every tenant-facing link the backend emits for an org must
 * be built from resolveBaseUrl(orgId) — never raw FRONTEND_URL — so agency
 * customers' users stay on the agency's domain.
 *
 * Host→org and org→baseUrl lookups sit on the request/email path, so both
 * are cached (brandService-style 5-min TTL Map) with explicit invalidation
 * on every domain mutation.
 */

const crypto = require('crypto');
const dns = require('dns');
const Domain = require('../models/Domain');
const cloudflareService = require('./cloudflareService');
const { appUrl } = require('../config/appUrl');

const DEFAULT_PLATFORM_HOSTS = 'app.suparank.ai,suparank.ai,www.suparank.ai';
const DEFAULT_FALLBACK_ORIGIN = 'wl.suparank.ai';

// Injectable DNS resolver (node's dns.promises in production; tests swap in
// a stub — no network in the test suite).
let _dnsResolver = dns.promises;

/** Test hook — inject a stub resolver; pass nothing to restore the real one. */
function _setDnsResolver(resolver) {
  _dnsResolver = resolver || dns.promises;
}

// ─── TTL cache (host→org and org→baseUrl) ───────────────────────

const CACHE_TTL = 5 * 60 * 1000;
// Hard cap: host lookups are keyed on ATTACKER-CONTROLLED hostnames via the
// public X-Tenant-Host header (pre-auth signup path) — without a cap, a
// loop of unique hostnames grows the Map unboundedly (memory DoS).
const CACHE_MAX_ENTRIES = 5000;
const _cache = new Map(); // key → { value, ts }

function _getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _setCached(key, value) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, entry] of _cache) {
      if (now - entry.ts > CACHE_TTL) _cache.delete(k);
    }
    // Still full after expiry sweep → evict oldest-inserted
    while (_cache.size >= CACHE_MAX_ENTRIES) {
      _cache.delete(_cache.keys().next().value);
    }
  }
  _cache.set(key, { value, ts: Date.now() });
}

function clearDomainCache() {
  _cache.clear();
}

// ─── Launch kill switch ─────────────────────────────────────────

/**
 * Tenant domains ship dark: the 'customDomains' FeatureFlag (enabled &&
 * implemented) is the single backend switch. While off, host→org
 * resolution returns null (tenant hosts see the platform brand) and
 * resolveBaseUrl always returns the platform URL — even for domains
 * already marked active. Fail-closed via flagService.
 */
function isCustomDomainsEnabled() {
  return require('./flagService').isFlagLive('customDomains');
}

// ─── Hostname validation ────────────────────────────────────────

// Full FQDN: labels of a-z 0-9 and hyphens (no leading/trailing hyphen),
// at least two labels, alphabetic TLD of 2+ chars.
const FQDN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function _fallbackOrigin() {
  return (process.env.CF_FALLBACK_ORIGIN || DEFAULT_FALLBACK_ORIGIN).trim().toLowerCase();
}

function _reservedHosts() {
  const raw = process.env.PLATFORM_HOSTS || DEFAULT_PLATFORM_HOSTS;
  const hosts = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  hosts.push(_fallbackOrigin());
  return hosts;
}

/**
 * Normalize + validate a customer hostname.
 * Returns { ok: true, hostname } or { ok: false, error }.
 */
function validateHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!value) return { ok: false, error: 'Hostname is required' };
  if (value.length > 253) {
    return { ok: false, error: 'Hostname must be at most 253 characters' };
  }
  if (!FQDN.test(value)) {
    return {
      ok: false,
      error:
        'Enter a valid domain like app.youragency.com (letters, numbers and hyphens only)',
    };
  }
  if (_reservedHosts().includes(value)) {
    return { ok: false, error: 'This hostname is reserved by the platform' };
  }
  return { ok: true, hostname: value };
}

// ─── CRUD ───────────────────────────────────────────────────────

/**
 * Create a domain in 'pending_dns'. The org's first domain becomes primary.
 * Throws Error with .status (400 invalid, 409 already connected).
 */
async function createDomain(orgId, hostname) {
  const validated = validateHostname(hostname);
  if (!validated.ok) {
    const err = new Error(validated.error);
    err.status = 400;
    throw err;
  }

  const verificationToken = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const existingCount = await Domain.countDocuments({ organizationId: orgId });

  let doc;
  try {
    doc = await Domain.create({
      hostname: validated.hostname,
      organizationId: orgId,
      verificationToken,
      isPrimary: existingCount === 0,
    });
  } catch (err) {
    if (err.code === 11000) {
      const friendly = new Error('This domain is already connected to an organization');
      friendly.status = 409;
      throw friendly;
    }
    throw err;
  }

  clearDomainCache();
  return doc;
}

/** DNS records the customer must publish for this domain. */
function dnsInstructions(domain) {
  return {
    cname: {
      name: domain.hostname,
      target: process.env.CF_FALLBACK_ORIGIN || DEFAULT_FALLBACK_ORIGIN,
    },
    txt: {
      name: `_suparank-verify.${domain.hostname}`,
      value: domain.verificationToken,
    },
  };
}

// ─── DNS checks ─────────────────────────────────────────────────

/** TXT ownership check. Returns { ok, detail }. Never throws. */
async function _checkTxt(domain) {
  const record = `_suparank-verify.${domain.hostname}`;
  try {
    const records = await _dnsResolver.resolveTxt(record);
    // Each TXT record arrives as an array of ≤255-char chunks — flatten
    const values = records.map((chunks) => chunks.join(''));
    if (values.includes(domain.verificationToken)) return { ok: true, detail: '' };
    return {
      ok: false,
      detail: `TXT record ${record} found but its value does not match the verification token`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `TXT record ${record} not found (${err.code || err.message})`,
    };
  }
}

/** CNAME → fallback-origin check. Returns { ok, detail }. Never throws. */
async function _checkCname(hostname) {
  const expected = _fallbackOrigin();
  const normalize = (v) => String(v).toLowerCase().replace(/\.$/, '');

  try {
    const cnames = await _dnsResolver.resolveCname(hostname);
    const targets = cnames.map(normalize);
    if (targets.includes(expected)) return { ok: true, detail: '' };
    return {
      ok: false,
      detail: `CNAME for ${hostname} points to ${targets.join(', ') || 'nothing'} instead of ${expected}`,
    };
  } catch (err) {
    // Some providers flatten CNAMEs — see whether ANY records reveal one
    try {
      const any = await _dnsResolver.resolveAny(hostname);
      const cnames = (any || [])
        .filter((r) => r.type === 'CNAME')
        .map((r) => normalize(r.value));
      if (cnames.includes(expected)) return { ok: true, detail: '' };
      const found = (any || [])
        .map((r) => r.address || r.value)
        .filter(Boolean)
        .join(', ');
      return {
        ok: false,
        detail: `No CNAME to ${expected} found for ${hostname}${found ? ` (resolves to ${found})` : ''}`,
      };
    } catch {
      return {
        ok: false,
        detail: `CNAME record for ${hostname} not found (${err.code || err.message}) — expected CNAME to ${expected}`,
      };
    }
  }
}

// ─── Verification + status ──────────────────────────────────────

/**
 * Run the full verification for a domain: TXT ownership + CNAME routing,
 * then Cloudflare SSL provisioning when configured. All failure modes land
 * in status/statusDetail — this never throws for DNS/CF problems.
 * Returns the updated domain doc (null when not found).
 */
async function verifyDomain(domainId) {
  const domain = await Domain.findById(domainId);
  if (!domain) return null;

  domain.lastCheckedAt = new Date();

  // Phase 10 gate: a tenant login page must link the AGENCY's legal pages
  // (their clients are their legal relationship, not ours) — block
  // activation until both URLs are set in Branding.
  try {
    const brandService = require('./brandService');
    const { config } = await brandService.getBrandForOrg(domain.organizationId);
    if (!config?.termsUrl || !config?.privacyUrl) {
      // An ACTIVE domain whose org later cleared its legal URLs must stop
      // resolving (resolveOrgByHost only matches status 'active') — the
      // gate is a real invariant, not activation-time-only. (The branding
      // PUT also blocks clearing these while a domain is live; this is the
      // belt to that suspender.)
      if (domain.status === 'active' || domain.status === 'pending_ssl') {
        domain.status = 'failed';
      }
      domain.statusDetail =
        'Add your Terms of Service and Privacy Policy URLs in Branding settings before this domain can activate.';
      await domain.save();
      clearDomainCache();
      return domain;
    }
  } catch (err) {
    console.error('[domainService] legal-gate lookup failed:', err.message);
    // Fail closed on activation-critical checks
    domain.statusDetail = 'Could not verify branding settings — try again shortly.';
    await domain.save();
    return domain;
  }

  const [txt, cname] = await Promise.all([
    _checkTxt(domain),
    _checkCname(domain.hostname),
  ]);

  if (!txt.ok || !cname.ok) {
    domain.status = 'pending_dns';
    domain.statusDetail = [txt.detail, cname.detail].filter(Boolean).join('; ');
    await domain.save();
    clearDomainCache();
    return domain;
  }

  // DNS verified — hand off to Cloudflare for SSL
  if (cloudflareService.isConfigured()) {
    try {
      if (!domain.cloudflareId) {
        const created = await cloudflareService.createCustomHostname(domain.hostname);
        domain.cloudflareId = created.id || '';
      }
      domain.status = 'pending_ssl';
      domain.statusDetail = 'DNS verified — SSL certificate is being provisioned';
      // Poll once right away; certs are often ready within seconds
      if (domain.cloudflareId) {
        const info = await cloudflareService.getCustomHostname(domain.cloudflareId);
        if (info.sslStatus === 'active') {
          domain.status = 'active';
          domain.statusDetail = '';
        }
      }
    } catch (err) {
      // CF hiccup must not 500 the verify call — DNS part already passed
      domain.status = 'pending_ssl';
      domain.statusDetail = `DNS verified, but SSL provisioning failed: ${err.message}`;
    }
  } else {
    domain.status = 'pending_ssl';
    domain.statusDetail =
      'Cloudflare not configured — hostname verified, SSL provisioning pending platform setup';
  }

  await domain.save();
  clearDomainCache();
  return domain;
}

/**
 * Cron re-check: advance pending_ssl domains whose cert went active, and
 * demote active domains whose CNAME was removed. Never throws.
 */
async function refreshDomainStatus(domain) {
  domain.lastCheckedAt = new Date();

  try {
    if (domain.status === 'pending_ssl') {
      if (domain.cloudflareId && cloudflareService.isConfigured()) {
        const info = await cloudflareService.getCustomHostname(domain.cloudflareId);
        if (info.sslStatus === 'active') {
          domain.status = 'active';
          domain.statusDetail = '';
        } else {
          domain.statusDetail = `Waiting for SSL certificate (Cloudflare status: ${info.sslStatus || 'pending'})`;
        }
      }
      // No cloudflareId / not configured → nothing to poll; stay pending_ssl
    } else if (domain.status === 'active') {
      const cname = await _checkCname(domain.hostname);
      if (!cname.ok) {
        domain.status = 'failed';
        domain.statusDetail = cname.detail;
      }
    }
  } catch (err) {
    domain.statusDetail = `Status check failed: ${err.message}`;
  }

  await domain.save();
  clearDomainCache();
  return domain;
}

// ─── Request-path resolution (cached) ───────────────────────────

/**
 * Host header → organizationId (only 'active' domains resolve).
 * Returns an ObjectId or null. Cached 5 min.
 */
async function resolveOrgByHost(host) {
  const hostname = String(host || '').trim().toLowerCase().split(':')[0];
  if (!hostname) return null;
  if (!(await isCustomDomainsEnabled())) return null;

  const key = `host:${hostname}`;
  const cached = _getCached(key);
  if (cached !== undefined) return cached;

  const doc = await Domain.findOne({ hostname, status: 'active' })
    .select('organizationId')
    .lean();
  const orgId = doc ? doc.organizationId : null;
  _setCached(key, orgId);
  return orgId;
}

/**
 * INVARIANT I1 — the base URL for every tenant-facing link.
 * Org has an active primary domain → https://<hostname>; otherwise the
 * platform frontend. Cached per org (5 min).
 */
async function resolveBaseUrl(orgId) {
  const fallback = appUrl();
  if (!orgId) return fallback;
  if (!(await isCustomDomainsEnabled())) return fallback;

  const key = `base:${String(orgId)}`;
  const cached = _getCached(key);
  if (cached !== undefined) return cached;

  let baseUrl = fallback;
  try {
    const domain =
      (await Domain.findOne({ organizationId: orgId, status: 'active', isPrimary: true })
        .select('hostname')
        .lean()) ||
      // Primary got deleted but another domain is live — still theirs
      (await Domain.findOne({ organizationId: orgId, status: 'active' })
        .select('hostname')
        .lean());
    if (domain) baseUrl = `https://${domain.hostname}`;
  } catch (err) {
    // A broken lookup must never break email sends — use the platform URL
    console.error('[domainService] resolveBaseUrl failed:', err.message);
  }

  _setCached(key, baseUrl);
  return baseUrl;
}

/**
 * INVARIANT I1 for pre-auth flows (signup verification links): the request
 * arrived on some host — if that host is a VERIFIED active tenant domain,
 * links in the resulting emails should stay on it. The header is
 * attacker-controllable, so it is only trusted when it resolves to an
 * active domain in the DB — otherwise a crafted X-Tenant-Host would put
 * a phishing hostname into our verification emails.
 *
 * RESIDUAL SCOPE (accepted): the header may name a DIFFERENT tenant's
 * active domain than the one the user is actually signing up on — for
 * anonymous signup there is no org context to cross-check, so a crafted
 * request can steer the verify link onto another (vetted, SSL'd) agency
 * domain. Impact is brand confusion, not credential theft: the link only
 * controls where the verify page opens, tokens are org-agnostic, and the
 * host pool is limited to verified paying tenants. Authenticated flows
 * that know the user's orgs should prefer resolveBaseUrl(orgId).
 */
async function resolveBaseUrlFromRequest(req) {
  const fallback = appUrl();
  try {
    const header = String(req.headers['x-tenant-host'] || '').trim().toLowerCase();
    if (!header) return fallback;
    const orgId = await resolveOrgByHost(header); // null unless active + flag on
    return orgId ? `https://${header.split(':')[0]}` : fallback;
  } catch (err) {
    // Same guarantee as resolveBaseUrl: a broken lookup must never break
    // the signup/profile flows that build email links — platform URL wins.
    console.error('[domainService] resolveBaseUrlFromRequest failed:', err.message);
    return fallback;
  }
}

module.exports = {
  validateHostname,
  createDomain,
  dnsInstructions,
  verifyDomain,
  refreshDomainStatus,
  resolveOrgByHost,
  resolveBaseUrl,
  resolveBaseUrlFromRequest,
  isCustomDomainsEnabled,
  clearDomainCache,
  _setDnsResolver,
};
