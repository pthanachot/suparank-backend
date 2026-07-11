/**
 * Phase 19B — impersonation service (the most security-sensitive code in Phase
 * 19). Verifies every REFUSAL guard (org/owner missing, self, admin target,
 * inactive), that a successful start creates a target-scoped Session with the
 * admin as impersonator + audits it, that a short-lived token is minted, and
 * that stop is idempotent + audited. Models/services monkey-patched; no DB.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/impersonationService');
const Organization = require('../src/models/Organization');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const auditService = require('../src/services/auditService');

function chain(val) {
  const q = {
    select: () => q, sort: () => q, limit: () => q, skip: () => q,
    lean: async () => val,
    then: (resolve, reject) => Promise.resolve(val).then(resolve, reject),
  };
  return q;
}

const real = {};
let orgDoc, targetDoc, createdSessions, audits, foundSession;

const admin = { userId: 'admin1', email: 'boss@x.co' };

beforeEach(() => {
  process.env.ACCESS_TOKEN_SECRET = 'test-secret';
  process.env.ADMIN_EMAILS = 'boss@x.co'; // admin allowlist for isAdminEmail
  delete process.env.IMPERSONATION_TTL_MIN;

  orgDoc = { _id: 'org1', name: 'Acme', ownerId: 'owner1' };
  targetDoc = { _id: 'owner1', email: 'owner@acme.co', roles: ['user'], tokenVersion: 3, status: 'active' };
  createdSessions = []; audits = []; foundSession = null;

  real.orgFindById = Organization.findById;
  real.userFindById = User.findById;
  real.userFind = User.find;
  real.sessionCreate = Session.create;
  real.sessionFindById = Session.findById;
  real.sessionFind = Session.find;
  real.record = auditService.record;

  Organization.findById = () => chain(orgDoc);
  User.findById = () => chain(targetDoc);
  Session.create = async (doc) => { const s = { _id: 'sess1', status: 'active', ...doc }; createdSessions.push(s); return s; };
  Session.findById = async () => foundSession;
  auditService.record = async (entry) => { audits.push(entry); };
});

afterEach(() => {
  Organization.findById = real.orgFindById;
  User.findById = real.userFindById;
  User.find = real.userFind;
  Session.create = real.sessionCreate;
  Session.findById = real.sessionFindById;
  Session.find = real.sessionFind;
  auditService.record = real.record;
});

describe('startImpersonation — refusals', () => {
  it('org_not_found when the org is missing', async () => {
    orgDoc = null;
    assert.deepEqual(await svc.startImpersonation({ adminUser: admin, orgId: 'x' }), { error: 'org_not_found' });
    assert.equal(createdSessions.length, 0);
    assert.equal(audits.length, 0);
  });

  it('no_owner when the org has no ownerId', async () => {
    orgDoc = { _id: 'org1', name: 'Acme', ownerId: null };
    assert.deepEqual(await svc.startImpersonation({ adminUser: admin, orgId: 'org1' }), { error: 'no_owner' });
  });

  it('no_owner when the owner user no longer exists', async () => {
    targetDoc = null;
    assert.deepEqual(await svc.startImpersonation({ adminUser: admin, orgId: 'org1' }), { error: 'no_owner' });
  });

  it('REFUSES to impersonate yourself', async () => {
    targetDoc = { ...targetDoc, _id: 'admin1' };
    assert.deepEqual(await svc.startImpersonation({ adminUser: admin, orgId: 'org1' }), { error: 'self' });
    assert.equal(createdSessions.length, 0);
  });

  it('REFUSES to impersonate a platform admin (no lateral admin capture)', async () => {
    targetDoc = { ...targetDoc, email: 'boss@x.co' }; // an admin-allowlisted email
    assert.deepEqual(await svc.startImpersonation({ adminUser: admin, orgId: 'org1' }), { error: 'target_is_admin' });
    assert.equal(createdSessions.length, 0);
    assert.equal(audits.length, 0, 'no session, no audit on refusal');
  });

  it('REFUSES an inactive target', async () => {
    targetDoc = { ...targetDoc, status: 'suspended' };
    assert.deepEqual(await svc.startImpersonation({ adminUser: admin, orgId: 'org1' }), { error: 'target_inactive' });
  });

  it('REFUSES an org mid-lifecycle (suspending/purging/restoring)', async () => {
    for (const st of ['suspending', 'purging', 'restoring']) {
      orgDoc = { _id: 'org1', name: 'Acme', ownerId: 'owner1', lifecycleStatus: st };
      assert.deepEqual(
        await svc.startImpersonation({ adminUser: admin, orgId: 'org1' }),
        { error: 'org_busy' },
        `refused while ${st}`,
      );
      assert.equal(createdSessions.length, 0);
    }
  });

  it('ALLOWS an active or winding_down org', async () => {
    orgDoc = { _id: 'org1', name: 'Acme', ownerId: 'owner1', lifecycleStatus: 'winding_down' };
    const r = await svc.startImpersonation({ adminUser: admin, orgId: 'org1' });
    assert.equal(typeof r.token, 'string', 'support CAN impersonate a winding-down agency');
  });
});

describe('startImpersonation — success', () => {
  it('creates a target-scoped session with the admin as impersonator, mints a token, and audits', async () => {
    const r = await svc.startImpersonation({ adminUser: admin, orgId: 'org1', ip: '1.2.3.4', userAgent: 'ua' });
    assert.equal(typeof r.token, 'string');
    assert.ok(r.token.length > 20, 'a real JWT was minted');
    assert.equal(r.sessionId, 'sess1');
    assert.equal(r.target.email, 'owner@acme.co');
    assert.equal(r.organization.name, 'Acme');

    assert.equal(createdSessions.length, 1);
    const s = createdSessions[0];
    assert.equal(String(s.userId), 'owner1', 'session belongs to the TARGET');
    assert.equal(String(s.impersonatorId), 'admin1', 'admin recorded as impersonator');
    assert.equal(String(s.organizationId), 'org1');
    assert.ok(s.expiresAt instanceof Date, 'short-lived expiry set');

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'admin.impersonate.start');
    assert.equal(String(audits[0].organizationId), 'org1');
    assert.equal(audits[0].actorEmail, 'boss@x.co', 'the REAL admin is the actor');
    assert.equal(audits[0].meta.targetEmail, 'owner@acme.co');
  });

  it('honours IMPERSONATION_TTL_MIN within clamp; falls back to 30 on garbage', async () => {
    process.env.IMPERSONATION_TTL_MIN = '9999'; // out of clamp → 30
    assert.equal(svc._ttlMinutes(), 30);
    process.env.IMPERSONATION_TTL_MIN = '45';
    assert.equal(svc._ttlMinutes(), 45);
    process.env.IMPERSONATION_TTL_MIN = 'abc';
    assert.equal(svc._ttlMinutes(), 30);
  });
});

describe('stopImpersonation', () => {
  it('not_found when the session is not an impersonation session', async () => {
    foundSession = { _id: 'sess1', impersonatorId: null, status: 'active', end: async () => {} };
    assert.deepEqual(await svc.stopImpersonation({ adminUser: admin, sessionId: 'sess1' }), { error: 'not_found' });
  });

  it('ends an active impersonation session and audits the stop', async () => {
    let ended = false;
    foundSession = {
      _id: 'sess1', userId: 'owner1', impersonatorId: 'admin1', organizationId: 'org1',
      status: 'active', end: async () => { ended = true; foundSession.status = 'ended'; },
    };
    const r = await svc.stopImpersonation({ adminUser: admin, sessionId: 'sess1' });
    assert.deepEqual(r, { ended: true, alreadyEnded: false });
    assert.equal(ended, true);
    assert.equal(audits[0].action, 'admin.impersonate.stop');
    assert.equal(String(audits[0].organizationId), 'org1');
  });

  it('is idempotent — an already-ended session does not re-end but still audits', async () => {
    let endCalls = 0;
    foundSession = {
      _id: 'sess1', userId: 'owner1', impersonatorId: 'admin1', organizationId: 'org1',
      status: 'ended', end: async () => { endCalls++; },
    };
    const r = await svc.stopImpersonation({ adminUser: admin, sessionId: 'sess1' });
    assert.deepEqual(r, { ended: true, alreadyEnded: true });
    assert.equal(endCalls, 0, 'no redundant write');
    assert.equal(audits[0].meta.alreadyEnded, true);
  });
});

describe('listActiveImpersonations', () => {
  it('joins target + impersonator emails onto live sessions', async () => {
    Session.find = () => chain([
      { _id: 'sess1', userId: 'owner1', impersonatorId: 'admin1', organizationId: 'org1', createdAt: new Date('2026-07-01'), expiresAt: null },
    ]);
    User.find = () => chain([
      { _id: 'owner1', email: 'owner@acme.co' },
      { _id: 'admin1', email: 'boss@x.co' },
    ]);
    const list = await svc.listActiveImpersonations();
    assert.equal(list.length, 1);
    assert.equal(list[0].targetEmail, 'owner@acme.co');
    assert.equal(list[0].impersonatorEmail, 'boss@x.co');
  });

  it('returns [] when there are none', async () => {
    Session.find = () => chain([]);
    assert.deepEqual(await svc.listActiveImpersonations(), []);
  });
});
