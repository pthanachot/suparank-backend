const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const BrandConfig = require('../src/models/BrandConfig');
const tierService = require('../src/services/tierService');
const flagService = require('../src/services/flagService');
const brandService = require('../src/services/brandService');

const { ObjectId } = mongoose.Types;

const originals = {
  findOne: BrandConfig.findOne,
  getOrgTierConfig: tierService.getOrgTierConfig,
  isFlagLive: flagService.isFlagLive,
};

let state;

beforeEach(() => {
  brandService.clearBrandCache();
  state = {
    docs: {}, // scopeKey → doc
    tierCustom: {}, // orgId string → custom object
    whiteLabelLive: true, // Phase 8: brand resolution consults the launch flag
  };
  BrandConfig.findOne = (filter) => ({
    lean: async () => state.docs[filter.scopeKey] || null,
  });
  tierService.getOrgTierConfig = async (orgId) => ({
    tier: 'agency',
    config: { custom: state.tierCustom[String(orgId)] || {} },
  });
  flagService.isFlagLive = async (key) => (key === 'whiteLabel' ? state.whiteLabelLive : false);
});

afterEach(() => {
  BrandConfig.findOne = originals.findOne;
  tierService.getOrgTierConfig = originals.getOrgTierConfig;
  flagService.isFlagLive = originals.isFlagLive;
});

const orgId = new ObjectId();

describe('brandService resolution', () => {
  it('falls back to hardcoded defaults with no configs anywhere', async () => {
    const { brand, entitled, hasConfig } = await brandService.getBrandForOrg(orgId);
    assert.equal(brand.productName, 'SupaRank');
    assert.equal(brand.primaryColor, '#2B5BE8');
    assert.equal(entitled, false);
    assert.equal(hasConfig, false);
  });

  it('entitled org overrides apply on top of the platform brand', async () => {
    state.tierCustom[String(orgId)] = { whiteLabel: true };
    state.docs[String(orgId)] = { productName: 'Acme Agency', primaryColor: '#FF6600' };
    const { brand, entitled } = await brandService.getBrandForOrg(orgId);
    assert.equal(entitled, true);
    assert.equal(brand.productName, 'Acme Agency');
    assert.equal(brand.primaryColor, '#FF6600');
    // Unset fields fall through to defaults
    assert.equal(brand.supportEmail, 'support@suparank.ai');
  });

  it('lost entitlement (downgrade) falls back to platform brand but keeps the config', async () => {
    state.docs[String(orgId)] = { productName: 'Acme Agency' };
    // no whiteLabel in tierCustom → not entitled
    const { brand, entitled, hasConfig } = await brandService.getBrandForOrg(orgId);
    assert.equal(entitled, false);
    assert.equal(hasConfig, true); // retained for re-upgrade
    assert.equal(brand.productName, 'SupaRank');
  });

  it('platform doc overrides defaults for everyone', async () => {
    state.docs['platform'] = { productName: 'SupaRank Pro' };
    const { brand } = await brandService.getBrandForOrg(orgId);
    assert.equal(brand.productName, 'SupaRank Pro');
  });

  it('empty-string overrides are ignored (clear = fall through)', async () => {
    state.tierCustom[String(orgId)] = { whiteLabel: true };
    state.docs[String(orgId)] = { productName: '', primaryColor: '#123456' };
    const { brand } = await brandService.getBrandForOrg(orgId);
    assert.equal(brand.productName, 'SupaRank');
    assert.equal(brand.primaryColor, '#123456');
  });

  it('entitlement check failure denies white-label (fail closed)', async () => {
    tierService.getOrgTierConfig = async () => {
      throw new Error('tier lookup down');
    };
    state.docs[String(orgId)] = { productName: 'Acme Agency' };
    const { brand, entitled } = await brandService.getBrandForOrg(orgId);
    assert.equal(entitled, false);
    assert.equal(brand.productName, 'SupaRank');
  });
});

describe('brandService whiteLabel launch flag (Phase 8)', () => {
  it('flag OFF forces the platform brand even for an entitled org with config', async () => {
    state.tierCustom[String(orgId)] = { whiteLabel: true };
    state.docs[BrandConfig.scopeKeyFor(orgId)] = { productName: 'AgencyBrand', hideAttribution: true };
    state.whiteLabelLive = false;

    const { brand, entitled, hasConfig } = await brandService.getBrandForOrg(orgId);

    // Kill-switch semantics: branding reverts to platform…
    assert.equal(brand.productName, 'SupaRank');
    assert.equal(brand.hideAttribution, false);
    // …but the TIER entitlement still reports true (settings UIs must be
    // able to distinguish "upgrade needed" from "feature switched off")
    assert.equal(entitled, true);
    assert.equal(hasConfig, true);
  });

  it('flag ON restores the entitled merge unchanged', async () => {
    state.tierCustom[String(orgId)] = { whiteLabel: true };
    state.docs[BrandConfig.scopeKeyFor(orgId)] = { productName: 'AgencyBrand' };
    state.whiteLabelLive = true;

    const { brand } = await brandService.getBrandForOrg(orgId);
    assert.equal(brand.productName, 'AgencyBrand');
  });
});

describe('brandService.isSaasModeEntitled', () => {
  it('is entitled when the agency tier carries custom.saasMode', async () => {
    state.tierCustom[String(orgId)] = { saasMode: true };
    assert.equal(await brandService.isSaasModeEntitled(orgId), true);
  });

  it('is not entitled without custom.saasMode', async () => {
    state.tierCustom[String(orgId)] = { whiteLabel: true }; // white-label alone does not grant SaaS mode
    assert.equal(await brandService.isSaasModeEntitled(orgId), false);
  });

  it('fails closed when the tier lookup throws', async () => {
    tierService.getOrgTierConfig = async () => {
      throw new Error('tier lookup down');
    };
    assert.equal(await brandService.isSaasModeEntitled(orgId), false);
  });
});

describe('brandService.validateBrandPatch', () => {
  it('accepts a valid patch and strips unknown fields', () => {
    const r = brandService.validateBrandPatch({
      productName: ' Acme ',
      primaryColor: '#FF6600',
      hideAttribution: true,
      scopeKey: 'platform', // must not pass through
      organizationId: 'x',
    });
    assert.equal(r.ok, true);
    assert.equal(r.patch.productName, 'Acme');
    assert.equal(r.patch.hideAttribution, true);
    assert.equal(r.patch.scopeKey, undefined);
    assert.equal(r.patch.organizationId, undefined);
  });

  it('rejects a bad hex color', () => {
    assert.equal(brandService.validateBrandPatch({ primaryColor: 'red' }).ok, false);
    assert.equal(brandService.validateBrandPatch({ primaryColor: '#FFF' }).ok, false);
  });

  it('rejects non-URL logo values but allows paths and empty (clear)', () => {
    assert.equal(brandService.validateBrandPatch({ logoUrl: 'javascript:alert(1)' }).ok, false);
    assert.equal(brandService.validateBrandPatch({ logoUrl: '/logos/acme.png' }).ok, true);
    assert.equal(brandService.validateBrandPatch({ logoUrl: '' }).ok, true);
  });

  it('rejects an invalid support email and over-long fields', () => {
    assert.equal(brandService.validateBrandPatch({ supportEmail: 'not-an-email' }).ok, false);
    assert.equal(brandService.validateBrandPatch({ productName: 'x'.repeat(41) }).ok, false);
    assert.equal(
      brandService.validateBrandPatch({ loginCopy: { headline: 'x'.repeat(81) } }).ok,
      false
    );
  });
});
