/**
 * Phase 19 — agency console authorization (agencyConsoleController).
 *
 * The roster/overview expose EVERY client's plan + MRR + billing status, so an
 * 'assigned'-scope member (an agency client, or restricted staff) must be 403'd
 * — only the owner or an org-wide admin may read it. Also: an invalid ?period
 * 400s; owner/all-admin proceed.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const controller = require('../src/controllers/agencyConsoleController');
const orgMemberController = require('../src/controllers/orgMemberController');
const agencyConsoleService = require('../src/services/agencyConsoleService');

const real = {};
let resolveResult, rosterCalledWith;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const reqWith = (query = {}) => ({ params: { orgId: 'org1' }, query, user: { userId: 'u1' } });

beforeEach(() => {
  real.resolve = orgMemberController.resolveOrgWithAccess;
  real.roster = agencyConsoleService.getClientRoster;
  rosterCalledWith = null;
  orgMemberController.resolveOrgWithAccess = async () => resolveResult;
  agencyConsoleService.getClientRoster = async (orgId, period) => { rosterCalledWith = { orgId, period }; return { period, summary: {}, clients: [] }; };
});
afterEach(() => {
  orgMemberController.resolveOrgWithAccess = real.resolve;
  agencyConsoleService.getClientRoster = real.roster;
});

describe('getRoster — access', () => {
  it('403s an assigned-scope member', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'admin', accessScope: 'assigned' };
    const res = mockRes();
    await controller.getRoster(reqWith(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(rosterCalledWith, null);
  });

  it('lets an OWNER read the roster', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'owner', accessScope: undefined };
    const res = mockRes();
    await controller.getRoster(reqWith(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(rosterCalledWith.orgId, 'org1');
  });

  it('lets an all-scope admin read the roster', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'admin', accessScope: 'all' };
    const res = mockRes();
    await controller.getRoster(reqWith(), res);
    assert.equal(res.statusCode, 200);
  });

  it('400s an invalid ?period', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'owner' };
    const res = mockRes();
    await controller.getRoster(reqWith({ period: '2026/07' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(rosterCalledWith, null);
  });

  it('passes a valid ?period through', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'owner' };
    const res = mockRes();
    await controller.getRoster(reqWith({ period: '2026-06' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(rosterCalledWith.period, '2026-06');
  });
});
