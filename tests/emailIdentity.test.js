const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const FeatureFlag = require('../src/models/FeatureFlag');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');
const emailIdentityService = require('../src/services/emailIdentityService');

const { ObjectId } = mongoose.Types;

const originals = {
  flagFindOne: FeatureFlag.findOne,
  getBrandForOrg: brandService.getBrandForOrg,
  EMAIL_FROM: process.env.EMAIL_FROM,
};

let flagState;
let brandState;

beforeEach(() => {
  flagService.clearFlagCache();
  flagState = { enabled: true, implemented: true };
  brandState = { entitled: true, config: {} };
  FeatureFlag.findOne = () => ({ select: () => ({ lean: async () => flagState }) });
  brandService.getBrandForOrg = async () => brandState;
  process.env.EMAIL_FROM = 'SupaRank <no-reply@suparank.com>';
});

afterEach(() => {
  FeatureFlag.findOne = originals.flagFindOne;
  brandService.getBrandForOrg = originals.getBrandForOrg;
  if (originals.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = originals.EMAIL_FROM;
  flagService.clearFlagCache();
});

const orgId = new ObjectId();

describe('flagService.isFlagLive', () => {
  it('true only when enabled AND implemented', async () => {
    assert.equal(await flagService.isFlagLive('whiteLabelEmail'), true);
    flagService.clearFlagCache();
    flagState = { enabled: true, implemented: false };
    assert.equal(await flagService.isFlagLive('whiteLabelEmail'), false);
  });

  it('fails closed on missing flag or lookup error', async () => {
    flagState = null;
    assert.equal(await flagService.isFlagLive('nope'), false);
    flagService.clearFlagCache();
    FeatureFlag.findOne = () => ({
      select: () => ({ lean: async () => { throw new Error('db down'); } }),
    });
    assert.equal(await flagService.isFlagLive('whiteLabelEmail'), false);
  });

  it('caches until cleared', async () => {
    let calls = 0;
    FeatureFlag.findOne = () => ({
      select: () => ({ lean: async () => { calls++; return flagState; } }),
    });
    await flagService.isFlagLive('x');
    await flagService.isFlagLive('x');
    assert.equal(calls, 1);
  });
});

describe('emailIdentityService.resolveSenderIdentity', () => {
  it('verified sender domain → agency name + agency address', async () => {
    brandState = {
      entitled: true,
      config: {
        emailFromName: 'Acme Agency',
        emailDomain: { domain: 'mail.acme.com', status: 'verified' },
      },
    };
    assert.deepEqual(await emailIdentityService.resolveSenderIdentity(orgId), {
      fromName: 'Acme Agency',
      fromEmail: 'no-reply@mail.acme.com',
    });
  });

  it('custom name without verified domain → agency name on the platform address', async () => {
    brandState = {
      entitled: true,
      config: { emailFromName: 'Acme Agency', emailDomain: { domain: 'mail.acme.com', status: 'pending' } },
    };
    assert.deepEqual(await emailIdentityService.resolveSenderIdentity(orgId), {
      fromName: 'Acme Agency',
      fromEmail: 'no-reply@suparank.com',
    });
  });

  it('productName is the from-name fallback', async () => {
    brandState = {
      entitled: true,
      config: { productName: 'Acme SEO', emailDomain: { domain: 'mail.acme.com', status: 'verified' } },
    };
    const identity = await emailIdentityService.resolveSenderIdentity(orgId);
    assert.equal(identity.fromName, 'Acme SEO');
  });

  it('null when: no org / flag off / not entitled / nothing customized', async () => {
    assert.equal(await emailIdentityService.resolveSenderIdentity(null), null);

    flagService.clearFlagCache();
    flagState = { enabled: true, implemented: false };
    brandState = { entitled: true, config: { emailFromName: 'Acme' } };
    assert.equal(await emailIdentityService.resolveSenderIdentity(orgId), null);

    flagService.clearFlagCache();
    flagState = { enabled: true, implemented: true };
    brandState = { entitled: false, config: { emailFromName: 'Acme' } };
    assert.equal(await emailIdentityService.resolveSenderIdentity(orgId), null);

    brandState = { entitled: true, config: {} };
    assert.equal(await emailIdentityService.resolveSenderIdentity(orgId), null);
  });

  it('fails open to null on lookup errors (email must still send)', async () => {
    brandService.getBrandForOrg = async () => {
      throw new Error('brand down');
    };
    assert.equal(await emailIdentityService.resolveSenderIdentity(orgId), null);
  });
});
