/**
 * Phase 7 — POST /billing/request-topup. A non-owner (Admin/Editor) asks the
 * owner to buy credits; the owner is notified. RBAC (billing.requestTopup =
 * Admin/Editor, NOT owner) is enforced in the controller. No DB/network — models
 * + the email settings are monkey-patched (email disabled so notifyOwner is a
 * no-op).
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// billingController constructs a Stripe client at module load — give it a dummy
// key so the require doesn't throw (requestTopup never calls Stripe).
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const billingController = require('../src/controllers/billingController');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const User = require('../src/models/User');
const systemSettingsService = require('../src/services/systemSettingsService');

const real = {
  orgFind: Organization.findById,
  memberFind: OrgMember.findOne,
  userFind: User.findById,
  getSettings: systemSettingsService.getSettings,
};
after(() => {
  Organization.findById = real.orgFind;
  OrgMember.findOne = real.memberFind;
  User.findById = real.userFind;
  systemSettingsService.getSettings = real.getSettings;
});

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const OWNER = 'owner1';
const lean = (v) => ({ lean: async () => v });

let member; // OrgMember.findOne result
beforeEach(() => {
  systemSettingsService.getSettings = () => ({ emailNotificationsEnabled: false }); // notifyOwner no-ops
  Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
  User.findById = () => lean({ _id: 'u1', email: 'req@x.com', profile: { name: 'Req' } });
  member = null;
  OrgMember.findOne = () => lean(member);
});

const reqFor = (userId, body = { orgId: 'org1', amount: '5000 credits', note: 'running low' }) =>
  ({ user: { userId }, body });

describe('requestTopup — RBAC + notify', () => {
  it('Admin member → 200 success', async () => {
    member = { role: 'admin', status: 'active' };
    const r = res();
    await billingController.requestTopup(reqFor('adminUser'), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.success, true);
  });

  it('Editor member → 200 success', async () => {
    member = { role: 'editor', status: 'active' };
    const r = res();
    await billingController.requestTopup(reqFor('editorUser'), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.success, true);
  });

  it('Owner → 400 (owners buy directly, do not request)', async () => {
    const r = res();
    await billingController.requestTopup(reqFor(OWNER), r);
    assert.equal(r.statusCode, 400);
  });

  it('Viewer member → 403', async () => {
    member = { role: 'viewer', status: 'active' };
    const r = res();
    await billingController.requestTopup(reqFor('viewerUser'), r);
    assert.equal(r.statusCode, 403);
  });

  it('Non-member → 403', async () => {
    member = null;
    const r = res();
    await billingController.requestTopup(reqFor('strangerUser'), r);
    assert.equal(r.statusCode, 403);
  });

  it('missing orgId → 400', async () => {
    const r = res();
    await billingController.requestTopup(reqFor('adminUser', { amount: '1' }), r);
    assert.equal(r.statusCode, 400);
  });

  it('org not found → 404', async () => {
    Organization.findById = () => lean(null);
    const r = res();
    await billingController.requestTopup(reqFor('adminUser'), r);
    assert.equal(r.statusCode, 404);
  });
});
