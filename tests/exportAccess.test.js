/**
 * Phase 18B review fix — org-export authorization. resolveOrgWithAccess(…, true)
 * only checks role==='admin', NOT accessScope, so an 'assigned'-scope admin
 * (restricted to specific workspaces) must be blocked from a whole-org export by
 * an explicit guard in exportController.exportOrg — matching listMembers /
 * listAuditLog. Verifies the block + that owner/all-scope admin still proceed.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const exportController = require('../src/controllers/exportController');
const orgMemberController = require('../src/controllers/orgMemberController');
const exportService = require('../src/services/exportService');

const real = {};
let resolveResult, archiveCalledWith;

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {}, sent: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.send = (b) => { res.sent = b; return res; };
  return res;
}

beforeEach(() => {
  real.resolve = orgMemberController.resolveOrgWithAccess;
  real.archive = exportService.exportOrgArchive;
  archiveCalledWith = null;
  // resolveOrgWithAccess returns a result (already passed its own role check).
  orgMemberController.resolveOrgWithAccess = async () => resolveResult;
  exportService.exportOrgArchive = async (orgId) => {
    archiveCalledWith = orgId;
    return { filename: 'org-acme-export.tar.gz', buffer: Buffer.from('gz') };
  };
});
afterEach(() => {
  orgMemberController.resolveOrgWithAccess = real.resolve;
  exportService.exportOrgArchive = real.archive;
});

describe('exportOrg — assigned-scope isolation', () => {
  it('403s an assigned-scope admin (must not export the whole org)', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'admin', accessScope: 'assigned' };
    const res = mockRes();
    await exportController.exportOrg({ user: { userId: 'u1' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(archiveCalledWith, null, 'no archive built for a blocked caller');
  });

  it('lets an OWNER export the whole org', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'owner', accessScope: 'all' };
    const res = mockRes();
    await exportController.exportOrg({ user: { userId: 'u1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(archiveCalledWith, 'org1');
    assert.equal(res.headers['Content-Disposition'], 'attachment; filename="org-acme-export.tar.gz"');
  });

  it('lets an all-scope admin export the whole org', async () => {
    resolveResult = { org: { _id: 'org1' }, callerRole: 'admin', accessScope: 'all' };
    const res = mockRes();
    await exportController.exportOrg({ user: { userId: 'u1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(archiveCalledWith, 'org1');
  });
});
