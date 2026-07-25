/**
 * Phase 14 — audit instrumentation. Monkey-patches adminAuditService.fromReq to
 * capture the audit descriptor each controller emits (all controllers share the
 * same module reference), mocks the action's DB deps, and asserts EXACTLY ONE
 * correct row per action. No DB. Representative set across the 7 controllers.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const adminAudit = require('../src/services/adminAuditService');
const adminController = require('../src/controllers/adminController');
const sessionsController = require('../src/controllers/adminSessionsController');
const emailPortalController = require('../src/controllers/emailPortalController');
const platformAdminController = require('../src/controllers/platformAdminController');
const impersonationService = require('../src/services/impersonationService');

const User = require('../src/models/User');
const UserCredit = require('../src/models/UserCredit');
const Credit = require('../src/models/Credit');
const CreditTransaction = require('../src/models/CreditTransaction');
const OrgMember = require('../src/models/OrgMember');
const Session = require('../src/models/Session');
const EmailTemplate = require('../src/models/EmailTemplate');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const realFromReq = adminAudit.fromReq;
const saved = {};
let captured;

beforeEach(() => {
  captured = [];
  adminAudit.fromReq = (req, entry) => { captured.push(entry); };
  saved.userFindOne = User.findOne;
  saved.goc = UserCredit.getOrCreateForUser;
  saved.log = CreditTransaction.logTransaction;
  saved.orgFind = OrgMember.findOne;
  saved.sessUpd = Session.updateMany;
  saved.tplDel = EmailTemplate.findByIdAndDelete;
  saved.imp = impersonationService.startImpersonation;
});
afterEach(() => {
  adminAudit.fromReq = realFromReq;
  User.findOne = saved.userFindOne;
  UserCredit.getOrCreateForUser = saved.goc;
  CreditTransaction.logTransaction = saved.log;
  OrgMember.findOne = saved.orgFind;
  Session.updateMany = saved.sessUpd;
  EmailTemplate.findByIdAndDelete = saved.tplDel;
  impersonationService.startImpersonation = saved.imp;
  delete process.env.IMPERSONATION_ENABLED;
});

describe('adminController audit instrumentation', () => {
  it('manageUserCredits → exactly one admin.user.credits row with a diff', async () => {
    User.findOne = async () => ({ _id: 'u1' });
    UserCredit.getOrCreateForUser = async () => ({ freeCredits: 100, save: async () => {} });
    CreditTransaction.logTransaction = async () => {};
    OrgMember.findOne = () => ({ select: () => ({ lean: async () => null }) });
    await adminController.manageUserCredits({ params: { userId: '5' }, body: { action: 'add', amount: 50 }, user: { email: 'a@b.c', userId: 'admin' } }, mockRes());
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'admin.user.credits');
    assert.equal(captured[0].targetType, 'user');
    assert.equal(captured[0].targetId, '5');
    assert.deepEqual(captured[0].after, { freeCredits: 150 });
  });

  it('updateUser → one admin.user.update row with a status diff', async () => {
    User.findOne = async () => ({ _id: 'u1', userId: 5, email: 'x@y.z', status: 'active', save: async () => {} });
    await adminController.updateUser({ params: { userId: '5' }, body: { status: 'suspended' }, user: { email: 'a@b.c', userId: 'admin' } }, mockRes());
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'admin.user.update');
    assert.deepEqual(captured[0].after, { status: 'suspended' });
  });

  it('bulkManageCredits → one admin.credits.bulk summary row', async () => {
    User.findOne = async (q) => ({ _id: 'u' + q.userId });
    UserCredit.getOrCreateForUser = async () => ({ freeCredits: 100, save: async () => {} });
    CreditTransaction.logTransaction = async () => {};
    await adminController.bulkManageCredits({ body: { targetType: 'user', targets: ['1'], operation: 'add', amount: 10 }, user: { email: 'a@b.c' } }, mockRes());
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'admin.credits.bulk');
    assert.equal(captured[0].targetType, 'user');
    assert.equal(captured[0].meta.succeeded, 1);
  });
});

describe('other controllers audit instrumentation', () => {
  it('revokeAllUserSessions → one admin.session.revoke_all row', async () => {
    User.findOne = async () => ({ _id: { toString: () => 'u1' }, userId: 7, email: 'x@y.z', invalidateTokens: async () => {} });
    Session.updateMany = async () => ({ modifiedCount: 3 });
    await sessionsController.revokeAllUserSessions({ params: { userId: '7' }, user: { email: 'a@b.c', userId: { toString: () => 'admin' } } }, mockRes());
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'admin.session.revoke_all');
    assert.equal(captured[0].targetId, 7);
    assert.equal(captured[0].meta.sessionsEnded, 3);
  });

  it('deleteTemplate → one admin.email.template_delete row', async () => {
    EmailTemplate.findByIdAndDelete = async () => ({ _id: 't1' });
    await emailPortalController.deleteTemplate({ params: { id: 't1' }, user: { email: 'a@b.c' } }, mockRes());
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'admin.email.template_delete');
    assert.equal(captured[0].targetType, 'email');
    assert.equal(captured[0].targetId, 't1');
  });

  it('startImpersonation → one admin.impersonate.start row', async () => {
    process.env.IMPERSONATION_ENABLED = 'true';
    impersonationService.startImpersonation = async () => ({ token: 'tok', sessionId: 's1', target: { email: 'o@x.co' } });
    await platformAdminController.startImpersonation({ params: { orgId: 'org1' }, user: { email: 'a@b.c' }, ip: '1.1.1.1', headers: {} }, mockRes());
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'admin.impersonate.start');
    assert.equal(captured[0].targetType, 'impersonation');
    assert.equal(captured[0].targetId, 's1');
  });
});
