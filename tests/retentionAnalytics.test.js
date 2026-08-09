'use strict';

/**
 * Wave 5 Phase 4 — retention analytics (plan §9).
 *
 * The load-bearing claims: cohorts are keyed on signup week and only count a
 * user as retained if the rollup says they were active that week; the current
 * week is marked immature rather than read as a cliff; and — most importantly —
 * a rollup with missing days is REPORTED rather than silently producing a
 * confident-looking churn curve.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const User = require('../src/models/User');
const ObservationEvent = require('../src/models/ObservationEvent');
const UserActivityRollup = require('../src/models/UserActivityRollup');
const { getRetention, weekStart } = require('../src/services/retentionAnalyticsService');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

let userSeq = 700000;
async function user(createdAt) {
  const _id = oid();
  await User.collection.insertOne({
    _id, userId: userSeq++, email: `u${userSeq}@test.dev`, status: 'active',
    tokenVersion: 0, createdAt, updatedAt: createdAt,
  });
  return _id;
}

async function active(userId, day) {
  await UserActivityRollup.collection.insertOne({
    day: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())),
    userId, organizationId: null, eventCount: 1, createdAt: new Date(), updatedAt: new Date(),
  });
}

async function rawEvent(userId, at) {
  await ObservationEvent.collection.insertOne({
    event: 'editor_opened', userId, organizationId: null, workspaceNumber: null,
    impersonatedBy: null, payload: {}, createdAt: at, updatedAt: at,
  });
}

test('weeks start on Monday UTC', () => {
  // A Wednesday and the Sunday after it belong to the same Monday-started week.
  const wed = new Date('2026-08-05T12:00:00.000Z');
  const sun = new Date('2026-08-09T23:00:00.000Z');
  assert.equal(weekStart(wed).toISOString().slice(0, 10), '2026-08-03');
  assert.equal(+weekStart(wed), +weekStart(sun));
});

test('a cohort counts only members the rollup says were active that week', async () => {
  const thisWeek = weekStart(new Date());
  const signup = new Date(thisWeek.getTime() - 3 * WEEK_MS + DAY_MS);
  const u1 = await user(signup);
  const u2 = await user(signup);
  await user(signup); // never active

  await active(u1, new Date(signup.getTime() + DAY_MS));                 // W0
  await active(u1, new Date(signup.getTime() + 8 * DAY_MS));             // W1
  await active(u2, new Date(signup.getTime() + 9 * DAY_MS));             // W1

  const { cohorts } = await getRetention({ weeks: 8 });
  const row = cohorts.find((c) => +c.cohortWeek === +weekStart(signup));
  assert.equal(row.size, 3);
  assert.equal(row.cells.find((c) => c.offset === 0).active, 1);
  assert.equal(row.cells.find((c) => c.offset === 1).active, 2);
  assert.equal(row.cells.find((c) => c.offset === 2).active, 0, 'silence is silence, not a carry-forward');
});

test('a user active in two orgs on one day is one active user', async () => {
  const thisWeek = weekStart(new Date());
  const signup = new Date(thisWeek.getTime() - 2 * WEEK_MS + DAY_MS);
  const u = await user(signup);
  const day = new Date(signup.getTime() + DAY_MS);
  // Two rollup rows, same user, same day, different orgs.
  await UserActivityRollup.collection.insertMany([
    { day: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())), userId: u, organizationId: oid(), eventCount: 1, createdAt: new Date(), updatedAt: new Date() },
    { day: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())), userId: u, organizationId: oid(), eventCount: 1, createdAt: new Date(), updatedAt: new Date() },
  ]);

  const { cohorts, weeklyActive } = await getRetention({ weeks: 8 });
  const row = cohorts.find((c) => +c.cohortWeek === +weekStart(signup));
  assert.equal(row.cells.find((c) => c.offset === 0).active, 1);
  assert.equal(weeklyActive.find((w) => +w.week === +weekStart(day)).activeUsers, 1);
});

test('the current week is marked immature, not read as a drop', async () => {
  const thisWeek = weekStart(new Date());
  const u = await user(new Date(thisWeek.getTime() - WEEK_MS + DAY_MS));
  await active(u, new Date(thisWeek.getTime() - WEEK_MS + DAY_MS));

  const { cohorts, weeklyActive } = await getRetention({ weeks: 8 });
  const row = cohorts[cohorts.length - 1];
  const current = row.cells.find((c) => +row.cohortWeek + c.offset * WEEK_MS === +thisWeek);
  assert.ok(current, 'the running week should still be present');
  assert.equal(current.immature, true);
  const currentWeekly = weeklyActive.find((w) => +w.week === +thisWeek);
  if (currentWeekly) assert.equal(currentWeekly.immature, true);
});

test('tiles ignore cohorts whose week has not finished', async () => {
  const thisWeek = weekStart(new Date());
  // Signed up this week: its W1 is in the future and must not drag the tile down.
  const u = await user(new Date(thisWeek.getTime() + DAY_MS));
  await active(u, new Date(thisWeek.getTime() + DAY_MS));

  const { tiles } = await getRetention({ weeks: 8 });
  assert.equal(tiles.w1.cohorts, 0, 'no cohort has a finished week 1 yet');
  assert.equal(tiles.w1.cohortUsers, 0);
});

test('COVERAGE: a day the rollup missed is reported, not silently zeroed', async () => {
  const thisWeek = weekStart(new Date());
  const signup = new Date(thisWeek.getTime() - 2 * WEEK_MS + DAY_MS);
  const u = await user(signup);

  const rolledDay = new Date(signup.getTime() + DAY_MS);
  const missedDay = new Date(signup.getTime() + 2 * DAY_MS);
  await active(u, rolledDay);
  await rawEvent(u, rolledDay);
  // Raw activity exists for this day but the nightly job never folded it in —
  // exactly what an interrupted backfill leaves behind.
  await rawEvent(u, missedDay);

  const { coverage } = await getRetention({ weeks: 8 });
  assert.equal(coverage.complete, false);
  assert.ok(
    coverage.missingDays.includes(missedDay.toISOString().slice(0, 10)),
    'the un-rolled day must be named so the numbers can be distrusted'
  );
  assert.ok(!coverage.missingDays.includes(rolledDay.toISOString().slice(0, 10)));
});

test('COVERAGE: a fully rolled window reports complete', async () => {
  const thisWeek = weekStart(new Date());
  const u = await user(new Date(thisWeek.getTime() - WEEK_MS));
  const d = new Date(thisWeek.getTime() - WEEK_MS + DAY_MS);
  await rawEvent(u, d);
  await active(u, d);

  const { coverage } = await getRetention({ weeks: 8 });
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.missingDays, []);
});

test('impersonated raw activity does not register as a coverage gap', async () => {
  const thisWeek = weekStart(new Date());
  const u = await user(new Date(thisWeek.getTime() - WEEK_MS));
  const d = new Date(thisWeek.getTime() - WEEK_MS + DAY_MS);
  // The rollup deliberately excludes impersonation, so its absence there is
  // correct rather than a missing day.
  await ObservationEvent.collection.insertOne({
    event: 'editor_opened', userId: u, organizationId: null, workspaceNumber: null,
    impersonatedBy: String(oid()), payload: {}, createdAt: d, updatedAt: d,
  });

  const { coverage } = await getRetention({ weeks: 8 });
  assert.equal(coverage.complete, true, 'excluded-by-design must not look like data loss');
});

test('the week count is clamped to something sane', async () => {
  assert.equal((await getRetention({ weeks: 0 })).weeks, 8);
  assert.equal((await getRetention({ weeks: 999 })).weeks, 52);
  assert.equal((await getRetention({ weeks: '4' })).weeks, 4);
});
