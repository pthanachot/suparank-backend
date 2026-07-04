const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../src/models/AuditLog');
const auditService = require('../src/services/auditService');

const { ObjectId } = mongoose.Types;

const originals = { create: AuditLog.create };

let state;

beforeEach(() => {
  auditService.clearDedupeCache();
  state = { created: [], createError: null };
  AuditLog.create = async (doc) => {
    if (state.createError) throw state.createError;
    state.created.push(doc);
    return doc;
  };
});

afterEach(() => {
  AuditLog.create = originals.create;
});

const orgId = new ObjectId();
const userId = new ObjectId();

const base = {
  organizationId: orgId,
  userId,
  actorEmail: 'a@b.c',
  action: 'content.create',
  resourceId: 123,
};

describe('auditService.record', () => {
  it('writes an entry with stringified resourceId and derived resource', async () => {
    await auditService.record(base);
    assert.equal(state.created.length, 1);
    assert.equal(state.created[0].resourceId, '123');
    assert.equal(state.created[0].resource, 'content'); // derived from action prefix
  });

  it('explicit resource overrides derivation', async () => {
    await auditService.record({ ...base, resource: 'custom' });
    assert.equal(state.created[0].resource, 'custom');
  });

  it('NEVER throws — a failed write is swallowed and logged', async () => {
    state.createError = new Error('mongo down');
    await assert.doesNotReject(() => auditService.record(base));
    assert.equal(state.created.length, 0);
  });

  it('no-ops without an organizationId (personal workspaces are unaudited)', async () => {
    await auditService.record({ ...base, organizationId: null });
    assert.equal(state.created.length, 0);
  });
});

describe('auditService dedupe (process-local, meta-aware)', () => {
  const dd = { ...base, action: 'content.update', meta: { title: 'Draft X' }, dedupeMinutes: 30 };

  it('writes the first entry, skips an identical repeat inside the window', async () => {
    await auditService.record(dd);
    await auditService.record(dd);
    assert.equal(state.created.length, 1);
  });

  it('a CHANGED meta (rename) inside the window writes anyway', async () => {
    await auditService.record(dd);
    await auditService.record({ ...dd, meta: { title: 'Q3 Launch Post' } });
    assert.equal(state.created.length, 2);
    assert.equal(state.created[1].meta.title, 'Q3 Launch Post');
  });

  it('different resourceId or user is never deduped', async () => {
    await auditService.record(dd);
    await auditService.record({ ...dd, resourceId: 456 });
    await auditService.record({ ...dd, userId: new ObjectId() });
    assert.equal(state.created.length, 3);
  });

  it('no DB read on the dedupe path (exists/findOne never called)', async () => {
    AuditLog.exists = () => {
      throw new Error('dedupe must not query the DB');
    };
    AuditLog.findOne = () => {
      throw new Error('dedupe must not query the DB');
    };
    await auditService.record(dd);
    await auditService.record(dd);
    assert.equal(state.created.length, 1);
    delete AuditLog.exists;
    delete AuditLog.findOne;
  });
});

describe('auditService.fromReq', () => {
  it('pulls org/workspace/actor from the request', async () => {
    const wsId = new ObjectId();
    const req = {
      workspace: { _id: wsId, organizationId: orgId },
      user: { userId, email: 'a@b.c' },
      ip: '1.2.3.4',
    };
    await auditService.fromReq(req, { action: 'content.delete', resourceId: 7 });
    assert.equal(state.created.length, 1);
    const doc = state.created[0];
    assert.equal(doc.workspaceId.toString(), wsId.toString());
    assert.equal(doc.organizationId.toString(), orgId.toString());
    assert.equal(doc.actorEmail, 'a@b.c');
    assert.equal(doc.resource, 'content');
    assert.equal(doc.ip, '1.2.3.4');
  });

  it('no-ops for personal (org-less) workspaces', async () => {
    const req = {
      workspace: { _id: new ObjectId(), organizationId: null },
      user: { userId, email: 'a@b.c' },
    };
    await auditService.fromReq(req, { action: 'content.create' });
    assert.equal(state.created.length, 0);
  });
});
