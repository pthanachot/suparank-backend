'use strict';

/**
 * Observation rollup service (Wave 0, §3.6).
 *
 * Folds raw ObservationEvent rows (90d TTL) and billing/lifecycle AuditLog
 * actions (180d TTL) into the no-TTL ObservationDailyRollup collection, one
 * row per (UTC day × event × org × workspace). Idempotent: re-rolling a day
 * upserts on the rollup identity, so the nightly cron re-rolls a trailing
 * window to absorb late-arriving beacons without double counting.
 *
 * Impersonated events are excluded HERE, at aggregation time — downstream
 * readers get clean numbers without having to remember the filter.
 */

const ObservationEvent = require('../models/ObservationEvent');
const AuditLog = require('../models/AuditLog');
const ObservationDailyRollup = require('../models/ObservationDailyRollup');
const UserActivityRollup = require('../models/UserActivityRollup');

const DAY_MS = 24 * 60 * 60 * 1000;
// Raw ObservationEvent TTL. Nothing older can be rolled, so a backfill that
// reaches past it is wasted work rather than recovered history.
const RAW_HORIZON_DAYS = 90;

/** UTC midnight of the day containing `d`. */
function utcDayStart(d) {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

/** Distinct non-null users out of an $addToSet result. */
function countUsers(users) {
  return (users || []).filter(Boolean).length;
}

/**
 * Roll up one UTC day. Returns the number of rollup rows written.
 * Safe to call repeatedly for the same day (upserts on rollup identity).
 */
async function rollupDay(dayStart) {
  const day = utcDayStart(dayStart);
  const end = new Date(day.getTime() + DAY_MS);
  const ops = [];

  // Lane 1: ObservationEvent (client + server emits). Impersonation excluded —
  // { impersonatedBy: null } also matches rows written before the field existed.
  const obs = await ObservationEvent.aggregate([
    { $match: { createdAt: { $gte: day, $lt: end }, impersonatedBy: null } },
    {
      $group: {
        _id: { event: '$event', org: '$organizationId', ws: '$workspaceNumber' },
        count: { $sum: 1 },
        users: { $addToSet: '$userId' },
      },
    },
  ]);
  for (const g of obs) {
    ops.push({
      updateOne: {
        filter: {
          day,
          event: g._id.event,
          organizationId: g._id.org ?? null,
          workspaceNumber: g._id.ws ?? null,
          source: 'observation',
        },
        update: { $set: { count: g.count, uniqueUsers: countUsers(g.users) } },
        upsert: true,
      },
    });
  }

  // Lane 2: billing/lifecycle AuditLog actions (AuditLog TTLs at 180d; churn
  // context — "hit the cap 11× then canceled" — must outlive it). AuditLog is
  // org-scoped with workspaceId (ObjectId), not workspaceNumber; the org
  // dimension is what churn analysis needs, so workspaceNumber stays null.
  const audit = await AuditLog.aggregate([
    {
      $match: {
        createdAt: { $gte: day, $lt: end },
        action: { $regex: /^(billing|lifecycle)\./ },
      },
    },
    {
      $group: {
        _id: { event: '$action', org: '$organizationId' },
        count: { $sum: 1 },
        users: { $addToSet: '$userId' },
      },
    },
  ]);
  for (const g of audit) {
    ops.push({
      updateOne: {
        filter: {
          day,
          event: g._id.event,
          organizationId: g._id.org ?? null,
          workspaceNumber: null,
          source: 'audit',
        },
        update: { $set: { count: g.count, uniqueUsers: countUsers(g.users) } },
        upsert: true,
      },
    });
  }

  if (ops.length) await ObservationDailyRollup.bulkWrite(ops, { ordered: false });
  return ops.length;
}

/**
 * Roll up one UTC day of per-user activity into UserActivityRollup (Wave 5
 * Phase 2). Same idempotent-upsert contract as rollupDay. Returns rows written.
 *
 * Kept separate from rollupDay's event-keyed aggregation because distinct-user
 * math cannot be recovered from per-event counts: summing uniqueUsers across
 * events double-counts anyone who fired more than one.
 */
async function rollupUserActivityDay(dayStart) {
  const day = utcDayStart(dayStart);
  const end = new Date(day.getTime() + DAY_MS);

  const rows = await ObservationEvent.aggregate([
    // userId null = logged-out/unattributed traffic; it can't belong to a
    // cohort, so it has no place in a per-user rollup.
    { $match: { createdAt: { $gte: day, $lt: end }, impersonatedBy: null, userId: { $ne: null } } },
    { $group: { _id: { user: '$userId', org: '$organizationId' }, count: { $sum: 1 } } },
  ]);

  const ops = rows.map((g) => ({
    updateOne: {
      filter: { day, userId: g._id.user, organizationId: g._id.org ?? null },
      update: { $set: { eventCount: g.count } },
      upsert: true,
    },
  }));
  if (ops.length) await UserActivityRollup.bulkWrite(ops, { ordered: false });
  return ops.length;
}

/**
 * Nightly entry point: re-roll the last `days` COMPLETE UTC days (yesterday
 * backwards). The trailing window absorbs unload beacons that landed after a
 * prior run; idempotent upserts make the overlap free.
 *
 * `backfillIfEmpty` (default on) covers the first run after UserActivityRollup
 * was introduced: with an empty collection it reaches back over the whole raw
 * TTL horizon instead of 3 days, so the retention history that still exists in
 * ObservationEvent is captured before it expires. Idempotent, so a repeat run
 * after the collection is populated costs nothing.
 */
async function runDailyRollup({ days = 3, now = new Date(), backfillIfEmpty = true } = {}) {
  const today = utcDayStart(now);
  let rows = 0;
  for (let i = 1; i <= days; i++) {
    rows += await rollupDay(new Date(today.getTime() - i * DAY_MS));
  }

  let userDays = days;
  if (backfillIfEmpty && (await UserActivityRollup.estimatedDocumentCount()) === 0) {
    userDays = RAW_HORIZON_DAYS;
    console.log(`[rollup] UserActivityRollup empty — backfilling ${userDays} days from raw events`);
  }
  let userRows = 0;
  for (let i = 1; i <= userDays; i++) {
    userRows += await rollupUserActivityDay(new Date(today.getTime() - i * DAY_MS));
  }

  return { days, rows, userDays, userRows };
}

/** Reader for GET /api/admin/usage-rollups. Newest first, capped. */
async function getRollups({ days = 30, event = null, organizationId = null, limit = 1000 } = {}) {
  const since = utcDayStart(new Date(Date.now() - days * DAY_MS));
  const q = { day: { $gte: since } };
  if (event) q.event = event;
  if (organizationId) q.organizationId = organizationId;
  return ObservationDailyRollup.find(q)
    .sort({ day: -1, event: 1 })
    .limit(Math.min(5000, limit))
    .lean();
}

module.exports = { rollupDay, rollupUserActivityDay, runDailyRollup, getRollups, utcDayStart };
