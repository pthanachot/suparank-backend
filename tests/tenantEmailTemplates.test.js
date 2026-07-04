/**
 * Per-tenant email template resolution (Phase 12):
 *  1. resolution order — tenant override beats global override beats
 *     hardcoded default; tenant ignored when the whiteLabelEmail flag is
 *     off or when no organizationId is passed,
 *  2. brandName/supportEmail auto-injection (org brand, platform brand,
 *     and the hard fallback when brand lookup throws),
 *  3. the GLOBAL-row query matches legacy rows that predate the
 *     organizationId field entirely,
 *  4. {{brandName}} substitution end-to-end through applyCustomTemplate,
 *  5. the stats upsert always targets the GLOBAL row (never creates
 *     tenant rows as a side effect).
 *
 * emailService, the TriggerableEmailTemplate model, brandService, and
 * flagService are faked — no SMTP, no database.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// Fake emailService BEFORE requiring the controller — the real module builds
// SMTP transports and fires a verify() at load.
require.cache[require.resolve('../src/utils/emailService')] = {
  exports: {
    sendEmail: async () => ({}),
    sendVerificationCodeEmail: async () => ({}),
    sendPasswordResetCodeEmail: async () => ({}),
  },
};

const { applyCustomTemplate } = require('../src/controllers/emailPortalController');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');

const { ObjectId } = mongoose.Types;
const orgId = new ObjectId();

const originals = {
  findOne: TriggerableEmailTemplate.findOne,
  findOneAndUpdate: TriggerableEmailTemplate.findOneAndUpdate,
  isFlagLive: flagService.isFlagLive,
  getBrandForOrg: brandService.getBrandForOrg,
  getPlatformBrand: brandService.getPlatformBrand,
};

let state;

/** Minimal Mongo-filter matcher for the two query shapes the controller uses. */
function matchDoc(doc, filter) {
  if (filter.triggerId && doc.triggerId !== filter.triggerId) return false;
  if (Object.prototype.hasOwnProperty.call(filter, 'organizationId')) {
    // Tenant lookup: exact org match (never matches null/missing)
    if (doc.organizationId == null) return false;
    if (String(doc.organizationId) !== String(filter.organizationId)) return false;
  }
  if (filter.$or) {
    const ok = filter.$or.some((clause) => {
      if (clause.organizationId === null) return doc.organizationId === null;
      if (clause.organizationId && clause.organizationId.$exists === false) {
        return !Object.prototype.hasOwnProperty.call(doc, 'organizationId');
      }
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

beforeEach(() => {
  state = {
    docs: [], // fake emailtriggers collection
    upserts: [], // captured findOneAndUpdate calls (the stats $inc)
    flagLive: true,
  };
  TriggerableEmailTemplate.findOne = (filter) => ({
    lean: async () => state.docs.find((d) => matchDoc(d, filter)) || null,
  });
  TriggerableEmailTemplate.findOneAndUpdate = async (filter, update) => {
    state.upserts.push({ filter, update });
    return null;
  };
  flagService.isFlagLive = async () => state.flagLive;
  brandService.getBrandForOrg = async () => ({
    entitled: true, // tenant overrides only apply while entitled
    brand: { productName: 'Acme Agency', supportEmail: 'help@acme.io' },
  });
  brandService.getPlatformBrand = async () => ({
    productName: 'SupaRank',
    supportEmail: 'support@suparank.ai',
  });
});

afterEach(() => {
  TriggerableEmailTemplate.findOne = originals.findOne;
  TriggerableEmailTemplate.findOneAndUpdate = originals.findOneAndUpdate;
  flagService.isFlagLive = originals.isFlagLive;
  brandService.getBrandForOrg = originals.getBrandForOrg;
  brandService.getPlatformBrand = originals.getPlatformBrand;
});

const tenantRow = () => ({
  triggerId: 'welcome',
  organizationId: orgId,
  defaultSubject: 'TENANT subject for {{userName}}',
  defaultHtml: '<p>TENANT html {{loginUrl}}</p>',
});
const globalRow = () => ({
  triggerId: 'welcome',
  organizationId: null,
  defaultSubject: 'GLOBAL subject',
  defaultHtml: '<p>GLOBAL html</p>',
});
// Legacy prod rows predate the organizationId field entirely
const legacyGlobalRow = () => ({
  triggerId: 'welcome',
  defaultSubject: 'LEGACY GLOBAL subject',
  defaultHtml: '<p>LEGACY GLOBAL html</p>',
});

const welcomeOptions = () => ({
  to: 'x@example.com',
  data: { userName: 'Jane', loginUrl: 'https://app.example.com' },
});

describe('tenant template resolution order', () => {
  it('tenant override beats global override beats default', async () => {
    state.docs = [tenantRow(), globalRow()];
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'TENANT subject for Jane');
    assert.ok(opts.html.includes('TENANT html'));
  });

  it('falls to the global override when the org has none', async () => {
    state.docs = [globalRow()];
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'GLOBAL subject');
  });

  it('falls to the hardcoded default when no rows exist', async () => {
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'Welcome to Acme Agency!');
  });

  it('tenant override is ignored when the whiteLabelEmail flag is off', async () => {
    state.flagLive = false;
    state.docs = [tenantRow(), globalRow()];
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'GLOBAL subject');
  });

  it('tenant override is ignored when no organizationId is passed', async () => {
    state.docs = [tenantRow(), globalRow()];
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts);
    assert.equal(opts.subject, 'GLOBAL subject');
  });

  it('the global-row query matches legacy rows without the organizationId field', async () => {
    state.docs = [legacyGlobalRow()];
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'LEGACY GLOBAL subject');
  });

  it('a tenant row never shadows the global lookup for OTHER orgs', async () => {
    state.docs = [tenantRow()];
    const otherOrg = new ObjectId();
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, otherOrg);
    // No global row, other org has no override → hardcoded default
    assert.equal(opts.subject, 'Welcome to Acme Agency!');
  });
});

