/**
 * Brand resolution for white-label tenants (Phase 5).
 *
 * Resolution order: HARDCODED_DEFAULTS ← platform doc ← org doc.
 * Org overrides only apply while the org's tier carries the
 * custom.whiteLabel entitlement — on downgrade the config is retained
 * but resolution falls back to the platform brand.
 *
 * Cached per scopeKey (5-min TTL) with explicit invalidation on update;
 * safe on the request path.
 */

const BrandConfig = require('../models/BrandConfig');
const tierService = require('./tierService');
const flagService = require('./flagService');

// What SupaRank looks like when nothing is configured.
const HARDCODED_DEFAULTS = Object.freeze({
  productName: 'SupaRank',
  logoUrl: '', // empty = frontend renders the built-in logomark
  logoIconUrl: '',
  faviconUrl: '',
  primaryColor: '#2B5BE8',
  emailFromName: 'SupaRank',
  supportEmail: 'support@suparank.ai',
  termsUrl: '/terms',
  privacyUrl: '/privacy',
  loginCopy: { headline: '', subline: '' },
  hideAttribution: false,
});

// Fields an org may override, and the shape returned to browsers.
const OVERRIDABLE_FIELDS = [
  'productName',
  'logoUrl',
  'logoIconUrl',
  'faviconUrl',
  'primaryColor',
  'emailFromName',
  'supportEmail',
  'termsUrl',
  'privacyUrl',
  'hideAttribution',
];

const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map(); // scopeKey → { value, ts }

function _getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function clearBrandCache(organizationId = null) {
  if (organizationId) {
    _cache.delete(BrandConfig.scopeKeyFor(organizationId));
    _cache.delete('resolved:' + BrandConfig.scopeKeyFor(organizationId));
  } else {
    _cache.clear();
  }
}

async function _getDoc(scopeKey) {
  const cached = _getCached(scopeKey);
  if (cached !== undefined) return cached;
  const doc = await BrandConfig.findOne({ scopeKey }).lean();
  _cache.set(scopeKey, { value: doc || null, ts: Date.now() });
  return doc || null;
}

/** Overlay non-empty override values onto a base brand. */
function _merge(base, doc) {
  if (!doc) return { ...base, loginCopy: { ...base.loginCopy } };
  const out = { ...base, loginCopy: { ...base.loginCopy } };
  for (const field of OVERRIDABLE_FIELDS) {
    const v = doc[field];
    if (typeof v === 'boolean') out[field] = v;
    else if (v != null && v !== '') out[field] = v;
  }
  if (doc.loginCopy?.headline) out.loginCopy.headline = doc.loginCopy.headline;
  if (doc.loginCopy?.subline) out.loginCopy.subline = doc.loginCopy.subline;
  return out;
}

/** The platform's own brand (hardcoded defaults + admin-editable platform doc). */
async function getPlatformBrand() {
  const platformDoc = await _getDoc('platform');
  return _merge(HARDCODED_DEFAULTS, platformDoc);
}

/** True when the org's tier carries the white-label entitlement. */
async function isWhiteLabelEntitled(organizationId) {
  try {
    const { config } = await tierService.getOrgTierConfig(organizationId);
    return Boolean(config?.custom?.whiteLabel);
  } catch {
    return false; // entitlement check failing must not grant white-label
  }
}

/** True when the org's tier carries the SaaS-mode entitlement (Phase 16). */
async function isSaasModeEntitled(organizationId) {
  try {
    const { config } = await tierService.getOrgTierConfig(organizationId);
    return Boolean(config?.custom?.saasMode);
  } catch {
    return false; // entitlement check failing must not grant SaaS mode
  }
}

/**
 * Fully-resolved brand for an org. Falls back to the platform brand when
 * the org has no config, lost the entitlement, or the whiteLabel launch
 * flag is off (Phase 8: the flag is the ops kill-switch — flipping it off
 * de-brands public reports/emails within the 5-min flag cache, same
 * dark-ship semantics as customDomains). `entitled` still reports the TIER
 * entitlement so settings UIs can distinguish "upgrade" from "switched off".
 * Returns { brand, entitled, hasConfig }.
 */
async function getBrandForOrg(organizationId) {
  if (!organizationId) {
    const platformBrand = await getPlatformBrand();
    return { brand: platformBrand, entitled: false, hasConfig: false, config: null };
  }

  const [platformBrand, doc, entitled, flagLive] = await Promise.all([
    getPlatformBrand(),
    _getDoc(BrandConfig.scopeKeyFor(organizationId)),
    isWhiteLabelEntitled(organizationId),
    flagService.isFlagLive('whiteLabel'),
  ]);

  return {
    brand: entitled && flagLive ? _merge(platformBrand, doc) : platformBrand,
    entitled,
    hasConfig: Boolean(doc),
    config: doc, // raw overrides — saves callers a second findOne
  };
}

