'use strict';

// Threads Phase 5: retention + lifecycle — the archived-thread prune cron,
// the Content-delete cascade, and the export bundle inclusion.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const threadService = require('../src/services/threadService');
const flagService = require('../src/services/flagService');
const FeatureFlag = require('../src/models/FeatureFlag');
const AiThread = require('../src/models/AiThread');
const AiThreadMessage = require('../src/models/AiThreadMessage');
const Content = require('../src/models/Content');

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

// ─── prune cron ──────────────────────────────────────────────

test('pruneArchivedThreads: children-first, retention-windowed, run-capped', async () => {
  const restore = stubFlag(true);
  const savedFind = AiThread.find;
  const savedDelT = AiThread.deleteMany;
  const savedDelM = AiThreadMessage.deleteMany;
  let seenFilter = null;
  let seenLimit = null;
  let seenSort = null;
  const order = [];
  AiThread.find = (filter) => {
    seenFilter = filter;
    return {
      sort: (s) => { seenSort = s; return { limit: (n) => { seenLimit = n; return { lean: async () => [{ _id: 'T1' }, { _id: 'T2' }] }; } }; },
    };
  };
  AiThreadMessage.deleteMany = async (f) => { order.push('messages'); assert.deepStrictEqual(f.threadId.$in, ['T1', 'T2']); return { deletedCount: 7 }; };
  AiThread.deleteMany = async (f) => { order.push('threads'); assert.deepStrictEqual(f._id.$in, ['T1', 'T2']); return { deletedCount: 2 }; };
  try {
    const r = await threadService.pruneArchivedThreads();
    assert.deepStrictEqual(r, { due: 2, threads: 2, messages: 7 });
    assert.deepStrictEqual(order, ['messages', 'threads'], 'children BEFORE parents — a TTL index could never guarantee this');
    assert.strictEqual(seenFilter.status, 'archived');
    assert.ok(seenFilter.archivedAt.$lt instanceof Date, 'retention cutoff windowed');
    assert.deepStrictEqual(seenFilter.archivedAt.$ne, null, 'null archivedAt (legacy) never matches');
    assert.deepStrictEqual(seenSort, { archivedAt: 1 }, 'oldest-first — a capped backlog must drain FIFO (P5 review)');
    assert.strictEqual(seenLimit, 500, 'per-run cap — backlogs drain over nights');
  } finally {
    AiThread.find = savedFind;
    AiThread.deleteMany = savedDelT;
    AiThreadMessage.deleteMany = savedDelM;
    restore();
  }
});

test('pruneArchivedThreads: flag off → zero-count no-op (dark-gated like the 18C purge)', async () => {
  const restore = stubFlag(false);
  const saved = AiThread.find;
  AiThread.find = () => { throw new Error('must not query when dark'); };
  try {
    assert.deepStrictEqual(await threadService.pruneArchivedThreads(), { due: 0, threads: 0, messages: 0 });
  } finally { AiThread.find = saved; restore(); }
});

// ─── content-delete cascade ──────────────────────────────────

test('Content delete hooks are registered on all four delete paths', async () => {
  const hooks = Content.schema.s.hooks;
  // mongoose internals: _pres map holds registered pre-hooks by op name.
  const pres = hooks._pres;
  for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
    assert.ok((pres.get(op) || []).length > 0, `pre-${op} hook registered`);
  }
});

// P5 review CAVEAT-4: the registration test above passed even with the thread
// cascade deleted (archivePlansForContent already registered those hooks).
// These exercise the cascade helpers' BEHAVIOR via the test-only statics.
test('cascadeContentDelete deletes thread children BEFORE parents', async () => {
  const Plan = require('../src/models/Plan');
  const saved = { pf: Plan.updateMany, tf: AiThread.find, tm: AiThreadMessage.deleteMany, td: AiThread.deleteMany };
  const order = [];
  Plan.updateMany = async () => { order.push('plans'); return { modifiedCount: 0 }; };
  AiThread.find = (f) => {
    assert.strictEqual(f.contentId, 'c1');
    return { select: () => ({ lean: async () => [{ _id: 'T1' }, { _id: 'T2' }] }) };
  };
  AiThreadMessage.deleteMany = async (f) => {
    order.push('messages');
    assert.deepStrictEqual(f.threadId.$in, ['T1', 'T2'], 'messages keyed by the found thread ids');
    return { deletedCount: 4 };
  };
  AiThread.deleteMany = async (f) => {
    order.push('threads');
    assert.deepStrictEqual(f._id.$in, ['T1', 'T2']);
    return { deletedCount: 2 };
  };
  try {
    await Content._cascadeContentDelete('c1');
    assert.deepStrictEqual(order, ['plans', 'messages', 'threads'], 'children-first: a crash between the two deletes must never orphan messages');
  } finally {
    Plan.updateMany = saved.pf; AiThread.find = saved.tf;
    AiThreadMessage.deleteMany = saved.tm; AiThread.deleteMany = saved.td;
  }
});

