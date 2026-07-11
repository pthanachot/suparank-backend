const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { rejectIfLocked } = require('../src/middleware/lockGuard');

// B4: rejectIfLocked guards non-DELETE writes on locked resources. It is used
// for Content (locked only) and for Workspace via the :workspaceId CRUD routes
// (updateWorkspace / setActiveWorkspace), where it must ALSO enforce the
// clientLocked billing suspension — consistently with resolveWorkspaceWithRole.

// Model whose findById(id).select(...).lean() resolves to `doc`.
function fakeModel(doc) {
  return { findById: () => ({ select: () => ({ lean: async () => doc }) }) };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function invoke(mw, { method = 'PUT', params = { workspaceId: 'w1' } } = {}) {
  const req = { method, params };
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe('rejectIfLocked — Workspace (:workspaceId routes)', () => {
  it('403s a downgrade-locked workspace with RESOURCE_LOCKED', async () => {
    const mw = rejectIfLocked(fakeModel({ locked: true }), 'workspaceId');
    const { res, nextCalled } = await invoke(mw);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'RESOURCE_LOCKED');
    assert.equal(res.body.locked, true);
    assert.equal(nextCalled, false);
  });

  it('403s a clientLocked (billing) workspace with WORKSPACE_CLIENT_LOCKED', async () => {
    const mw = rejectIfLocked(fakeModel({ locked: false, clientLocked: true }), 'workspaceId');
    const { res, nextCalled } = await invoke(mw);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'WORKSPACE_CLIENT_LOCKED');
    assert.equal(res.body.locked, true);
    assert.equal(nextCalled, false);
  });

  it('downgrade lock wins the message when BOTH flags are set', async () => {
    const mw = rejectIfLocked(fakeModel({ locked: true, clientLocked: true }), 'workspaceId');
    const { res } = await invoke(mw);
    assert.equal(res.body.code, 'RESOURCE_LOCKED');
  });

  it('passes through an unlocked workspace', async () => {
    const mw = rejectIfLocked(fakeModel({ locked: false, clientLocked: false }), 'workspaceId');
    const { nextCalled } = await invoke(mw);
    assert.equal(nextCalled, true);
  });

  it('DELETE is always exempt (never checks the lock)', async () => {
    const mw = rejectIfLocked(fakeModel({ locked: true, clientLocked: true }), 'workspaceId');
    const { nextCalled } = await invoke(mw, { method: 'DELETE' });
    assert.equal(nextCalled, true);
  });

  it('fails OPEN if the lookup throws (never blocks on a guard error)', async () => {
    const throwing = { findById: () => ({ select: () => ({ lean: async () => { throw new Error('db down'); } }) }) };
    const mw = rejectIfLocked(throwing, 'workspaceId');
    const { nextCalled } = await invoke(mw);
    assert.equal(nextCalled, true);
  });
});

describe('rejectIfLocked — Content (custom resolver, locked only)', () => {
  it('403s locked content via a custom idResolver', async () => {
    const mw = rejectIfLocked(null, async () => ({ locked: true }));
    const { res, nextCalled } = await invoke(mw, { params: {} });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'RESOURCE_LOCKED');
    assert.equal(nextCalled, false);
  });

  it('passes through unlocked content (no clientLocked field → undefined, harmless)', async () => {
    const mw = rejectIfLocked(null, async () => ({ locked: false }));
    const { nextCalled } = await invoke(mw, { params: {} });
    assert.equal(nextCalled, true);
  });
});
