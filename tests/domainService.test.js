const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Domain = require('../src/models/Domain');
const FeatureFlag = require('../src/models/FeatureFlag');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');
const domainService = require('../src/services/domainService');
const cloudflareService = require('../src/services/cloudflareService');

const { ObjectId } = mongoose.Types;

const originals = {
  findOne: Domain.findOne,
  findById: Domain.findById,
  flagFindOne: FeatureFlag.findOne,
  getBrandForOrg: brandService.getBrandForOrg,
  env: {
    APP_URL: process.env.APP_URL,
    FRONTEND_URL: process.env.FRONTEND_URL,
    CF_FALLBACK_ORIGIN: process.env.CF_FALLBACK_ORIGIN,
    PLATFORM_HOSTS: process.env.PLATFORM_HOSTS,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
  },
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originals.env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Flag + brand stubs — the customDomains launch switch defaults ON in
// tests (the gate itself is tested explicitly below), and the Phase 10
// legal gate sees both URLs set unless a test overrides it.
let flagState;
let brandConfigState;

beforeEach(() => {
  domainService.clearDomainCache();
  flagService.clearFlagCache();
  domainService._setDnsResolver(null);
  flagState = { enabled: true, implemented: true };
  brandConfigState = { termsUrl: 'https://x.com/t', privacyUrl: 'https://x.com/p' };
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => flagState }),
  });
  brandService.getBrandForOrg = async () => ({ config: brandConfigState });
  // APP_URL is preferred over FRONTEND_URL by src/config/appUrl.js, so it must
  // be cleared too — otherwise a developer with APP_URL exported in their shell
  // sees these cases fail for reasons that have nothing to do with the code.
  delete process.env.APP_URL;
  delete process.env.FRONTEND_URL;
  delete process.env.PLATFORM_HOSTS;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ZONE_ID;
  delete process.env.CF_FALLBACK_ORIGIN;
});

afterEach(() => {
  flagService.clearFlagCache();
  Domain.findOne = originals.findOne;
  Domain.findById = originals.findById;
  FeatureFlag.findOne = originals.flagFindOne;
  brandService.getBrandForOrg = originals.getBrandForOrg;
  domainService._setDnsResolver(null);
  domainService.clearDomainCache();
  restoreEnv();
});

// ─── validateHostname ────────────────────────────────────────────