test('deleteMany hook batches the cascade: one query per collection, children-first, no-op on empty', async () => {
  const Plan = require('../src/models/Plan');
  const saved = { pf: Plan.updateMany, tf: AiThread.find, tm: AiThreadMessage.deleteMany, td: AiThread.deleteMany };
  const calls = [];
  Plan.updateMany = async (f) => {
    calls.push('plans');
    assert.deepStrictEqual(f.contentId.$in, ['c1', 'c2'], 'plans archived in ONE bulk statement');
    return { modifiedCount: 0 };
  };
  AiThread.find = (f) => {
    calls.push('find');
    assert.deepStrictEqual(f.contentId.$in, ['c1', 'c2'], 'threads found in ONE bulk statement');
    return { select: () => ({ lean: async () => [{ _id: 'T1' }] }) };
  };
  AiThreadMessage.deleteMany = async (f) => {
    calls.push('messages');
    assert.deepStrictEqual(f.threadId.$in, ['T1']);
    return { deletedCount: 1 };
  };
  AiThread.deleteMany = async () => { calls.push('threads'); return { deletedCount: 1 }; };
  try {
    await Content._cascadeContentDeleteBulk(['c1', 'c2']);
    assert.deepStrictEqual(calls, ['plans', 'find', 'messages', 'threads'], 'exactly 4 statements for N contents, children-first');
    calls.length = 0;
    await Content._cascadeContentDeleteBulk([]);
    assert.deepStrictEqual(calls, [], 'empty id list touches nothing');
  } finally {
    Plan.updateMany = saved.pf; AiThread.find = saved.tf;
    AiThreadMessage.deleteMany = saved.tm; AiThread.deleteMany = saved.td;
  }
});

// ─── export inclusion ────────────────────────────────────────

test('serializeWorkspace bundles non-empty conversations under conversations/<content>/', async () => {
  const exportService = require('../src/services/exportService');
  const Workspace = require('../src/models/Workspace');
  const AiTracker = require('../src/models/AiTracker');
  const ReportSnapshot = require('../src/models/ReportSnapshot');
  const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');
  const BrandVoice = require('../src/models/BrandVoice');

  const saved = {
    ws: Workspace.findById, c: Content.find, t: AiThread.find, m: AiThreadMessage.find,
    tr: AiTracker.find, rs: ReportSnapshot.find, kw: KeywordResearchHistory.find, bv: BrandVoice.find,
  };
  const lean = (val) => ({ select() { return this; }, sort() { return this; }, lean: async () => val });
  Workspace.findById = () => lean({ _id: 'w1', workspaceNumber: 42, name: 'WS' });
  // Filter-aware: the service now queries unlocked bodies and locked ids separately.
  Content.find = (f) => lean(f && f.locked === true ? [] : [{ _id: 'c1', contentNumber: 7, title: 'My Post', blocks: [] }]);
  AiThread.find = () => lean([
    { _id: 'T-full', contentId: 'c1', title: 'Set the mascot', status: 'archived', messageCount: 2 },
    { _id: 'T-empty', contentId: 'c1', title: '', status: 'active', messageCount: 0 },
  ]);
  AiThreadMessage.find = () => lean([
    { seq: 0, kind: 'user', text: 'the prompt' },
    { seq: 1, kind: 'assistant', text: 'the reply' },
  ]);
  AiTracker.find = () => lean([]);
  ReportSnapshot.find = () => lean([]);
  KeywordResearchHistory.find = () => lean([]);
  BrandVoice.find = () => lean([]);
  try {
    const entries = await exportService.serializeWorkspace('w1');
    const conv = entries.find((e) => e.name.startsWith('conversations/'));
    assert.ok(conv, 'conversation entry present (GDPR portability — prompts are personal data)');
    assert.match(conv.name, /^conversations\/7-my-post\/T-full\.json$/);
    const parsed = JSON.parse(conv.data);
    assert.strictEqual(parsed.messages.length, 2);
    assert.strictEqual(entries.filter((e) => e.name.startsWith('conversations/')).length, 1, 'empty threads not exported');
    const manifest = JSON.parse(entries.find((e) => e.name.endsWith('manifest.json')).data);
    assert.strictEqual(manifest.counts.conversations, 1);
  } finally {
    Workspace.findById = saved.ws; Content.find = saved.c; AiThread.find = saved.t; AiThreadMessage.find = saved.m;
    AiTracker.find = saved.tr; ReportSnapshot.find = saved.rs; KeywordResearchHistory.find = saved.kw; BrandVoice.find = saved.bv;
  }
});

