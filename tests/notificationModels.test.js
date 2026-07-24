/**
 * Phase 1 storage primitives for the in-app notification system. No database —
 * schema defaults and enums are checked with validateSync(), and the index
 * declarations are read off schema.indexes(). These pin the two facts that are
 * easy to get wrong and expensive to discover later: the 90-day TTL is a
 * SEPARATE single-field index (a TTL index can't be the compound feed index),
 * and User.notificationsSeenAt is actually declared (Mongoose strict mode
 * silently drops undeclared paths).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Notification = require('../src/models/Notification');
const Announcement = require('../src/models/Announcement');
const User = require('../src/models/User');

const { ObjectId } = mongoose.Types;

describe('Notification model', () => {
  it('applies defaults and accepts a valid row', () => {
    const doc = new Notification({ userId: new ObjectId(), type: 'analysis.ready', title: 'Ready' });
    assert.equal(doc.validateSync(), undefined, 'a valid notification should pass validation');
    assert.equal(doc.body, '');
    assert.equal(doc.link, '');
    assert.equal(doc.readAt, null, 'readAt defaults to null (per-item read state is deferred)');
  });

  it('requires userId, type and title', () => {
    const err = new Notification({}).validateSync();
    assert.ok(err.errors.userId, 'userId is required');
    assert.ok(err.errors.type, 'type is required');
    assert.ok(err.errors.title, 'title is required');
  });

  it('rejects an unknown type', () => {
    const err = new Notification({ userId: new ObjectId(), type: 'not.a.type', title: 'x' }).validateSync();
    assert.ok(err.errors.type, 'type must be one of the enum');
  });

  it('exposes the type enum for the emit service to reuse', () => {
    assert.deepEqual(Notification.NOTIFICATION_TYPES, ['analysis.ready', 'analysis.failed', 'content.locked']);
  });

  it('declares the compound feed index AND a separate single-field TTL index', () => {
    const indexes = Notification.schema.indexes();

    const compound = indexes.find(([keys]) => keys.userId === 1 && keys.createdAt === -1);
    assert.ok(compound, 'feed query needs { userId: 1, createdAt: -1 }');

    const ttl = indexes.find(([, opts]) => opts && opts.expireAfterSeconds !== undefined);
    assert.ok(ttl, 'a TTL index must exist');
    assert.equal(ttl[1].expireAfterSeconds, 90 * 24 * 60 * 60, 'TTL is 90 days');
    assert.deepEqual(ttl[0], { createdAt: 1 }, 'TTL must be single-field on createdAt');
    // The TTL index and the compound index must be two DIFFERENT indexes.
    assert.notEqual(ttl, compound);
  });

  it('has no redundant standalone { userId } index (the compound covers it)', () => {
    const redundant = Notification.schema.indexes().filter(
      ([keys]) => Object.keys(keys).length === 1 && keys.userId === 1,
    );
    assert.equal(redundant.length, 0, 'a bare { userId } index is dead write cost beside the compound');
  });
});

describe('Announcement model', () => {
  it('applies v1 defaults (platform / product / draft / excludes clients)', () => {
    const doc = new Announcement({ title: 'Hello' });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.class, 'product', 'v1 authors only product-class');
    assert.equal(doc.authorScope, 'platform', 'v1 authors only platform-scope');
    assert.equal(doc.authorOrgId, null);
    assert.equal(doc.status, 'draft');
    assert.deepEqual(doc.audience.excludeRoles, ['client'], 'platform news hides from external clients by default');
    assert.deepEqual(doc.audience.tiers, [], 'empty tiers = all tiers');
    assert.equal(doc.publishAt, null);
    assert.equal(doc.expiresAt, null);
  });

  it('requires a title', () => {
    const err = new Announcement({}).validateSync();
    assert.ok(err.errors.title, 'title is required');
  });

  it('rejects unknown class / authorScope / status', () => {
    assert.ok(new Announcement({ title: 't', class: 'spam' }).validateSync().errors.class);
    assert.ok(new Announcement({ title: 't', authorScope: 'galaxy' }).validateSync().errors.authorScope);
    assert.ok(new Announcement({ title: 't', status: 'live' }).validateSync().errors.status);
  });

  it('accepts the deferred-but-modelled org scope (read path already serves it)', () => {
    const doc = new Announcement({ title: 't', authorScope: 'org', authorOrgId: new ObjectId() });
    assert.equal(doc.validateSync(), undefined);
  });

  it('exposes the status enum', () => {
    assert.deepEqual(Announcement.ANNOUNCEMENT_STATUSES, ['draft', 'scheduled', 'published', 'unpublished']);
  });

  it('bounds title and body length', () => {
    assert.ok(new Announcement({ title: 'x'.repeat(201) }).validateSync().errors.title, 'title capped at 200');
    assert.ok(new Announcement({ title: 't', body: 'x'.repeat(5001) }).validateSync().errors.body, 'body capped at 5000');
  });

  it('has the compound feed index and no redundant standalone { status } index', () => {
    const indexes = Announcement.schema.indexes();
    assert.ok(
      indexes.find(([keys]) => keys.status === 1 && keys.publishAt === -1),
      'feed query needs { status: 1, publishAt: -1 }',
    );
    const redundant = indexes.filter(([keys]) => Object.keys(keys).length === 1 && keys.status === 1);
    assert.equal(redundant.length, 0, 'a bare { status } index is dead write cost beside the compound');
  });
});

describe('User.notificationsSeenAt', () => {
  it('is a declared, null-defaulting field (not silently stripped by strict mode)', () => {
    assert.ok(User.schema.path('notificationsSeenAt'), 'the path must be declared');
    const doc = new User({ userId: 1, email: 'a@b.com' });
    assert.equal(doc.notificationsSeenAt, null);
  });

  it('persists an assigned timestamp through the schema', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const doc = new User({ userId: 2, email: 'c@d.com', notificationsSeenAt: when });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.notificationsSeenAt.getTime(), when.getTime());
  });
});