describe('domainService.validateHostname', () => {
  it('accepts a valid FQDN and normalizes case/whitespace', () => {
    const r = domainService.validateHostname('  App.YourAgency.COM ');
    assert.equal(r.ok, true);
    assert.equal(r.hostname, 'app.youragency.com');
  });

  it('rejects bad characters and malformed labels', () => {
    assert.equal(domainService.validateHostname('bad_host.com').ok, false);
    assert.equal(domainService.validateHostname('spaces here.com').ok, false);
    assert.equal(domainService.validateHostname('-lead.example.com').ok, false);
    assert.equal(domainService.validateHostname('trail-.example.com').ok, false);
    assert.equal(domainService.validateHostname('https://app.example.com').ok, false);
  });

  it('rejects single-label hosts and numeric TLDs', () => {
    assert.equal(domainService.validateHostname('localhost').ok, false);
    assert.equal(domainService.validateHostname('example.123').ok, false);
    assert.equal(domainService.validateHostname('').ok, false);
  });

  it('rejects hosts over 253 characters', () => {
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`;
    assert.equal(domainService.validateHostname(long).ok, false);
  });

  it('rejects reserved platform hosts (default list)', () => {
    assert.equal(domainService.validateHostname('app.suparank.ai').ok, false);
    assert.equal(domainService.validateHostname('suparank.ai').ok, false);
    assert.equal(domainService.validateHostname('www.suparank.ai').ok, false);
  });

  it('rejects hosts from a custom PLATFORM_HOSTS list', () => {
    process.env.PLATFORM_HOSTS = 'portal.example.com, other.example.com';
    assert.equal(domainService.validateHostname('portal.example.com').ok, false);
    // Default list no longer applies when the env override is set
    assert.equal(domainService.validateHostname('app.suparank.ai').ok, true);
  });

  it('rejects the CF fallback origin itself', () => {
    process.env.CF_FALLBACK_ORIGIN = 'wl.suparank.ai';
    assert.equal(domainService.validateHostname('wl.suparank.ai').ok, false);
    assert.equal(domainService.validateHostname('app.customer.com').ok, true);
  });
});

// ─── resolveBaseUrl (Invariant I1) ───────────────────────────────

describe('domainService.resolveBaseUrl', () => {
  const orgId = new ObjectId();

  function stubFindOne(handler) {
    Domain.findOne = (filter) => ({
      select: () => ({ lean: async () => handler(filter) }),
    });
  }

  it('returns https://<primary active domain> when one exists', async () => {
    stubFindOne((filter) =>
      filter.isPrimary === true ? { hostname: 'app.acme-agency.com' } : null
    );
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://app.acme-agency.com');
  });

  it('falls back to any active domain when no primary is active', async () => {
    stubFindOne((filter) =>
      filter.isPrimary === true ? null : { hostname: 'seo.acme-agency.com' }
    );
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://seo.acme-agency.com');
  });

  it('falls back to FRONTEND_URL when the org has no active domain', async () => {
    process.env.FRONTEND_URL = 'https://app.suparank.ai';
    stubFindOne(() => null);
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://app.suparank.ai');
  });

  // Was 'http://localhost:3000'. A production backend with no origin configured
  // used to put localhost links into real emails; the canonical apex is the only
  // safe last resort. Mirrors the same decision in tests/emailBrandLogo.test.js.
  it('falls back to the canonical app origin with neither var set, and for a null org', async () => {
    stubFindOne(() => null);
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://suparank.ai');
    assert.equal(await domainService.resolveBaseUrl(null), 'https://suparank.ai');
  });

  it('prefers APP_URL over FRONTEND_URL', async () => {
    process.env.FRONTEND_URL = 'https://old-host.example';
    process.env.APP_URL = 'https://suparank.ai';
    stubFindOne(() => null);
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://suparank.ai');
  });

  it('strips a trailing slash so link concatenation stays well-formed', async () => {
    process.env.APP_URL = 'https://suparank.ai/';
    stubFindOne(() => null);
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://suparank.ai');
  });

  it('caches per org and clearDomainCache invalidates', async () => {
    let calls = 0;
    stubFindOne((filter) => {
      calls++;
      return filter.isPrimary === true ? { hostname: 'app.acme-agency.com' } : null;
    });
    await domainService.resolveBaseUrl(orgId);
    await domainService.resolveBaseUrl(orgId);
    assert.equal(calls, 1); // second call served from cache

    domainService.clearDomainCache();
    await domainService.resolveBaseUrl(orgId);
    assert.equal(calls, 2);
  });

  it('a DB error falls back to the platform URL instead of throwing', async () => {
    Domain.findOne = () => ({
      select: () => ({
        lean: async () => {
          throw new Error('db down');
        },
      }),
    });
    // Was localhost — the fallback is now the canonical app origin, so a DB
    // outage degrades to a real, servable link rather than a dead one.
    assert.equal(await domainService.resolveBaseUrl(orgId), 'https://suparank.ai');
  });
});

// ─── resolveOrgByHost ────────────────────────────────────────────

describe('domainService.resolveOrgByHost', () => {
  const orgId = new ObjectId();

  it('resolves an active hostname (case-insensitive, port stripped) to its org', async () => {
    Domain.findOne = (filter) => ({
      select: () => ({
        lean: async () =>
          filter.hostname === 'app.acme-agency.com' && filter.status === 'active'
            ? { organizationId: orgId }
            : null,
      }),
    });
    assert.equal(await domainService.resolveOrgByHost('App.Acme-Agency.com:443'), orgId);
    assert.equal(await domainService.resolveOrgByHost('unknown.example.com'), null);
    assert.equal(await domainService.resolveOrgByHost(''), null);
  });
});

// ─── verifyDomain ────────────────────────────────────────────────

describe('domainService.verifyDomain', () => {
  const orgId = new ObjectId();
  let doc;
  let saved;

  beforeEach(() => {
    saved = false;
    doc = {
      _id: new ObjectId(),
      hostname: 'app.acme-agency.com',
      organizationId: orgId,
      status: 'pending_dns',
      statusDetail: '',
      verificationToken: 'a'.repeat(32),
      cloudflareId: '',
      lastCheckedAt: null,
      async save() {
        saved = true;
        return this;
      },
    };
    Domain.findById = async () => doc;
  });

  it('TXT value mismatch keeps pending_dns with an explanatory statusDetail', async () => {
    domainService._setDnsResolver({
      resolveTxt: async () => [['wrong-token']],
      resolveCname: async () => ['wl.suparank.ai'],
      resolveAny: async () => [],
    });

    const result = await domainService.verifyDomain(doc._id);
    assert.equal(result.status, 'pending_dns');
    assert.match(result.statusDetail, /does not match the verification token/);
    assert.ok(result.lastCheckedAt instanceof Date);
    assert.equal(saved, true);
  });

  it('missing TXT record keeps pending_dns and names the missing record', async () => {
    domainService._setDnsResolver({
      resolveTxt: async () => {
        const err = new Error('queryTxt ENODATA');
        err.code = 'ENODATA';
        throw err;
      },
      resolveCname: async () => ['wl.suparank.ai'],
      resolveAny: async () => [],
    });

    const result = await domainService.verifyDomain(doc._id);
    assert.equal(result.status, 'pending_dns');
    assert.match(result.statusDetail, /_suparank-verify\.app\.acme-agency\.com/);
  });

  it('CNAME pointing elsewhere fails with a detail naming what was found', async () => {
    domainService._setDnsResolver({
      resolveTxt: async () => [['a'.repeat(32)]],
      resolveCname: async () => ['ghs.googlehosted.com'],
      resolveAny: async () => [],
    });

    const result = await domainService.verifyDomain(doc._id);
    assert.equal(result.status, 'pending_dns');
    assert.match(result.statusDetail, /ghs\.googlehosted\.com/);
    assert.match(result.statusDetail, /wl\.suparank\.ai/);
  });

  it('TXT + CNAME ok without Cloudflare configured → pending_ssl with the setup note', async () => {
    // TXT arrives chunked — verifyDomain must flatten before comparing
    domainService._setDnsResolver({
      resolveTxt: async () => [['a'.repeat(20), 'a'.repeat(12)]],
      resolveCname: async () => ['WL.suparank.ai.'],
      resolveAny: async () => [],
    });

    const result = await domainService.verifyDomain(doc._id);
    assert.equal(result.status, 'pending_ssl');
    assert.match(result.statusDetail, /Cloudflare not configured/);
  });

  it('DNS resolver blowing up entirely never throws — lands in statusDetail', async () => {
    domainService._setDnsResolver({
      resolveTxt: async () => {
        throw new Error('ETIMEOUT');
      },
      resolveCname: async () => {
        throw new Error('ETIMEOUT');
      },
      resolveAny: async () => {
        throw new Error('ETIMEOUT');
      },
    });

    const result = await domainService.verifyDomain(doc._id);
    assert.equal(result.status, 'pending_dns');
    assert.ok(result.statusDetail.length > 0);
  });

  it('returns null for an unknown domain id', async () => {
    Domain.findById = async () => null;
    assert.equal(await domainService.verifyDomain(new ObjectId()), null);
  });
});

// ─── cloudflareService.isConfigured ──────────────────────────────

describe('cloudflareService.isConfigured', () => {
  it('is true only when all three env vars are set', () => {
    const matrix = [
      [null, null, null, false],
      ['tok', null, null, false],
      [null, 'zone', null, false],
      [null, null, 'wl.suparank.ai', false],
      ['tok', 'zone', null, false],
      ['tok', null, 'wl.suparank.ai', false],
      [null, 'zone', 'wl.suparank.ai', false],
      ['tok', 'zone', 'wl.suparank.ai', true],
    ];
    for (const [token, zone, origin, expected] of matrix) {
      if (token) process.env.CLOUDFLARE_API_TOKEN = token;
      else delete process.env.CLOUDFLARE_API_TOKEN;
      if (zone) process.env.CLOUDFLARE_ZONE_ID = zone;
      else delete process.env.CLOUDFLARE_ZONE_ID;
      if (origin) process.env.CF_FALLBACK_ORIGIN = origin;
      else delete process.env.CF_FALLBACK_ORIGIN;
      assert.equal(
        cloudflareService.isConfigured(),
        expected,
        `token=${token} zone=${zone} origin=${origin}`
      );
    }
  });

  it('every method throws a clear error when unconfigured (no network call)', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ZONE_ID;
    delete process.env.CF_FALLBACK_ORIGIN;
    await assert.rejects(
      () => cloudflareService.createCustomHostname('app.example.com'),
      /Cloudflare is not configured/
    );
    await assert.rejects(() => cloudflareService.getCustomHostname('id'), /not configured/);
    await assert.rejects(() => cloudflareService.deleteCustomHostname('id'), /not configured/);
  });
});

// ─── Launch kill switch + Phase 10 gates ─────────────────────────

describe('customDomains kill switch', () => {
  it('flag off → resolveOrgByHost returns null even for an active domain', async () => {
    flagState = { enabled: true, implemented: false };
    Domain.findOne = () => ({
      select: () => ({ lean: async () => ({ organizationId: new ObjectId() }) }),
    });
    assert.equal(await domainService.resolveOrgByHost('app.acme.com'), null);
  });

  it('flag off → resolveBaseUrl always returns the platform URL', async () => {
    flagState = null; // flag missing entirely — fail closed
    process.env.FRONTEND_URL = 'https://app.suparank.ai';
    Domain.findOne = () => {
      throw new Error('must not query domains when the flag is off');
    };
    assert.equal(
      await domainService.resolveBaseUrl(new ObjectId()),
      'https://app.suparank.ai'
    );
  });

  it('flag lookup failure → fail closed (off)', async () => {
    FeatureFlag.findOne = () => ({
      select: () => ({ lean: async () => { throw new Error('db down'); } }),
    });
    assert.equal(await domainService.resolveOrgByHost('app.acme.com'), null);
  });
});

describe('resolveBaseUrlFromRequest (validated X-Tenant-Host)', () => {
  it('uses the header host only when it resolves to an active domain', async () => {
    const orgId = new ObjectId();
    Domain.findOne = () => ({
      select: () => ({ lean: async () => ({ organizationId: orgId }) }),
    });
    const req = { headers: { 'x-tenant-host': 'App.Acme.com' } };
    assert.equal(await domainService.resolveBaseUrlFromRequest(req), 'https://app.acme.com');
  });

  it('rejects an unverified header host (phishing guard)', async () => {
    process.env.FRONTEND_URL = 'https://app.suparank.ai';
    Domain.findOne = () => ({
      select: () => ({ lean: async () => null }),
    });
    const req = { headers: { 'x-tenant-host': 'evil.example.com' } };
    assert.equal(
      await domainService.resolveBaseUrlFromRequest(req),
      'https://app.suparank.ai'
    );
  });

  it('no header → platform URL, no DB query', async () => {
    process.env.FRONTEND_URL = 'https://app.suparank.ai';
    Domain.findOne = () => {
      throw new Error('must not query without a header');
    };
    assert.equal(
      await domainService.resolveBaseUrlFromRequest({ headers: {} }),
      'https://app.suparank.ai'
    );
  });
});

describe('verifyDomain legal-URL gate (Phase 10)', () => {
  function stubDomainDoc() {
    const doc = {
      _id: new ObjectId(),
      hostname: 'app.acme.com',
      organizationId: new ObjectId(),
      verificationToken: 'tok',
      status: 'pending_dns',
      statusDetail: '',
      save: async function () { return this; },
    };
    Domain.findById = async () => doc;
    return doc;
  }

  it('blocks verification until termsUrl AND privacyUrl are set in branding', async () => {
    brandConfigState = { termsUrl: 'https://x.com/t', privacyUrl: '' };
    const doc = stubDomainDoc();
    domainService._setDnsResolver({
      resolveTxt: async () => { throw new Error('must not reach DNS'); },
      resolveCname: async () => { throw new Error('must not reach DNS'); },
    });
    const result = await domainService.verifyDomain(doc._id);
    assert.match(result.statusDetail, /Terms of Service and Privacy Policy/);
    assert.equal(result.status, 'pending_dns');
  });

  it('proceeds to DNS checks when both legal URLs are set', async () => {
    const doc = stubDomainDoc();
    let dnsReached = false;
    domainService._setDnsResolver({
      resolveTxt: async () => { dnsReached = true; return [['wrong']]; },
      resolveCname: async () => ['wl.suparank.ai'],
      resolveAny: async () => [],
    });
    await domainService.verifyDomain(doc._id);
    assert.equal(dnsReached, true);
  });
});

describe('resolveBaseUrlFromRequest — no-throw guarantee', () => {
  it('Domain lookup failure → platform URL, no throw (signup must not 500)', async () => {
    process.env.FRONTEND_URL = 'https://app.suparank.ai';
    Domain.findOne = () => ({
      select: () => ({ lean: async () => { throw new Error('db down'); } }),
    });
    const req = { headers: { 'x-tenant-host': 'app.acme.com' } };
    assert.equal(
      await domainService.resolveBaseUrlFromRequest(req),
      'https://app.suparank.ai'
    );
  });
});
