'use strict';

/**
 * Regressions for the phase 1–7 review findings (USAGE-TELEMETRY-PLAN §9).
 *
 * Each test pins a defect that shipped and was found in review, so the same
 * mistake can't return quietly. Grouped by what the defect actually broke
 * rather than by which phase introduced it.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const ObservationEvent = require('../src/models/ObservationEvent');
const UserActivityRollup = require('../src/models/UserActivityRollup');
const Subscription = require('../src/models/Subscription');
const User = require('../src/models/User');
const { resolveRange } = require('../src/services/usageAnalyticsService');
const { getConversion } = require('../src/services/conversionAnalyticsService');
const { getRetention, weekStart } = require('../src/services/retentionAnalyticsService');
const exclusions = require('../src/services/analyticsExclusions');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-09T12:00:00.000Z');
const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); exclusions._resetCache(); });

// ── P2-3: one source of truth for the raw horizon ─────────────────────────
test('the TTL index and the analytics clamp read the same constant', async () => {
  const { RAW_HORIZON_DAYS } = require('../src/models/ObservationEvent');
  await ObservationEvent.init();
  const ttl = (await ObservationEvent.collection.indexes()).find((i) => 'expireAfterSeconds' in i);
  assert.equal(ttl.expireAfterSeconds, RAW_HORIZON_DAYS * 24 * 60 * 60,
    'a TTL change that left the clamp behind would make it lie about coverage');
  const r = resolveRange({ days: 365, source: 'raw', now: NOW });
  assert.equal(+r.rawAvailableFrom, +new Date(NOW.getTime() - RAW_HORIZON_DAYS * DAY_MS));
});

// ── P2-2: a window entirely older than retention ──────────────────────────
test('a window entirely outside retention is flagged, not inverted', async () => {
  const r = resolveRange({
    from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', source: 'raw', now: NOW,
  });
  assert.equal(r.outsideRetention, true);
  assert.ok(r.from <= r.to, 'must never produce from > to');
  assert.equal(+r.from, +r.to, 'zero-width, so it matches nothing rather than matching nonsense');
  assert.equal(r.days, 0, 'zero days, not a misleading 1');
});

test('a partially-covered window still reports as truncated, not outside', () => {
  const r = resolveRange({ days: 365, source: 'raw', now: NOW });
  assert.equal(r.truncated, true);
  assert.equal(r.outsideRetention, false, 'part of it IS answerable');
  assert.ok(r.from < r.to);
});

test('rollup-backed windows are never marked outside retention', () => {
  const r = resolveRange({ from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z', source: 'rollup', now: NOW });
  assert.equal(r.outsideRetention, false);
  assert.equal(r.truncated, false);
});

// ── P3-2: an incomplete subscription never paid ───────────────────────────
test('failed payments are not conversions', async () => {
  const mk = (status) => Subscription.collection.insertOne({
    organizationId: oid(), planId: 'standard-monthly', status,
    stripeSubscriptionId: `s_${status}_${Math.random()}`,
    createdAt: new Date(Date.now() - DAY_MS), updatedAt: new Date(),
  });
  await mk('active'); await mk('trialing'); await mk('past_due');
  await mk('canceled'); await mk('incomplete');

  const { funnel } = await getConversion({ days: 7 });
  assert.equal(funnel.stages[3].orgs, 4, 'everything but incomplete counts');
});

// ── P3-4: one label for one concept ───────────────────────────────────────
test('unknown surface is a single row, not two spellings of the same gap', async () => {
  const orgA = oid(); const orgB = oid();
  const at = new Date(Date.now() - DAY_MS);
  await ObservationEvent.collection.insertOne({
    event: 'checkout_started', userId: oid(), organizationId: orgA, workspaceNumber: null,
    impersonatedBy: null, payload: {}, createdAt: at, updatedAt: at, // no surface
  });
  await Subscription.collection.insertOne({
    organizationId: orgB, planId: 'standard-monthly', status: 'active', surface: null,
    stripeSubscriptionId: 's_x', createdAt: at, updatedAt: at,
  });

  const { surfaces } = await getConversion({ days: 7 });
  const unknown = surfaces.filter((s) => /unknown|unattributed|not captured/i.test(s.surface));
  assert.equal(unknown.length, 1, 'both sides of the same gap merge into one row');
  assert.equal(unknown[0].checkoutsStarted, 1);
  assert.equal(unknown[0].subscribed, 1);
});

// ── P3-5: consent weeks must match the cohort grid on the same screen ─────
test('the consent trend buckets on Monday, like retention', async () => {
  // 2026-08-09 is a Sunday. $dateTrunc would have opened a new week here;
  // Monday-start keeps it with the preceding Monday, matching the grid below it.
  const sunday = new Date('2026-08-09T10:00:00.000Z');
  await ObservationEvent.collection.insertOne({
    event: 'consent_choice', userId: oid(), organizationId: null, workspaceNumber: null,
    impersonatedBy: null, payload: { analytics: true }, createdAt: sunday, updatedAt: sunday,
  });
  const { consentTrend } = await getConversion({ days: 28 });
  assert.equal(consentTrend.length, 1);
  assert.equal(+consentTrend[0].week, +weekStart(sunday));
  assert.equal(new Date(consentTrend[0].week).getUTCDay(), 1, 'Monday');
});

// ── P4-1: the coverage warning must not cry wolf every day ────────────────
test('a healthy system reports no coverage gaps', async () => {
  const u = oid();
  await User.collection.insertOne({
    _id: u, userId: 770001, email: 'real@customer.example', status: 'active',
    tokenVersion: 0, createdAt: new Date(Date.now() - 20 * DAY_MS), updatedAt: new Date(),
  });
  const day = (ago) => new Date(Date.now() - ago * DAY_MS);
  const utcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Every complete day rolled, exactly as the nightly job leaves things...
  for (const ago of [1, 2, 3, 4, 5]) {
    await ObservationEvent.collection.insertOne({
      event: 'editor_opened', userId: u, organizationId: null, workspaceNumber: null,
      impersonatedBy: null, payload: {}, createdAt: day(ago), updatedAt: day(ago),
    });
    await UserActivityRollup.collection.insertOne({
      day: utcDay(day(ago)), userId: u, organizationId: null, eventCount: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  // ...plus today's activity, which CANNOT have a rollup row yet.
  await ObservationEvent.collection.insertOne({
    event: 'editor_opened', userId: u, organizationId: null, workspaceNumber: null,
    impersonatedBy: null, payload: {}, createdAt: new Date(), updatedAt: new Date(),
  });

  const { coverage } = await getRetention({ weeks: 8 });
  assert.equal(coverage.complete, true, 'a permanent warning is a warning nobody reads');
  assert.deepEqual(coverage.missingDays, []);
  assert.ok(coverage.expectedDays > 0, 'the tile has a denominator to judge against');
});

// ── P4-2: staff are not customers ─────────────────────────────────────────
test('staff accounts are excluded from cohorts and the active curve', async () => {
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'staff@suparank.ai';
  exclusions._resetCache();
  try {
    const signup = new Date(Date.now() - 10 * DAY_MS);
    const mk = async (email) => {
      const _id = oid();
      await User.collection.insertOne({
        _id, userId: Math.floor(Math.random() * 1e6), email, status: 'active',
        tokenVersion: 0, createdAt: signup, updatedAt: signup,
      });
      await UserActivityRollup.collection.insertOne({
        day: new Date(Date.UTC(signup.getUTCFullYear(), signup.getUTCMonth(), signup.getUTCDate())),
        userId: _id, organizationId: null, eventCount: 3, createdAt: new Date(), updatedAt: new Date(),
      });
      return _id;
    };
    await mk('real@customer.example');
    await mk('staff@suparank.ai');

    const r = await getRetention({ weeks: 8 });
    const total = r.cohorts.reduce((n, c) => n + c.size, 0);
    assert.equal(total, 1, 'staff must not inflate the denominator');
    assert.equal(r.weeklyActive.reduce((n, w) => n + w.activeUsers, 0), 1,
      'nor the numerator — excluding one side only would be worse than neither');
    assert.equal(r.staffExcluded, true, 'and the response says so');
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev;
    exclusions._resetCache();
  }
});

// ── P4-4: weekly buckets are computed server-side, Monday-start ───────────
test('weekly active users bucket on Monday and dedupe within a week', async () => {
  const u = oid();
  const mon = weekStart(new Date(Date.now() - 9 * DAY_MS));
  for (const offset of [0, 1, 2]) {
    await UserActivityRollup.collection.insertOne({
      day: new Date(mon.getTime() + offset * DAY_MS), userId: u, organizationId: null,
      eventCount: 1, createdAt: new Date(), updatedAt: new Date(),
    });
  }
  const { weeklyActive } = await getRetention({ weeks: 8 });
  const wk = weeklyActive.find((w) => +new Date(w.week) === +mon);
  assert.ok(wk, 'bucketed to the Monday that starts the week');
  assert.equal(wk.activeUsers, 1, 'three active days is still one active user');
});
