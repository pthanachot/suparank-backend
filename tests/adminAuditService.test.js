/**
 * Phase 13 — adminAuditService. AdminAuditLog.create is stubbed; no DB.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const AdminAuditLog = require('../src/models/AdminAuditLog');
const svc = require('../src/services/adminAuditService');

const realCreate = AdminAuditLog.create;
let created;
let createError;

beforeEach(() => {
  created = [];
  createError = null;
  AdminAuditLog.create = async (doc) => {
    if (createError) throw createError;
    created.push(doc);
    return doc;
  };
});
afterEach(() => { AdminAuditLog.create = realCreate; });

describe('adminAuditService.record', () => {
  it('writes a row with the given fields, stringifying targetId', async () => {
    await svc.record({
      actorUserId: 'u1', actorEmail: 'a@x.co',
      action: 'admin.user.credits', targetType: 'user', targetId: 700003,
      after: { freeCredits: 150 },
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].action, 'admin.user.credits');
    assert.equal(created[0].targetType, 'user');
    assert.strictEqual(created[0].targetId, '700003'); // numeric → string
    assert.deepEqual(created[0].after, { freeCredits: 150 });
  });

  it('NEVER throws (nor rejects) when the DB write fails — fire-and-forget', async () => {
    createError = new Error('db down');
    // If record rejected, this await would throw and fail the test.
    await svc.record({ action: 'admin.user.delete', targetType: 'user', targetId: '1' });
    assert.equal(created.length, 0);
  });

  it('skips silently when the required action or targetType is missing', async () => {
    await svc.record({ targetType: 'user' });   // no action
    await svc.record({ action: 'admin.x' });     // no targetType
    assert.equal(created.length, 0);
  });
});

describe('adminAuditService.fromReq', () => {
  it('pulls actor + ip from req.user; impersonated=false for a normal session', async () => {
    await svc.fromReq({ user: { userId: 'u1', email: 'admin@x.co' }, ip: '1.2.3.4' },
      { action: 'admin.settings.update', targetType: 'system' });
    assert.equal(created[0].actorUserId, 'u1');
    assert.equal(created[0].actorEmail, 'admin@x.co');
    assert.equal(created[0].ip, '1.2.3.4');
    assert.equal(created[0].impersonated, false);
  });

  it('flags impersonated=true when the token bears impersonatedBy', async () => {
    await svc.fromReq({ user: { userId: 'u1', email: 'admin@x.co', impersonatedBy: 'admin0' }, ip: '9.9.9.9' },
      { action: 'admin.user.delete', targetType: 'user', targetId: '5' });
    assert.equal(created[0].impersonated, true);
  });
});

describe('adminAuditService.withDiff', () => {
  it('keeps only the changed keys', () => {
    assert.deepEqual(
      svc.withDiff({ status: 'active', name: 'A' }, { status: 'suspended', name: 'A' }),
      { before: { status: 'active' }, after: { status: 'suspended' } }
    );
  });

  it('returns nulls when nothing changed', () => {
    assert.deepEqual(svc.withDiff({ a: 1 }, { a: 1 }), { before: null, after: null });
  });

  it('handles scalar snapshots', () => {
    assert.deepEqual(svc.withDiff('free', 'pro'), { before: 'free', after: 'pro' });
    assert.deepEqual(svc.withDiff(5, 5), { before: null, after: null });
  });

  it('treats a null before as a creation', () => {
    assert.deepEqual(svc.withDiff(null, { x: 1 }), { before: null, after: { x: 1 } });
  });

  it('captures a removed key as value→null', () => {
    assert.deepEqual(svc.withDiff({ a: 1, b: 2 }, { a: 1 }), { before: { b: 2 }, after: { b: null } });
  });

  it('exposes the ACTIONS taxonomy', () => {
    assert.equal(svc.ACTIONS.USER_DELETE, 'admin.user.delete');
    assert.equal(svc.ACTIONS.IMPERSONATE_START, 'admin.impersonate.start');
  });
});
