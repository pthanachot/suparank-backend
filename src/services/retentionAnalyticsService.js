'use strict';

/**
 * Retention analytics (Wave 5 Phase 4, plan §9).
 *
 * Reads UserActivityRollup — the no-TTL record of who was active on which day
 * that Phase 2 started accruing. Three views: signup-week cohorts, the weekly
 * returning-users curve, and W1/W4 tiles.
 *
 * COVERAGE IS REPORTED, NOT ASSUMED. A retention curve computed over a rollup
 * with missing days looks exactly like a retention curve over real inactivity —
 * confidently wrong, with nothing on screen to suggest doubt. So every response
 * carries a `coverage` block, and days where raw events exist but no rollup row
 * does are reported as definite gaps. Within the raw TTL horizon that check is
 * exact; beyond it neither source survives and the block says so.
 *
 * Weeks start MONDAY, UTC — matching the UTC day boundary the rollups are
 * keyed on. Bucketing is done with $dayOfWeek arithmetic rather than
 * $dateTrunc, whose week buckets start on SUNDAY by default: the consent trend
 * renders directly above these panels, and two different week definitions on
 * one screen is worse than either definition alone.
 */

const User = require('../models/User');
const ObservationEvent = require('../models/ObservationEvent');
const UserActivityRollup = require('../models/UserActivityRollup');
const { RAW_HORIZON_DAYS } = require('../models/ObservationEvent');
const { excludedUserFilter } = require('./analyticsExclusions');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** UTC midnight of the day containing `d`. */
function utcDayStart(d) {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

/** UTC Monday that starts the week containing `d`. */
function weekStart(d) {
  const day = utcDayStart(d);
  const shift = (day.getUTCDay() + 6) % 7; // Sunday(0) -> 6, Monday(1) -> 0
  return new Date(day.getTime() - shift * DAY_MS);
}

/**
 * Which days in the window actually have rollup rows, and which are provably
 * missing (raw events exist for that day, the rollup has nothing).
 */
async function getCoverage(from, to, now, excludedUsers) {
  const userMatch = { impersonatedBy: null, userId: excludedUsers ? { $ne: null, ...excludedUsers } : { $ne: null } };
  const [rolledDays, rawDays] = await Promise.all([
    UserActivityRollup.distinct('day', { day: { $gte: from, $lt: to } }),
    ObservationEvent.aggregate([
      { $match: { ...userMatch, createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        },
      },
    ]),
  ]);

  const rolled = new Set(rolledDays.map((d) => utcDayStart(d).toISOString().slice(0, 10)));
  const raw = rawDays.map((r) => r._id);

  // Only meaningful inside the raw horizon: past it the raw side is gone too,
  // so an absent rollup row is indistinguishable from a genuinely quiet day.
  const today = utcDayStart(now);
  const horizonStart = utcDayStart(new Date(now.getTime() - RAW_HORIZON_DAYS * DAY_MS));
  const checkableFrom = from > horizonStart ? from : horizonStart;
  // The nightly job rolls only COMPLETE days, yesterday backwards, at 03:40
  // UTC. Today can never have a row, and yesterday has none until tonight's
  // tick — so neither is evidence of a gap. Checking through the day before
  // yesterday gives the cron a full tick of slack. Without this the banner
  // fires every single day on a healthy system, and a warning that is always
  // on is a warning nobody reads — which would defeat the only mechanism that
  // makes a real rollup gap visible.
  const checkableTo = new Date(today.getTime() - DAY_MS);

  const gaps = raw
    .filter((d) => {
      const at = new Date(`${d}T00:00:00.000Z`);
      return at >= checkableFrom && at < checkableTo && !rolled.has(d);
    })
    .sort();

  // Complete days in the window — today can never be rolled, so counting it
  // would make the ratio permanently short of full.
  const windowEnd = to < today ? to : today;
  const expectedDays = Math.max(0, Math.round((windowEnd - from) / DAY_MS));

  return {
    daysWithRollup: rolled.size,
    // Context, not a health signal: a genuinely quiet day legitimately has no
    // row, so daysWithRollup < expectedDays is not by itself evidence of loss.
    // missingDays is the authoritative signal — it is cross-checked against
    // raw events that still exist.
    expectedDays,
    // A day the rollup missed even though raw events for it still exist. Each
    // one is activity the retention math below cannot see.
    missingDays: gaps,
    // The window gap-detection could actually verify, both ends.
    verifiableFrom: checkableFrom,
    verifiableTo: checkableTo,
    complete: gaps.length === 0,
  };
}

/**
 * Signup-week cohorts × weeks since signup.
 *
 * A cell counts distinct users from that cohort active in that week. Cells
 * whose week has not finished are marked immature rather than being rendered
 * as a dip — the difference between "they stopped" and "the week isn't over".
 */
async function getCohorts(cohortCount, now, excludedUsers) {
  const thisWeek = weekStart(now);
  const firstCohort = new Date(thisWeek.getTime() - (cohortCount - 1) * WEEK_MS);

  const [users, activity] = await Promise.all([
    User.find({ createdAt: { $gte: firstCohort }, ...(excludedUsers ? { _id: excludedUsers } : {}) }, { _id: 1, createdAt: 1 }).lean(),
    UserActivityRollup.aggregate([
      { $match: { day: { $gte: firstCohort }, ...(excludedUsers ? { userId: excludedUsers } : {}) } },
      // One row per user per day per org — collapse to user × day first so a
      // user active in two organisations isn't counted twice.
      { $group: { _id: { user: '$userId', day: '$day' } } },
      { $group: { _id: '$_id.user', days: { $addToSet: '$_id.day' } } },
    ]),
  ]);

  const activeWeeksByUser = new Map(
    activity.map((a) => [String(a._id), new Set(a.days.map((d) => weekStart(d).getTime()))])
  );

  // cohort week -> user ids
  const cohorts = new Map();
  for (const u of users) {
    const key = weekStart(u.createdAt).getTime();
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(String(u._id));
  }

  const maxOffset = cohortCount - 1;
  const rows = [...cohorts.keys()].sort().map((cohortWeek) => {
    const members = cohorts.get(cohortWeek);
    const cells = [];
    for (let offset = 0; offset <= maxOffset; offset++) {
      const weekOf = cohortWeek + offset * WEEK_MS;
      if (weekOf > thisWeek.getTime()) break; // entirely in the future
      const active = members.filter((id) => activeWeeksByUser.get(id)?.has(weekOf)).length;
      cells.push({
        offset,
        active,
        // The current week is still accumulating; reading it as a drop is wrong.
        immature: weekOf === thisWeek.getTime(),
      });
    }
    return { cohortWeek: new Date(cohortWeek), size: members.length, cells };
  });

  return rows;
}

/** Distinct active users per week across the whole product. */
async function getWeeklyActive(from, now, excludedUsers) {
  // Bucketed server-side: the previous shape returned one document per user
  // per active day to Node (users × days — tens of thousands at modest scale)
  // and folded them here. $dayOfWeek gives Sunday=1, so shifting by
  // (dayOfWeek + 5) mod 7 lands on the Monday that starts the week, matching
  // weekStart() exactly. Deliberately not $dateTrunc, whose week buckets start
  // on Sunday by default and would disagree with the cohort grid on the same
  // screen.
  const rows = await UserActivityRollup.aggregate([
    { $match: { day: { $gte: from }, ...(excludedUsers ? { userId: excludedUsers } : {}) } },
    {
      $addFields: {
        week: {
          $subtract: [
            '$day',
            { $multiply: [{ $mod: [{ $add: [{ $dayOfWeek: '$day' }, 5] }, 7] }, DAY_MS] },
          ],
        },
      },
    },
    // Collapse to one row per user per week first, so a user active five days
    // counts once.
    { $group: { _id: { week: '$week', user: '$userId' } } },
    { $group: { _id: '$_id.week', activeUsers: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const thisWeek = weekStart(now).getTime();
  return rows.map((r) => ({
    week: r._id,
    activeUsers: r.activeUsers,
    immature: new Date(r._id).getTime() === thisWeek,
  }));
}

/**
 * W1/W4 tiles across cohorts old enough to have that week behind them.
 * Counts, not percentages — at beta scale a ratio manufactures precision
 * (plan §7.0 small-N ladder).
 */
function summarise(rows, thisWeekMs) {
  const tile = (offset) => {
    let cohortUsers = 0;
    let retained = 0;
    let cohorts = 0;
    for (const r of rows) {
      const weekOf = r.cohortWeek.getTime() + offset * WEEK_MS;
      if (weekOf >= thisWeekMs) continue; // that week hasn't finished
      const cell = r.cells.find((c) => c.offset === offset);
      if (!cell) continue;
      cohorts += 1;
      cohortUsers += r.size;
      retained += cell.active;
    }
    return { offset, cohorts, cohortUsers, retained };
  };
  return { w1: tile(1), w4: tile(4) };
}

async function getRetention({ weeks = 8, now = new Date() } = {}) {
  const count = Math.max(2, Math.min(52, parseInt(weeks, 10) || 8));
  const thisWeek = weekStart(now);
  const from = new Date(thisWeek.getTime() - (count - 1) * WEEK_MS);

  // Staff are excluded per plan §7.0 — resolved once and threaded so the
  // roster, the activity side and the coverage check all agree.
  const excludedUsers = await excludedUserFilter();

  const [cohorts, weekly, coverage] = await Promise.all([
    getCohorts(count, now, excludedUsers),
    getWeeklyActive(from, now, excludedUsers),
    getCoverage(from, now, now, excludedUsers),
  ]);

  return {
    weeks: count,
    from,
    weekStartsOn: 'monday-utc',
    staffExcluded: true,
    coverage,
    cohorts,
    weeklyActive: weekly,
    tiles: summarise(cohorts, thisWeek.getTime()),
  };
}

module.exports = { getRetention, getCoverage, getCohorts, getWeeklyActive, weekStart };