// P5 review CAVEAT-3: locked (paywalled) content withholds its BODY, but the
// conversation is the user's own typed prompts — GDPR Art. 20 data that must
// still export. The tar is the system's only export path (erasureController
// only deletes), so silently dropping these was a real portability hole.
test('serializeWorkspace exports LOCKED contents\' conversations (body excluded, dir suffixed, manifest marked)', async () => {
  const exportService = require('../src/services/exportService');
  const Workspace = require('../src/models/Workspace');
  const AiTracker = require('../src/models/AiTracker');
  const ReportSnapshot = require('../src/models/ReportSnapshot');
  const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');
  const BrandVoice = require('../src/models/BrandVoice');

  const saved = {
    ws: Workspace.findById, c: Content.find, t: AiThread.find, m: AiThreadMessage.find,
    tr: AiTracker.find, rs: ReportSnapshot.find, kw: KeywordResearchHistory.find, bv: BrandVoice.find,
  };
  const lean = (val) => ({ select() { return this; }, sort() { return this; }, lean: async () => val });
  Workspace.findById = () => lean({ _id: 'w1', workspaceNumber: 42, name: 'WS' });
  Content.find = (f) => lean(
    f && f.locked === true
      ? [{ _id: 'c-paid', contentNumber: 9, title: 'Paid Post', slug: 'paid-post' }]
      : [{ _id: 'c1', contentNumber: 7, title: 'My Post', blocks: [] }],
  );
  AiThread.find = (f) => {
    assert.ok(f.contentId.$in.map(String).includes('c-paid'), 'thread query covers locked content ids');
    return lean([{ _id: 'T-paid', contentId: 'c-paid', title: 'Draft it', status: 'archived', messageCount: 1 }]);
  };
  AiThreadMessage.find = () => lean([{ seq: 0, kind: 'user', text: 'my prompt' }]);
  AiTracker.find = () => lean([]);
  ReportSnapshot.find = () => lean([]);
  KeywordResearchHistory.find = () => lean([]);
  BrandVoice.find = () => lean([]);
  try {
    const entries = await exportService.serializeWorkspace('w1');
    const conv = entries.find((e) => e.name.startsWith('conversations/'));
    assert.ok(conv, 'locked-content conversation exported');
    assert.match(conv.name, /^conversations\/9-paid-post-locked\/T-paid\.json$/, 'dir carries the -locked suffix');
    assert.ok(!entries.some((e) => e.name.startsWith('content/9-')), 'the locked BODY stays excluded');
    const manifest = JSON.parse(entries.find((e) => e.name.endsWith('manifest.json')).data);
    assert.strictEqual(manifest.counts.lockedContentExcluded, 1, 'omitted bodies are visible in the manifest');
    assert.strictEqual(manifest.counts.conversations, 1);
  } finally {
    Workspace.findById = saved.ws; Content.find = saved.c; AiThread.find = saved.t; AiThreadMessage.find = saved.m;
    AiTracker.find = saved.tr; ReportSnapshot.find = saved.rs; KeywordResearchHistory.find = saved.kw; BrandVoice.find = saved.bv;
  }
});
