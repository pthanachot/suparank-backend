/**
 * Phase 2 — the emit service and the analysis-outcome wiring. No database.
 *
 * notificationService.emit is stubbed to record its calls; Workspace.findById is
 * stubbed for the link lookup. These pin the two things that are easy to get
 * wrong: the emit CONTRACT (never throws, skips unaddressable, truncates), and
 * notifyAnalysisOutcome's recipient rule (actor from opts.bill, else the content
 * creator) plus its guards.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Notification = require('../src/models/Notification');
const notificationService = require('../src/services/notificationService');
const Workspace = require('../src/models/Workspace');
const analysisController = require('../src/controllers/analysisController');

const { ObjectId } = mongoose.Types;

// ─── emit() contract ───────────────────────────────────────────
describe('notificationService.emit', () => {
  const realCreate = Notification.create;
  afterEach(() => { Notification.create = realCreate; });

  it('creates a row with the given fields on the happy path', async () => {
    let created = null;
    Notification.create = async (doc) => { created = doc; return doc; };
    const uid = new ObjectId();
    await notificationService.emit({ userId: uid, type: 'analysis.ready', title: 'Hi', body: 'B', link: '/x' });
    assert.deepEqual(created, { userId: uid, type: 'analysis.ready', title: 'Hi', body: 'B', link: '/x' });
  });

  it('skips (no create) when userId, type, or title is missing', async () => {
    let called = false;
    Notification.create = async () => { called = true; };
    assert.equal(await notificationService.emit({ type: 'analysis.ready', title: 'x' }), null);
    assert.equal(await notificationService.emit({ userId: new ObjectId(), title: 'x' }), null);
    assert.equal(await notificationService.emit({ userId: new ObjectId(), type: 'analysis.ready' }), null);
    assert.equal(await notificationService.emit(), null);
    assert.equal(called, false, 'must not touch the DB when it cannot address the notification');
  });

  it('truncates an over-long title and body', async () => {
    let created = null;
    Notification.create = async (doc) => { created = doc; return doc; };
    await notificationService.emit({
      userId: new ObjectId(), type: 'analysis.ready',
      title: 'T'.repeat(500), body: 'B'.repeat(1000),
    });
    assert.equal(created.title.length, 200);
    assert.equal(created.body.length, 500);
    assert.ok(created.title.endsWith('…'));
  });

  it('NEVER throws or rejects when the DB write fails', async () => {
    Notification.create = async () => { throw new Error('mongo down'); };
    const res = await notificationService.emit({ userId: new ObjectId(), type: 'analysis.ready', title: 'x' });
    assert.equal(res, null, 'a failed write is swallowed and returns null, never propagates');
  });
});

// ─── notifyAnalysisOutcome recipient + guards ──────────────────
describe('analysisController.notifyAnalysisOutcome', () => {
  const realEmit = notificationService.emit;
  const realWsFind = Workspace.findById;
  let emitted;

  beforeEach(() => {
    emitted = [];
    notificationService.emit = async (payload) => { emitted.push(payload); return payload; };
    Workspace.findById = () => ({ select: () => ({ lean: async () => ({ workspaceNumber: 77 }) }) });
  });
  afterEach(() => {
    notificationService.emit = realEmit;
    Workspace.findById = realWsFind;
  });

  const creator = new ObjectId();
  const actor = new ObjectId();
  const content = { userId: creator, workspaceId: new ObjectId(), contentNumber: 42, title: 'My Post' };

  it('ready → emits analysis.ready to the creator, linking the editor', async () => {
    await analysisController.notifyAnalysisOutcome(content, {}, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, 'analysis.ready');
    assert.equal(String(emitted[0].userId), String(creator));
    assert.equal(emitted[0].link, '/workspace/77/drafts/42');
    assert.match(emitted[0].title, /ready/i);
  });

  it('failed → emits analysis.failed', async () => {
    await analysisController.notifyAnalysisOutcome(content, {}, false);
    assert.equal(emitted[0].type, 'analysis.failed');
    assert.equal(emitted[0].link, '/workspace/77/drafts/42');
  });

  it('prefers the actor from opts.bill over the creator', async () => {
    await analysisController.notifyAnalysisOutcome(content, { bill: { userId: actor } }, true);
    assert.equal(String(emitted[0].userId), String(actor));
  });

  it('no-ops when content is undefined (outer-catch case, findById threw)', async () => {
    await analysisController.notifyAnalysisOutcome(undefined, {}, false);
    assert.equal(emitted.length, 0);
  });

  it('no-ops when there is no addressable recipient', async () => {
    await analysisController.notifyAnalysisOutcome({ workspaceId: new ObjectId(), contentNumber: 1 }, {}, true);
    assert.equal(emitted.length, 0);
  });

  it('no-ops (does not emit) when the workspace has no number', async () => {
    Workspace.findById = () => ({ select: () => ({ lean: async () => null }) });
    await analysisController.notifyAnalysisOutcome(content, {}, true);
    assert.equal(emitted.length, 0);
  });

  it('swallows a Workspace lookup failure without throwing', async () => {
    Workspace.findById = () => { throw new Error('db blip'); };
    await assert.doesNotReject(() => analysisController.notifyAnalysisOutcome(content, {}, true));
    assert.equal(emitted.length, 0);
  });
});

// ─── content-locked: the idempotency-critical count ────────────
// lockPaidCreatedResources must report how many CONTENT docs it NEWLY locked, so
// applyLocksForOrg notifies the owner on a real downgrade but stays silent on an
// idempotent webhook re-run. Everything but the Content updateMany is stubbed to
// a no-op; only Content's modifiedCount should reach the return value.
describe('downgradeService.lockPaidCreatedResources — newly-locked content count', () => {
  const Content = require('../src/models/Content');
  const BrandVoice = require('../src/models/BrandVoice');
  const Avatar = require('../src/models/Avatar');
  const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');
  const AiTracker = require('../src/models/AiTracker');
  const tierService = require('../src/services/tierService');
  const downgradeService = require('../src/services/downgradeService');

  const saved = {};
  beforeEach(() => {
    saved.wsFind = Workspace.find;
    saved.trackerFind = AiTracker.find;
    saved.tierGet = tierService.getTierConfig;
    saved.bvUpd = BrandVoice.updateMany;
    saved.avUpd = Avatar.updateMany;
    saved.kwUpd = KeywordResearchHistory.updateMany;

    Workspace.find = () => ({ distinct: async () => [new ObjectId()] });
    AiTracker.find = () => ({ distinct: async () => [] });
    tierService.getTierConfig = async () => ({ maxAiTrackerPromptsPerMonitor: null });
    BrandVoice.updateMany = async () => ({ modifiedCount: 0 });
    Avatar.updateMany = async () => ({ modifiedCount: 0 });
    KeywordResearchHistory.updateMany = async () => ({ modifiedCount: 0 });
  });
  afterEach(() => {
    Workspace.find = saved.wsFind;
    AiTracker.find = saved.trackerFind;
    tierService.getTierConfig = saved.tierGet;
    BrandVoice.updateMany = saved.bvUpd;
    Avatar.updateMany = saved.avUpd;
    KeywordResearchHistory.updateMany = saved.kwUpd;
    Content.updateMany = saved.contentUpd;
  });

  it('returns the Content modifiedCount on a real downgrade', async () => {
    saved.contentUpd = Content.updateMany;
    Content.updateMany = async () => ({ modifiedCount: 4 });
    const res = await downgradeService.lockPaidCreatedResources('org1');
    assert.equal(res.contentLockedCount, 4);
  });

  it('returns 0 on an idempotent re-run (nothing newly locked → no re-notify)', async () => {
    saved.contentUpd = Content.updateMany;
    Content.updateMany = async () => ({ modifiedCount: 0 });
    const res = await downgradeService.lockPaidCreatedResources('org1');
    assert.equal(res.contentLockedCount, 0);
  });
});
