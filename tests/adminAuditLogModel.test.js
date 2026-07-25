/**
 * Phase 12 — AdminAuditLog model. Schema introspection + validateSync; no DB.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const AdminAuditLog = require('../src/models/AdminAuditLog');

describe('AdminAuditLog model (Phase 12)', () => {
  it('requires action and targetType', () => {
    const err = new AdminAuditLog({}).validateSync();
    assert.ok(err.errors.action, 'action is required');
    assert.ok(err.errors.targetType, 'targetType is required');
  });

  it('accepts any targetType string (free-string, NOT an enum) so a fire-and-forget write is never dropped', () => {
    // A hard enum would make an unforeseen/typo'd type throw a ValidationError
    // that the fire-and-forget writer swallows → the row is silently lost. An
    // audit log must record even a slightly-off type rather than drop it.
    assert.equal(new AdminAuditLog({ action: 'admin.user.delete', targetType: 'user' }).validateSync(), undefined);
    assert.equal(new AdminAuditLog({ action: 'admin.future.thing', targetType: 'something-new' }).validateSync(), undefined);
  });

  it('is NOT org-scoped — no organizationId path (distinct from AuditLog)', () => {
    assert.equal(AdminAuditLog.schema.path('organizationId'), undefined);
  });

  it('records createdAt but not updatedAt (append-only trail)', () => {
    assert.ok(AdminAuditLog.schema.path('createdAt'), 'createdAt present');
    assert.equal(AdminAuditLog.schema.path('updatedAt'), undefined, 'no updatedAt');
  });

  it('declares the feed, actor, and target indexes', () => {
    const keys = AdminAuditLog.schema.indexes().map(([k]) => JSON.stringify(k));
    assert.ok(keys.includes(JSON.stringify({ createdAt: -1, _id: -1 })), 'global feed index');
    assert.ok(keys.includes(JSON.stringify({ actorEmail: 1, createdAt: -1 })), 'by-actor index');
    assert.ok(keys.includes(JSON.stringify({ action: 1, createdAt: -1 })), 'by-action index (Phase 15)');
    assert.ok(keys.includes(JSON.stringify({ targetType: 1, targetId: 1, createdAt: -1 })), 'by-target index');
  });

  it('has a 730-day TTL, single-field on createdAt', () => {
    const ttl = AdminAuditLog.schema.indexes().find(([, opts]) => opts && opts.expireAfterSeconds);
    assert.ok(ttl, 'a TTL index exists');
    assert.equal(ttl[1].expireAfterSeconds, 730 * 24 * 60 * 60);
    assert.deepEqual(ttl[0], { createdAt: 1 }, 'TTL must be single-field on createdAt');
    assert.equal(AdminAuditLog.RETENTION_DAYS, 730);
  });

  it('defaults snapshots to null and impersonated to false', () => {
    const doc = new AdminAuditLog({ action: 'admin.settings.update', targetType: 'system' });
    assert.equal(doc.before, null);
    assert.equal(doc.after, null);
    assert.equal(doc.meta, null);
    assert.equal(doc.impersonated, false);
  });
});
