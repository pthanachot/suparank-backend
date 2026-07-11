/**
 * Phase 19B — END-TO-END impersonation token lifecycle. Unlike the service unit
 * tests, this mints a REAL token via generateImpersonationToken and runs it
 * through the actual authenticateToken → validateAdmin path, proving the load-
 * bearing security chain the design depends on:
 *   (a) the token verifies and req.user carries impersonatedBy + the TARGET id;
 *   (b) it is REJECTED on an admin route (validateAdmin);
 *   (c) once its Session is ended, authenticateToken rejects it everywhere (401);
 *   (d) a NORMAL access token is NOT flagged impersonated (admin unaffected).
 * A typo'd/dropped claim or a broken revocation check would fail here — and would
 * be invisible to the isolated unit tests.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { authenticateToken } = require('../src/middleware/auth');
const validateAdmin = require('../src/middleware/validateAdmin');
const denyImpersonation = require('../src/middleware/denyImpersonation');
const { generateImpersonationToken, generateAccessToken } = require('../src/utils/jwt');
const User = require('../src/models/User');
const Session = require('../src/models/Session');

const TARGET_ID = 'a'.repeat(24); // valid ObjectId hex (authenticateToken casts it)
const ADMIN_ID = 'b'.repeat(24);
const SESSION_ID = 'c'.repeat(24);

const real = {};
let targetUser, sessionDoc;

beforeEach(() => {
  process.env.ACCESS_TOKEN_SECRET = 'e2e-secret';
  process.env.ADMIN_EMAILS = 'owner@acme.co'; // used only by the "normal token" case
  targetUser = {
    _id: TARGET_ID, email: 'owner@acme.co', roles: ['user'], tokenVersion: 5,
    status: 'active', updateLastActive: () => Promise.resolve(),
  };
  sessionDoc = { _id: SESSION_ID, status: 'active' };

  real.userFindById = User.findById;
  real.sessionFindById = Session.findById;
  User.findById = async () => targetUser;
  Session.findById = async () => sessionDoc;
});
afterEach(() => {
  User.findById = real.userFindById;
  Session.findById = real.sessionFindById;
});

// Run authenticateToken and resolve once it calls next() (success) or res (reject).
function runAuth(token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      _s: 200,
      status(c) { this._s = c; return this; },
      json(b) { resolve({ status: this._s, body: b, nexted: false, req }); return this; },
    };
    authenticateToken(req, res, () => resolve({ status: 200, nexted: true, req }));
  });
}

describe('impersonation token — end to end', () => {
  it('(a) verifies and carries impersonatedBy + the TARGET identity', async () => {
    const token = generateImpersonationToken(targetUser, SESSION_ID, ADMIN_ID, 30);
    const r = await runAuth(token);
    assert.equal(r.nexted, true, 'accepted as the owner on a normal route');
    assert.equal(String(r.req.user.userId), TARGET_ID, 'identity is the TARGET');
    assert.equal(r.req.user.impersonatedBy, ADMIN_ID, 'impersonatedBy claim propagated');
  });

  it('(b) is REJECTED on an admin route by validateAdmin (even with an admin email)', async () => {
    const token = generateImpersonationToken(targetUser, SESSION_ID, ADMIN_ID, 30);
    const { req } = await runAuth(token);
    let nexted = false; let status = 200;
    validateAdmin(req, { status: (c) => { status = c; return { json: () => {} }; } }, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(status, 403, 'impersonation token cannot reach admin routes');
  });

  it('(b2) is REJECTED on an account-seizure route by denyImpersonation', async () => {
    const token = generateImpersonationToken(targetUser, SESSION_ID, ADMIN_ID, 30);
    const { req } = await runAuth(token);
    let nexted = false; let status = 200;
    denyImpersonation(req, { status: (c) => { status = c; return { json: () => {} }; } }, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(status, 403);
  });

  it('(c) dies the moment its Session is ended → 401 everywhere', async () => {
    const token = generateImpersonationToken(targetUser, SESSION_ID, ADMIN_ID, 30);
    sessionDoc.status = 'ended'; // simulate stopImpersonation / revoke-all
    const r = await runAuth(token);
    assert.equal(r.nexted, false);
    assert.equal(r.status, 401, 'ended session → token rejected');
  });

  it('(c2) dies if the target bumps tokenVersion (password change / revoke)', async () => {
    const token = generateImpersonationToken(targetUser, SESSION_ID, ADMIN_ID, 30);
    targetUser.tokenVersion = 6; // token carried 5
    const r = await runAuth(token);
    assert.equal(r.status, 401, 'stale tokenVersion → token rejected');
  });

  it('(d) a NORMAL access token is NOT flagged impersonated (admin unaffected)', async () => {
    const token = generateAccessToken(targetUser, SESSION_ID);
    const r = await runAuth(token);
    assert.equal(r.nexted, true);
    assert.equal(r.req.user.impersonatedBy, null, 'no impersonatedBy on a normal token');
    // and validateAdmin lets this admin-email user through
    let nexted = false;
    validateAdmin(r.req, { status: () => ({ json: () => {} }) }, () => { nexted = true; });
    assert.equal(nexted, true, 'real admin still passes');
  });
});