describe('brand variable injection', () => {
  it('injects the org brand for {{brandName}} and {{supportEmail}} end-to-end', async () => {
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'Welcome to Acme Agency!');
    assert.ok(opts.html.includes('Acme Agency helps you track'));
    assert.ok(opts.html.includes('help@acme.io'));
    assert.ok(!opts.html.includes('{{'), 'no unresolved placeholders');
    assert.equal(opts.data, undefined, 'data cleared after substitution');
  });

  it('uses the platform brand when no organizationId is given', async () => {
    brandService.getPlatformBrand = async () => ({
      productName: 'SupaRank Pro',
      supportEmail: 'support@suparank.ai',
    });
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, null);
    assert.equal(opts.subject, 'Welcome to SupaRank Pro!');
  });

  it('falls back to SupaRank defaults when the brand lookup throws', async () => {
    brandService.getBrandForOrg = async () => {
      throw new Error('brand service down');
    };
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'Welcome to SupaRank!');
    assert.ok(opts.html.includes('support@suparank.ai'));
  });

  it('never overwrites caller-provided brandName/supportEmail', async () => {
    const opts = {
      to: 'x@example.com',
      data: {
        userName: 'Jane',
        loginUrl: 'https://x',
        brandName: 'Caller Brand',
        supportEmail: 'caller@x.io',
      },
    };
    await applyCustomTemplate('welcome', opts, orgId);
    assert.equal(opts.subject, 'Welcome to Caller Brand!');
    assert.ok(opts.html.includes('caller@x.io'));
  });
});

describe('trigger stats', () => {
  it('the stats upsert targets the GLOBAL row and never a tenant row', async () => {
    state.docs = [tenantRow()];
    const opts = welcomeOptions();
    await applyCustomTemplate('welcome', opts, orgId);

    assert.equal(state.upserts.length, 1);
    const { filter, update } = state.upserts[0];
    assert.equal(filter.triggerId, 'welcome');
    assert.deepEqual(filter.$or, [
      { organizationId: null },
      { organizationId: { $exists: false } },
    ]);
    assert.ok(!Object.prototype.hasOwnProperty.call(filter, 'organizationId'));
    assert.equal(update.$setOnInsert.organizationId, null);
    assert.equal(update.$inc.triggerCount, 1);
  });
});

describe('entitlement downgrade', () => {
  const { applyCustomTemplate } = require('../src/controllers/emailPortalController');
  const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
  const brandService = require('../src/services/brandService');
  const mongooseLocal = require('mongoose');

  it('tenant override is IGNORED when the org lost the white-label entitlement', async () => {
    const orgId = new mongooseLocal.Types.ObjectId();
    brandService.getBrandForOrg = async () => ({ entitled: false, brand: {} });
    TriggerableEmailTemplate.findOne = (filter) => ({
      lean: async () =>
        filter.organizationId && String(filter.organizationId) === String(orgId)
          ? { defaultSubject: 'TENANT SUBJ {{brandName}}', defaultHtml: '<p>tenant</p>' }
          : null,
    });
    TriggerableEmailTemplate.findOneAndUpdate = async () => null;
    const opts = { to: 'x@y.z', data: { userName: 'X', loginUrl: 'https://x' } };
    await applyCustomTemplate('welcome', opts, orgId);
    assert.ok(!opts.subject.startsWith('TENANT SUBJ')); // default applies, not the override
  });
});
