/**
 * Phase 18C — data-erasure authorization + confirmation (erasureController).
 *
 * Erasure is irreversible, so the controller enforces:
 *   - workspace erase: caller must be workspace owner/admin (not editor/viewer/client)
 *   - org erase: caller must be the org OWNER (an org-wide admin cannot), and a
 *     personal org can never be erased
 *   - both: body { confirm } must exactly match the target's name
 * Verifies each guard blocks, and that a correct request performs the deletion.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const erasureController = require('../src/controllers/erasureController');
const orgMemberController = require('../src/controllers/orgMemberController');
const deletionService = require('../src/services/deletionService');
const auditService = require('../src/services/auditService');

const real = {};
let resolveResult, wsErasedWith, orgErasedWith;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

beforeEach(() => {
  real.resolve = orgMemberController.resolveOrgWithAccess;
  real.delWs = deletionService.deleteWorkspaceData;
  real.delOrg = deletionService.deleteOrgData;
  real.audit = auditService.record;
  wsErasedWith = null; orgErasedWith = null;

  orgMemberController.resolveOrgWithAccess = async () => resolveResult;
  deletionService.deleteWorkspaceData = async (id) => { wsErasedWith = id; return { workspace: 1 }; };
  deletionService.deleteOrgData = async (id) => { orgErasedWith = id; return { organization: 1 }; };
  auditService.record = () => {};
});
afterEach(() => {
  orgMemberController.resolveOrgWithAccess = real.resolve;
  deletionService.deleteWorkspaceData = real.delWs;
  deletionService.deleteOrgData = real.delOrg;
  auditService.record = real.audit;
});

// ── workspace erase ──
describe('eraseWorkspace', () => {
  const reqFor = (role, confirm) => ({
    workspace: { _id: 'ws1', organizationId: 'org1', name: 'Acme Client' },
    workspaceRole: role,
    user: { userId: 'u1', email: 'a@b.co' },
    body: { confirm },
  });

  it('403s an editor', async () => {
    const res = mockRes();
    await erasureController.eraseWorkspace(reqFor('editor', 'Acme Client'), res);
    assert.equal(res.statusCode, 403);
    assert.equal(wsErasedWith, null);
  });

  it('400s when confirm does not match the workspace name', async () => {
    const res = mockRes();
    await erasureController.eraseWorkspace(reqFor('admin', 'wrong'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(wsErasedWith, null);
  });

  it('400s when confirm is missing', async () => {
    const res = mockRes();
    await erasureController.eraseWorkspace(reqFor('owner', ''), res);
    assert.equal(res.statusCode, 400);
    assert.equal(wsErasedWith, null);
  });

  it('erases when an admin confirms with the exact name', async () => {
    const res = mockRes();
    await erasureController.eraseWorkspace(reqFor('admin', 'Acme Client'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(wsErasedWith, 'ws1');
    assert.equal(res.body.erased, true);
  });

  it('reports 500 partial (not success) when a collection failed to delete', async () => {
    deletionService.deleteWorkspaceData = async (id) => { wsErasedWith = id; return { workspace: 1, errors: { content: 'boom' } }; };
    const res = mockRes();
    await erasureController.eraseWorkspace(reqFor('owner', 'Acme Client'), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.erased, false);
    assert.equal(res.body.partial, true);
  });

  it('400s (not 500) on a non-string confirm', async () => {
    const res = mockRes();
    await erasureController.eraseWorkspace(reqFor('owner', true), res); // { confirm: true }
    assert.equal(res.statusCode, 400);
    assert.equal(wsErasedWith, null);
  });
});

// ── org erase ──
describe('eraseOrg', () => {
  const reqWith = (confirm) => ({ user: { userId: 'u1', email: 'a@b.co' }, body: { confirm } });

  it('403s an org-wide admin (owner-only)', async () => {
    resolveResult = { org: { _id: 'org1', name: 'Acme', isPersonal: false }, callerRole: 'admin' };
    const res = mockRes();
    await erasureController.eraseOrg(reqWith('Acme'), res);
    assert.equal(res.statusCode, 403);
    assert.equal(orgErasedWith, null);
  });

  it('400s a personal org', async () => {
    resolveResult = { org: { _id: 'orgP', name: 'Personal', isPersonal: true }, callerRole: 'owner' };
    const res = mockRes();
    await erasureController.eraseOrg(reqWith('Personal'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(orgErasedWith, null);
  });

  it('400s when confirm does not match the org name', async () => {
    resolveResult = { org: { _id: 'org1', name: 'Acme', isPersonal: false }, callerRole: 'owner' };
    const res = mockRes();
    await erasureController.eraseOrg(reqWith('nope'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(orgErasedWith, null);
  });

  it('erases when the OWNER confirms with the exact name', async () => {
    resolveResult = { org: { _id: 'org1', name: 'Acme', isPersonal: false }, callerRole: 'owner' };
    const res = mockRes();
    await erasureController.eraseOrg(reqWith('Acme'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(orgErasedWith, 'org1');
    assert.equal(res.body.erased, true);
  });
});
