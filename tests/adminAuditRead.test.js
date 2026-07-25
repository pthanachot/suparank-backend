/**
 * Phase 15 — audit-log read API. AdminAuditLog.find is stubbed as a chainable;
 * no DB. Verifies filter building, keyset pagination, and CSV export.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AdminAuditLog = require('../src/models/AdminAuditLog');
const controller = require('../src/controllers/adminAuditController');

const realFind = AdminAuditLog.find;
let capturedQuery, capturedSort, capturedLimit, mockRows;

beforeEach(() => {
  capturedQuery = null; capturedSort = null; capturedLimit = null; mockRows = [];
  AdminAuditLog.find = (q) => {
    capturedQuery = q;
    return {
      sort: (s) => { capturedSort = s; return {
        limit: (n) => { capturedLimit = n; return { lean: async () => mockRows }; },
      }; },
    };
  };
});
afterEach(() => { AdminAuditLog.find = realFind; });

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
const oid = () => new mongoose.Types.ObjectId();

describe('listAuditLog — filters + keyset pagination', () => {
  it('builds an actor regex + exact action/targetType filters and the feed sort', async () => {
    await controller.listAuditLog({ query: { actor: 'admin@x.co', action: 'admin.user.delete', targetType: 'user', targetId: '5' } }, mockRes());
    assert.ok(capturedQuery.actorEmail.$regex, 'actor is a regex');
    assert.equal(capturedQuery.action, 'admin.user.delete');
    assert.equal(capturedQuery.targetType, 'user');
    assert.equal(capturedQuery.targetId, '5');
    assert.deepEqual(capturedSort, { createdAt: -1, _id: -1 });
  });

  it('escapes regex metacharacters in the actor filter', async () => {
    await controller.listAuditLog({ query: { actor: 'a.*b' } }, mockRes());
    assert.equal(capturedQuery.actorEmail.$regex, 'a\\.\\*b');
  });

  it('builds a createdAt range from start/end date', async () => {
    await controller.listAuditLog({ query: { startDate: '2026-07-01', endDate: '2026-07-31' } }, mockRes());
    assert.ok(capturedQuery.createdAt.$gte instanceof Date);
    assert.ok(capturedQuery.createdAt.$lte instanceof Date);
  });

  it('bounds limit to 200 and fetches limit+1', async () => {
    await controller.listAuditLog({ query: { limit: '9999' } }, mockRes());
    assert.equal(capturedLimit, 201);
  });

  it('returns a nextCursor when there are more rows (and slices to the limit)', async () => {
    const now = new Date();
    mockRows = Array.from({ length: 51 }, () => ({ _id: oid(), createdAt: now, action: 'x' }));
    const res = mockRes();
    await controller.listAuditLog({ query: {} }, res);
    assert.equal(res.body.rows.length, 50);
    assert.ok(res.body.nextCursor, 'nextCursor set when hasMore');
  });

  it('returns null nextCursor when rows fit within the limit', async () => {
    mockRows = [{ _id: oid(), createdAt: new Date(), action: 'x' }];
    const res = mockRes();
    await controller.listAuditLog({ query: {} }, res);
    assert.equal(res.body.nextCursor, null);
  });

  it('applies a keyset $and clause for a valid cursor and ignores a garbage one', async () => {
    const cursor = Buffer.from(JSON.stringify({ c: new Date().toISOString(), i: String(oid()) })).toString('base64');
    await controller.listAuditLog({ query: { cursor } }, mockRes());
    assert.ok(capturedQuery.$and, 'valid cursor adds an $and keyset clause');

    capturedQuery = null;
    await controller.listAuditLog({ query: { cursor: 'not-base64!!' } }, mockRes());
    assert.equal(capturedQuery.$and, undefined, 'garbage cursor is ignored, not applied');
  });
});

describe('exportAuditLog — CSV', () => {
  it('emits a header and neutralizes formula-injection in the actor cell', async () => {
    mockRows = [{
      createdAt: new Date('2026-07-01T00:00:00Z'), actorEmail: '=cmd@x', action: 'admin.user.delete',
      targetType: 'user', targetId: '5', ip: '1.1.1.1', impersonated: false, meta: { x: 1 }, before: null, after: { status: 'suspended' },
    }];
    const res = mockRes();
    await controller.exportAuditLog({ query: {} }, res);
    const csv = res.body;
    assert.ok(csv.startsWith('Date,Actor,Action,TargetType'));
    assert.ok(csv.includes("'=cmd@x"), 'formula-triggering actor is neutralized');
    assert.ok(csv.includes('admin.user.delete'));
    assert.equal(res.headers['Content-Type'], 'text/csv');
  });

  it('fetches CAP+1 rows to detect truncation', async () => {
    await controller.exportAuditLog({ query: {} }, mockRes());
    assert.equal(capturedLimit, controller.EXPORT_CAP + 1);
  });
});
