'use strict';

/**
 * Wave 5 Phase 2 — UserActivityRollup (plan §9).
 *
 * This collection is the durable answer to "was this user active that day?"
 * after raw events TTL out at 90 days. What matters: it is idempotent (the
 * nightly job re-rolls a trailing window), it excludes impersonation (an admin
 * browsing as a customer must not make that customer look retained), and its
 * first run backfills the whole raw horizon instead of only 3 days.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const ObservationEvent = require('../src/models/ObservationEvent');
const UserActivityRollup = require('../src/models/UserActivityRollup');
const { rollupUserActivityDay, runDailyRollup } = require('../src/services/observationRollupService');

const DAY_MS = 24 * 60 * 60 * 1000;
const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

async function seed(event, { userId, org = null, ago = 1, impersonatedBy = null } = {}) {
  const createdAt = new Date(Date.now() - ago * DAY_MS);
  await ObservationEvent.collection.insertOne({
    event, userId, organizationId: org, workspaceNumber: null,
    impersonatedBy, payload: {}, createdAt, updatedAt: createdAt,
  });
}

test('one row per user per org per day, counting their events', async () => {
  const u1 = oid(); const u2 = oid(); const org = oid();
  const day = new Date(Date.now() - DAY_MS);
  await seed('editor_opened', { userId: u1, org });
  await seed('ai_chat_message_sent', { userId: u1, org });
  await seed('editor_opened', { userId: u2, org });

  const rows = await rollupUserActivityDay(day);
  assert.equal(rows, 2, 'two distinct users');

  const r1 = await UserActivityRollup.findOne({ userId: u1 }).lean();
  assert.equal(r1.eventCount, 2, 'activity depth, not just presence');
  assert.equal(String(r1.organizationId), String(org));
});

test('the same user in two orgs produces a row each', async () => {
  const u = oid(); const orgA = oid(); const orgB = oid();
  await seed('editor_opened', { userId: u, org: orgA });
  await seed('editor_opened', { userId: u, org: orgB });

  await rollupUserActivityDay(new Date(Date.now() - DAY_MS));
  // Per-org retention needs the split; whole-product retention groups by userId.
  assert.equal(await UserActivityRollup.countDocuments({ userId: u }), 2);
});

test('re-rolling the same day is idempotent, not additive', async () => {
  const u = oid();
  await seed('editor_opened', { userId: u });
  const day = new Date(Date.now() - DAY_MS);

  await rollupUserActivityDay(day);
  await rollupUserActivityDay(day);
  await rollupUserActivityDay(day);

  const rows = await UserActivityRollup.find({ userId: u }).lean();
  assert.equal(rows.length, 1, 'the trailing re-roll window must not duplicate');
  assert.equal(rows[0].eventCount, 1, 'nor inflate the count');
});

test('impersonated activity is excluded', async () => {
  const victim = oid();
  await seed('editor_opened', { userId: victim, impersonatedBy: String(oid()) });
  await rollupUserActivityDay(new Date(Date.now() - DAY_MS));
  assert.equal(await UserActivityRollup.countDocuments({ userId: victim }), 0);
});

test('events with no user are skipped — they belong to no cohort', async () => {
  await seed('report_share_opened', { userId: null });
  const rows = await rollupUserActivityDay(new Date(Date.now() - DAY_MS));
  assert.equal(rows, 0);
});

test('the first run covers the whole raw horizon, not just 3 days', async () => {
  const u = oid();
  await seed('editor_opened', { userId: u, ago: 1 });
  await seed('editor_opened', { userId: u, ago: 45 });  // older than the nightly window

  const r = await runDailyRollup({ days: 3 });
  assert.equal(r.repairedUserDays, 1, 'the out-of-window day is repaired');
  // Without it, the 45-day-old day would expire unrolled and that history is gone.
  assert.equal(await UserActivityRollup.countDocuments({ userId: u }), 2);
});

test('a run that already covered everything repairs nothing', async () => {
  const u = oid();
  await seed('editor_opened', { userId: u, ago: 1 });
  await runDailyRollup({ days: 3 });
  const second = await runDailyRollup({ days: 3 });
  assert.equal(second.repairedUserDays, 0, 'no gaps left to find');
  assert.equal(await UserActivityRollup.countDocuments({ userId: u }), 1, 'and nothing duplicated');
});

test('an INTERRUPTED backfill is repaired on the next run, not stranded', async () => {
  // The failure the old emptiness check could not survive: a first pass that
  // wrote some rows and died. Those rows made the collection non-empty, so
  // every later run fell back to 3 days and the rest expired unrolled.
  const u = oid();
  for (const ago of [1, 20, 40, 60]) await seed('editor_opened', { userId: u, ago });
  await rollupUserActivityDay(new Date(Date.now() - 20 * DAY_MS)); // partial progress

  assert.equal(await UserActivityRollup.countDocuments({}), 1, 'collection is non-empty');
  const r = await runDailyRollup({ days: 3 });
  assert.equal(r.repairedUserDays, 2, 'the 40- and 60-day-old days are found');
  assert.equal(await UserActivityRollup.countDocuments({ userId: u }), 4, 'all four days now rolled');
});

test('a day whose only activity is excluded is not re-detected forever', async () => {
  // Impersonated / user-less events legitimately produce no rollup row. If the
  // repair query used a different filter from the lane it repairs, that day
  // would look like a gap on every run, for ever.
  await seed('editor_opened', { userId: oid(), ago: 30, impersonatedBy: String(oid()) });
  const r = await runDailyRollup({ days: 3 });
  assert.equal(r.repairedUserDays, 0);
  const again = await runDailyRollup({ days: 3 });
  assert.equal(again.repairedUserDays, 0, 'and still zero the next night');
});
