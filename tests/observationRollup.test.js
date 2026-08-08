'use strict';

/**
 * Wave 0 (§3.6) — observation rollup service.
 *
 * Covers: per-day aggregation (count + distinct users), the workspace
 * dimension, impersonation exclusion at aggregation time, the AuditLog
 * billing/lifecycle lane, idempotency (re-rolling a day must not duplicate
 * or inflate), and the multi-day runDailyRollup window.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const ObservationEvent = require('../src/models/ObservationEvent');
const AuditLog = require('../src/models/AuditLog');
const ObservationDailyRollup = require('../src/models/ObservationDailyRollup');
const { rollupDay, runDailyRollup, getRollups, utcDayStart } = require('../src/services/observationRollupService');

const DAY_MS = 24 * 60 * 60 * 1000;
const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

// Insert an ObservationEvent via the raw collection with a forced createdAt —
// mongoose timestamps would stamp "now" and defeat day-bucket testing.
async function seedEvent({ event, userId, orgId, ws, createdAt, impersonatedBy = null }) {
  await ObservationEvent.collection.insertOne({
    event,
    userId: userId ?? null,
    organizationId: orgId ?? null,
    workspaceNumber: ws ?? null,
    impersonatedBy,
    payload: {},
    createdAt,
    updatedAt: createdAt,
  });
}

test('rollupDay aggregates count + distinct users per event × org × workspace', async () => {
  const day = utcDayStart(new Date(Date.now() - DAY_MS));
  const inDay = new Date(day.getTime() + 3600_000);
  const org = oid();
  const u1 = oid(); const u2 = oid();

  await seedEvent({ event: 'ai_edit_applied', userId: u1, orgId: org, ws: 7, createdAt: inDay });
  await seedEvent({ event: 'ai_edit_applied', userId: u1, orgId: org, ws: 7, createdAt: inDay });
  await seedEvent({ event: 'ai_edit_applied', userId: u2, orgId: org, ws: 7, createdAt: inDay });
  // Different workspace → separate row.
  await seedEvent({ event: 'ai_edit_applied', userId: u1, orgId: org, ws: 8, createdAt: inDay });
  // Different day → not rolled.
  await seedEvent({ event: 'ai_edit_applied', userId: u1, orgId: org, ws: 7, createdAt: new Date(day.getTime() + 2 * DAY_MS) });

  await rollupDay(day);

  const ws7 = await ObservationDailyRollup.findOne({ day, event: 'ai_edit_applied', workspaceNumber: 7 }).lean();
  assert.ok(ws7, 'workspace-7 row exists');
  assert.equal(ws7.count, 3);
  assert.equal(ws7.uniqueUsers, 2);
  assert.equal(ws7.source, 'observation');

  const ws8 = await ObservationDailyRollup.findOne({ day, event: 'ai_edit_applied', workspaceNumber: 8 }).lean();
  assert.equal(ws8.count, 1);
  assert.equal(ws8.uniqueUsers, 1);

  assert.equal(await ObservationDailyRollup.countDocuments({}), 2);
});

test('impersonated events are excluded at aggregation time', async () => {
  const day = utcDayStart(new Date(Date.now() - DAY_MS));
  const inDay = new Date(day.getTime() + 3600_000);
  const org = oid(); const u1 = oid();

  await seedEvent({ event: 'time_to_first_word', userId: u1, orgId: org, ws: 1, createdAt: inDay });
  await seedEvent({ event: 'time_to_first_word', userId: u1, orgId: org, ws: 1, createdAt: inDay, impersonatedBy: String(oid()) });

  await rollupDay(day);
  const row = await ObservationDailyRollup.findOne({ day, event: 'time_to_first_word' }).lean();
  assert.equal(row.count, 1, 'impersonated event must not be counted');
});

test('billing/lifecycle AuditLog actions fold into the audit lane', async () => {
  const day = utcDayStart(new Date(Date.now() - DAY_MS));
  const inDay = new Date(day.getTime() + 7200_000);
  const org = oid(); const u1 = oid();

  await AuditLog.collection.insertMany([
    { organizationId: org, userId: u1, action: 'billing.plan_change', resource: 'billing', createdAt: inDay },
    { organizationId: org, userId: u1, action: 'billing.plan_change', resource: 'billing', createdAt: inDay },
    { organizationId: org, userId: u1, action: 'lifecycle.suspended', resource: 'org', createdAt: inDay },
    // Non-billing action → ignored.
    { organizationId: org, userId: u1, action: 'content.create', resource: 'content', createdAt: inDay },
  ]);

  await rollupDay(day);

  const plan = await ObservationDailyRollup.findOne({ day, event: 'billing.plan_change' }).lean();
  assert.equal(plan.count, 2);
  assert.equal(plan.source, 'audit');
  assert.equal(plan.workspaceNumber, null);
  const susp = await ObservationDailyRollup.findOne({ day, event: 'lifecycle.suspended' }).lean();
  assert.equal(susp.count, 1);
  assert.equal(await ObservationDailyRollup.countDocuments({ event: 'content.create' }), 0);
});

test('re-rolling a day is idempotent (upserts, no duplicates, no inflation)', async () => {
  const day = utcDayStart(new Date(Date.now() - DAY_MS));
  const inDay = new Date(day.getTime() + 3600_000);
  const org = oid(); const u1 = oid();

  await seedEvent({ event: 'plan_proposed', userId: u1, orgId: org, ws: 3, createdAt: inDay });
  await rollupDay(day);
  // Late-arriving beacon for the same day, then re-roll.
  await seedEvent({ event: 'plan_proposed', userId: u1, orgId: org, ws: 3, createdAt: inDay });
  await rollupDay(day);
  await rollupDay(day);

  const rows = await ObservationDailyRollup.find({ day, event: 'plan_proposed' }).lean();
  assert.equal(rows.length, 1, 'one identity row, not duplicates');
  assert.equal(rows[0].count, 2, 'count reflects the re-rolled truth, not a sum of runs');
});

test('runDailyRollup covers the trailing N complete days; getRollups reads back', async () => {
  const today = utcDayStart(new Date());
  const org = oid(); const u1 = oid();
  // One event on each of the last 3 complete days + one today (not covered).
  for (let i = 1; i <= 3; i++) {
    await seedEvent({
      event: 'ai_edit_applied', userId: u1, orgId: org, ws: 1,
      createdAt: new Date(today.getTime() - i * DAY_MS + 3600_000),
    });
  }
  await seedEvent({ event: 'ai_edit_applied', userId: u1, orgId: org, ws: 1, createdAt: new Date(today.getTime() + 3600_000) });

  const res = await runDailyRollup({ days: 3 });
  assert.equal(res.days, 3);
  assert.equal(await ObservationDailyRollup.countDocuments({}), 3, 'today is NOT rolled (incomplete day)');

  const rows = await getRollups({ days: 10, event: 'ai_edit_applied' });
  assert.equal(rows.length, 3);
  assert.ok(rows[0].day > rows[2].day, 'newest first');

  const filtered = await getRollups({ days: 10, organizationId: String(org) });
  assert.equal(filtered.length, 3);
});
