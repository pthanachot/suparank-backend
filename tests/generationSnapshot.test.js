'use strict';

/**
 * Wave 5 Phase 7 — GenerationSnapshot (plan §9).
 *
 * The point of this collection is that AgentUsageLog TTLs at 90 days and never
 * held the knobs at all: targetScore, maxIterations and commandName were handed
 * to the engine and dropped. What must hold:
 *
 *  - rows store RAW values, never a "kept the default" verdict, so changing the
 *    defaults reinterprets history instead of freezing an old judgement (W5);
 *  - "didn't send a value" is distinct from "sent the default", because only
 *    the second is evidence a human looked at the control;
 *  - impersonated runs are excluded, as everywhere else.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const GenerationSnapshot = require('../src/models/GenerationSnapshot');
const { getGenerationSettings, RUN_DEFAULTS } = require('../src/services/contentChoicesService');

const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

const snap = (f = {}) => GenerationSnapshot.collection.insertOne({
  contentId: f.contentId ?? oid(), workspaceId: oid(), organizationId: oid(), userId: oid(),
  impersonatedBy: f.impersonatedBy ?? null,
  voiceId: f.voiceId ?? null, avatarId: f.avatarId ?? null,
  targetScore: f.targetScore === undefined ? null : f.targetScore,
  maxIterations: f.maxIterations === undefined ? null : f.maxIterations,
  commandName: f.commandName ?? null, runMode: f.runMode ?? null,
  source: 'agent', runId: 'r1', createdAt: new Date(), updatedAt: new Date(),
});

test('the documented defaults are the ones the editor actually ships', () => {
  // If the editor changes these, the plan section must record the new value and
  // its date — old rows are reinterpreted, not rewritten.
  assert.deepEqual(RUN_DEFAULTS, { targetScore: 75, maxIterations: 5 });
});

test('sending the default counts as kept, not as changed', async () => {
  await snap({ targetScore: 75, maxIterations: 5 });
  await snap({ targetScore: 75, maxIterations: 5 });
  const g = await getGenerationSettings();
  assert.equal(g.targetScore.sent, 2);
  assert.equal(g.targetScore.changed, 0);
  assert.equal(g.maxIterations.changed, 0);
});

test('sending something other than the default counts as changed', async () => {
  await snap({ targetScore: 90, maxIterations: 12 });
  const g = await getGenerationSettings();
  assert.equal(g.targetScore.changed, 1);
  assert.equal(g.maxIterations.changed, 1);
});

test('sending nothing is neither kept nor changed', async () => {
  // A chat turn carries no targetScore; reading that as agreement with the
  // default would invent evidence that nobody produced.
  await snap({});
  const g = await getGenerationSettings();
  assert.equal(g.runs, 1);
  assert.equal(g.targetScore.sent, 0);
  assert.equal(g.targetScore.changed, 0);
});

test('raw values are stored — no verdict is frozen into the row', async () => {
  await snap({ targetScore: 75 });
  const row = await GenerationSnapshot.findOne({}).lean();
  assert.equal(row.targetScore, 75);
  assert.ok(!('keptDefault' in row), 'a stored verdict could not survive a change of defaults');
});

test('persona attribution survives per voice and per avatar', async () => {
  const c1 = oid(); const c2 = oid();
  await snap({ voiceId: 'v1', avatarId: 'a1', contentId: c1 });
  await snap({ voiceId: 'v1', avatarId: 'a1', contentId: c1 }); // same article, two runs
  await snap({ voiceId: 'v1', contentId: c2 });
  await snap({ voiceId: 'v2' });

  const g = await getGenerationSettings();
  assert.equal(g.withVoice, 4);
  assert.equal(g.withAvatar, 2);
  const v1 = g.byVoice.find((v) => v.voiceId === 'v1');
  assert.equal(v1.runs, 3);
  assert.equal(v1.articles, 2, 'runs and articles are different questions');
});

test('impersonated runs are excluded everywhere in this read', async () => {
  await snap({ voiceId: 'v1', targetScore: 90, commandName: 'rewrite', impersonatedBy: String(oid()) });
  const g = await getGenerationSettings();
  assert.equal(g.runs, 0);
  assert.equal(g.byVoice.length, 0);
  assert.equal(g.byCommand.length, 0);
  assert.equal(g.targetScore.changed, 0);
});

test('slash commands are counted by name', async () => {
  await snap({ commandName: 'rewrite' });
  await snap({ commandName: 'rewrite' });
  await snap({ commandName: 'expand' });
  await snap({});
  const g = await getGenerationSettings();
  assert.deepEqual(g.byCommand, [{ command: 'rewrite', runs: 2 }, { command: 'expand', runs: 1 }]);
});

test('the read declares that capture started with this phase', async () => {
  const g = await getGenerationSettings();
  // Without this, a low run count next to many articles reads as inactivity
  // rather than as history that was never captured.
  assert.equal(g.capturedSince, 'phase-7');
  assert.deepEqual(g.defaults, RUN_DEFAULTS);
});

test('the collection has no TTL index', async () => {
  await GenerationSnapshot.init();
  const idx = await GenerationSnapshot.collection.indexes();
  assert.ok(
    !idx.some((i) => 'expireAfterSeconds' in i),
    'this is the durable half of the pair — a TTL here would recreate the gap it exists to close'
  );
});
