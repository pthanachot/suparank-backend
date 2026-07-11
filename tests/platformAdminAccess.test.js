/**
 * Phase 19B — platform-admin authorization + impersonation opt-in gate.
 *
 * validateAdmin: an IMPERSONATED session is rejected even if it bears an admin
 * email (a support token can never reach admin routes); a real admin passes; a
 * non-admin is 403'd. Controller: impersonation endpoints 404 unless
 * IMPERSONATION_ENABLED==='true', and refusal codes map to the right HTTP status.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const validateAdmin = require('../src/middleware/validateAdmin');
const controller = require('../src/controllers/platformAdminController');
const impersonationService = require('../src/services/impersonationService');
const adminController = require('../src/controllers/adminController');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

beforeEach(() => { process.env.ADMIN_EMAILS = 'boss@x.co'; });

describe('validateAdmin', () => {
  it('rejects an IMPERSONATED session even with an admin email', () => {
    const res = mockRes();
    let nexted = false;
    validateAdmin({ user: { email: 'boss@x.co', impersonatedBy: 'admin1' } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
  });

  it('passes a real admin', () => {
    const res = mockRes();
    let nexted = false;
    validateAdmin({ user: { email: 'boss@x.co', impersonatedBy: null } }, res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 200);
  });

  it('403s a non-admin email', () => {
    const res = mockRes();
    let nexted = false;
    validateAdmin({ user: { email: 'nobody@x.co' } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nexted, false);
  });
});

describe('userLookup — impersonation cannot light up the admin shell', () => {
  it('403s an impersonated session even if it bears an admin email, without a DB lookup', async () => {
    const res = mockRes();
    // impersonatedBy is set → must reject BEFORE User.findById (so no mock needed).
    await adminController.userLookup(
      { user: { userId: 'u1', email: 'boss@x.co', impersonatedBy: 'admin1' } },
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.valid, false);
  });
});

describe('impersonation opt-in gate + error mapping', () => {
  const real = {};
  beforeEach(() => {
    real.start = impersonationService.startImpersonation;
    real.stop = impersonationService.stopImpersonation;
    real.list = impersonationService.listActiveImpersonations;
  });
  afterEach(() => {
    impersonationService.startImpersonation = real.start;
    impersonationService.stopImpersonation = real.stop;
    impersonationService.listActiveImpersonations = real.list;
    delete process.env.IMPERSONATION_ENABLED;
  });

  const req = (over = {}) => ({ user: { userId: 'a', email: 'boss@x.co' }, params: {}, query: {}, headers: {}, ip: '1.1.1.1', ...over });

  it('404s start when IMPERSONATION_ENABLED is not "true"', async () => {
    delete process.env.IMPERSONATION_ENABLED;
    let called = false;
    impersonationService.startImpersonation = async () => { called = true; return {}; };
    const res = mockRes();
    await controller.startImpersonation(req({ params: { orgId: 'org1' } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(called, false, 'service not even reached while dark');
  });

  it('maps target_is_admin → 403 when enabled', async () => {
    process.env.IMPERSONATION_ENABLED = 'true';
    impersonationService.startImpersonation = async () => ({ error: 'target_is_admin' });
    const res = mockRes();
    await controller.startImpersonation(req({ params: { orgId: 'org1' } }), res);
    assert.equal(res.statusCode, 403);
  });

  it('maps org_not_found → 404 when enabled', async () => {
    process.env.IMPERSONATION_ENABLED = 'true';
    impersonationService.startImpersonation = async () => ({ error: 'org_not_found' });
    const res = mockRes();
    await controller.startImpersonation(req({ params: { orgId: 'nope' } }), res);
    assert.equal(res.statusCode, 404);
  });

  it('returns the token on success when enabled', async () => {
    process.env.IMPERSONATION_ENABLED = 'true';
    impersonationService.startImpersonation = async () => ({ token: 'tok', sessionId: 's1', target: { email: 'o@x.co' } });
    const res = mockRes();
    await controller.startImpersonation(req({ params: { orgId: 'org1' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.token, 'tok');
  });

  it('404s stop + list while dark', async () => {
    delete process.env.IMPERSONATION_ENABLED;
    const res1 = mockRes(); await controller.stopImpersonation(req({ params: { sessionId: 's1' } }), res1);
    const res2 = mockRes(); await controller.listImpersonations(req(), res2);
    assert.equal(res1.statusCode, 404);
    assert.equal(res2.statusCode, 404);
  });
});
