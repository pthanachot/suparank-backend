/**
 * Phase 7 RBAC — GET /org/credits (view balance) is Editor+ (Owner/Admin/Editor).
 * A viewer or external client must NOT see the org's credit balance/history.
 * Models monkey-patched; no DB.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const creditController = require('../src/controllers/creditController');
const Organization = require('../src/models/Organization');
const OrgMember = require('../src/models/OrgMember');
const Credit = require('../src/models/Credit');
const CreditTransaction = require('../src/models/CreditTransaction');

const real = {
  orgFindOne: Organization.findOne,
  orgFindById: Organization.findById,
  memberFindOne: OrgMember.findOne,
  creditFindOne: Credit.findOne,
  txFind: CreditTransaction.find,
};
after(() => {
  Organization.findOne = real.orgFindOne;
  Organization.findById = real.orgFindById;
  OrgMember.findOne = real.memberFindOne;
  Credit.findOne = real.creditFindOne;
  CreditTransaction.find = real.txFind;
});

const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const OWNER = 'owner1';

let member;
beforeEach(() => {
  member = null;
  Organization.findById = () => lean({ _id: 'org1', ownerId: { equals: (x) => x === OWNER } });
  OrgMember.findOne = () => lean(member);
  Credit.findOne = () => lean({ subscriptionCredits: 100, generalCredits: 50 });
  CreditTransaction.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
});

const reqFor = (userId) => ({ user: { userId }, query: { orgId: 'org1' } });

describe('getCredits — Editor+ view-balance gate', () => {
  it('owner can view', async () => {
    const r = res();
    await creditController.getCredits(reqFor(OWNER), r);
    assert.equal(r.statusCode, 200);
  });

  it('admin member can view', async () => {
    member = { role: 'admin', status: 'active' };
    const r = res();
    await creditController.getCredits(reqFor('adminUser'), r);
    assert.equal(r.statusCode, 200);
  });

  it('editor member can view', async () => {
    member = { role: 'editor', status: 'active' };
    const r = res();
    await creditController.getCredits(reqFor('editorUser'), r);
    assert.equal(r.statusCode, 200);
  });

  it('VIEWER member is denied (403) — no billing info leak', async () => {
    member = { role: 'viewer', status: 'active' };
    const r = res();
    await creditController.getCredits(reqFor('viewerUser'), r);
    assert.equal(r.statusCode, 403);
  });

  it('CLIENT member is denied (403)', async () => {
    member = { role: 'client', status: 'active' };
    const r = res();
    await creditController.getCredits(reqFor('clientUser'), r);
    assert.equal(r.statusCode, 403);
  });

  it('non-member is denied (403)', async () => {
    member = null;
    const r = res();
    await creditController.getCredits(reqFor('strangerUser'), r);
    assert.equal(r.statusCode, 403);
  });
});