/**
 * Resolve a brand from a request Host header (Phase 8): active custom
 * domain → that org's brand; anything else → the platform brand.
 */
async function resolveBrandByHost(host) {
  // Lazy require — keeps brandService free of a hard edge to domainService
  // (which may grow brand-aware features later) and avoids require cycles.
  const domainService = require('./domainService');
  const orgId = await domainService.resolveOrgByHost(host);
  if (orgId) {
    const { brand } = await getBrandForOrg(orgId);
    return brand;
  }
  return getPlatformBrand();
}

// ─── Validation ─────────────────────────────────────────────────

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function _isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validates a brand patch. Returns { ok: true, patch } with only known,
 * sanitized fields, or { ok: false, error }.
 * Empty string clears an override (falls back to platform default).
 */
function validateBrandPatch(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid payload' };
  }
  const patch = {};

  const strField = (name, max) => {
    if (input[name] === undefined) return null;
    // null clears the override, same as '' — never stringify it to 'null'
    if (input[name] !== null && typeof input[name] !== 'string' && typeof input[name] !== 'number') {
      return `${name} must be a string`;
    }
    const v = input[name] === null ? '' : String(input[name]).trim();
    if (v.length > max) return `${name} must be at most ${max} characters`;
    patch[name] = v;
    return null;
  };

  let err =
    strField('productName', 40) ||
    strField('emailFromName', 60);
  if (err) return { ok: false, error: err };

  if (input.primaryColor !== undefined) {
    const v = String(input.primaryColor).trim();
    if (v && !HEX_COLOR.test(v)) {
      return { ok: false, error: 'primaryColor must be a #RRGGBB hex color' };
    }
    patch.primaryColor = v;
  }

  for (const name of ['logoUrl', 'logoIconUrl', 'faviconUrl', 'termsUrl', 'privacyUrl']) {
    if (input[name] === undefined) continue;
    const v = String(input[name]).trim();
    if (v && !_isHttpUrl(v) && !v.startsWith('/')) {
      return { ok: false, error: `${name} must be an http(s) URL or a path` };
    }
    patch[name] = v;
  }

  if (input.supportEmail !== undefined) {
    const v = String(input.supportEmail).trim().toLowerCase();
    if (v && !EMAIL.test(v)) {
      return { ok: false, error: 'supportEmail must be a valid email address' };
    }
    patch.supportEmail = v;
  }

  if (input.hideAttribution !== undefined) {
    // null = 'inherit from platform' → stored as an $unset (no schema
    // default, so absent means inherit — see updateBrand)
    patch.hideAttribution = input.hideAttribution === null ? null : Boolean(input.hideAttribution);
  }

  // Partial patch via dot-paths — sending only {loginCopy:{headline}} must
  // not wipe a previously-saved subline
  if (input.loginCopy !== undefined && input.loginCopy !== null) {
    if (input.loginCopy.headline !== undefined) {
      const headline = String(input.loginCopy.headline ?? '').trim();
      if (headline.length > 80) return { ok: false, error: 'loginCopy.headline must be at most 80 characters' };
      patch['loginCopy.headline'] = headline;
    }
    if (input.loginCopy.subline !== undefined) {
      const subline = String(input.loginCopy.subline ?? '').trim();
      if (subline.length > 160) return { ok: false, error: 'loginCopy.subline must be at most 160 characters' };
      patch['loginCopy.subline'] = subline;
    }
  }

  return { ok: true, patch };
}

/** Upsert an org's brand config (or the platform default with orgId null). */
async function updateBrand(organizationId, patch) {
  const scopeKey = BrandConfig.scopeKeyFor(organizationId);
  // null values mean 'remove the override entirely' (inherit) — currently
  // used by hideAttribution, whose false is a real override
  const set = {};
  const unset = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) unset[key] = 1;
    else set[key] = value;
  }
  const update = {
    $setOnInsert: { scopeKey, organizationId: organizationId || null },
  };
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;
  const doc = await BrandConfig.findOneAndUpdate({ scopeKey }, update, {
    new: true,
    upsert: true,
  }).lean();
  clearBrandCache(organizationId);
  return doc;
}

module.exports = {
  HARDCODED_DEFAULTS,
  getPlatformBrand,
  getBrandForOrg,
  resolveBrandByHost,
  isWhiteLabelEntitled,
  isSaasModeEntitled,
  validateBrandPatch,
  updateBrand,
  clearBrandCache,
};
