'use strict';

/**
 * Conversion analytics (Wave 5 Phase 3, plan §9).
 *
 * Answers "where do users hit a wall, and does hitting it turn into revenue".
 * Four read-models, each with a deliberate source:
 *
 *  1. WHICH-WALL TABLE — quota_denied broken down by feature × tier × slot.
 *     Those dimensions live in the event PAYLOAD, and ObservationDailyRollup
 *     keeps only per-event totals, so this is raw-only and therefore capped at
 *     the 90-day TTL horizon. The response says so rather than implying the
 *     table covers whatever window was asked for (plan §9.0 / W2).
 *
 *  2. UPGRADE-PATH FUNNEL — wall hit → upgrade clicked → checkout started →
 *     subscription created. The final stage reads the Subscription collection,
 *     NOT the AuditLog: AuditLog expires at 180 days and its rollup lane keeps
 *     counts rather than actors, so an actor-level join needs the no-TTL
 *     collection (plan §9 F3).
 *
 *     ORG is the actor for every stage. Billing is org-scoped — a subscription
 *     has no single "user who converted" — so counting users for the early
 *     stages and orgs for the last would compare different populations.
 *
 *     Stages MIX LANES: quota_denied is server-recorded and complete, while
 *     upgrade_clicked and checkout_started are client events behind the consent
 *     gate and therefore lower bounds. The middle of this funnel can legally
 *     read lower than its ends; each stage carries its lane so the UI can say
 *     so instead of the reader assuming a broken funnel (plan §9.0 / W1).
 *
 *  3. SURFACE ATTRIBUTION — which upgrade entry point produced revenue, from
 *     the durable Subscription.surface (Phase 3 F4) alongside the intent-side
 *     checkout_started payload.
 *
 *  4. CONSENT TREND — the [C]-lane denominator over time.
 *
 * Impersonated rows are excluded everywhere, as in every other analytics read.
 */

const ObservationEvent = require('../models/ObservationEvent');
const Subscription = require('../models/Subscription');
const { resolveRange, RAW_HORIZON_DAYS } = require('./usageAnalyticsService');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Distinct non-null values from an $addToSet result. */
const distinct = (arr) => new Set((arr ?? []).filter((v) => v != null).map(String)).size;

/**
 * Which wall, for whom. Rows are (action × tier × slot × limit), each with the
 * volume of denials and how many distinct orgs/users ran into it.
 */
async function getWalls(from, to) {
  const rows = await ObservationEvent.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, event: 'quota_denied', impersonatedBy: null } },
    {
      $group: {
        _id: {
          action: '$payload.action',
          tier: '$payload.tier',
          // Only present when the denial was a free lifetime slot; a paid org
          // denied on one must not read as a Free-tier wall (W5).
          quotaSource: '$payload.quotaSource',
          limitKey: '$payload.limitKey',
          scope: '$payload.scope',
        },
        count: { $sum: 1 },
        orgs: { $addToSet: '$organizationId' },
        users: { $addToSet: '$userId' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  return rows.map((r) => ({
    action: r._id.action || '(unlabelled)',
    tier: r._id.tier || '(unknown)',
    quotaSource: r._id.quotaSource || 'plan',
    limitKey: r._id.limitKey || '',
    scope: r._id.scope || 'org',
    denials: r.count,
    orgs: distinct(r.orgs),
    users: distinct(r.users),
  }));
}

/** Distinct orgs emitting any of `events` in the window. */
async function orgsForEvents(events, from, to) {
  const rows = await ObservationEvent.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, event: { $in: events }, impersonatedBy: null } },
    { $group: { _id: null, orgs: { $addToSet: '$organizationId' }, count: { $sum: 1 } } },
  ]);
  return { orgs: distinct(rows[0]?.orgs), events: rows[0]?.count ?? 0 };
}

/**
 * The upgrade path, org-denominated. The last stage counts organisations whose
 * FIRST paid subscription was created in the window: free organisations have no
 * Subscription document at all (billingController synthesises the free plan),
 * and the document is unique per org, so createdAt is the moment that org
 * started paying. Paid-to-paid plan changes update the same document and are
 * deliberately not counted here — this funnel is about converting, not expanding.
 */
async function getUpgradeFunnel(from, to) {
  const [walls, clicks, checkouts, converted] = await Promise.all([
    orgsForEvents(['quota_denied'], from, to),
    orgsForEvents(['upgrade_clicked'], from, to),
    orgsForEvents(['checkout_started'], from, to),
    Subscription.distinct('organizationId', {
      createdAt: { $gte: from, $lt: to },
      planId: { $ne: 'free' },
    }),
  ]);

  return {
    denom: 'organizations',
    stages: [
      { label: 'Hit a wall', lane: 'server', orgs: walls.orgs, events: walls.events },
      { label: 'Clicked upgrade', lane: 'client', orgs: clicks.orgs, events: clicks.events },
      { label: 'Started checkout', lane: 'client', orgs: checkouts.orgs, events: checkouts.events },
      {
        label: 'Subscribed',
        lane: 'server',
        orgs: converted.filter(Boolean).length,
        events: converted.filter(Boolean).length,
      },
    ],
  };
}

/**
 * Where conversions came from. Two views of the same journey: intent (the
 * surface stamped on checkout_started, client-lane and raw-only) and revenue
 * (the surface persisted on the Subscription, server-lane and durable).
 */
async function getSurfaces(from, to) {
  const [intentRows, subs] = await Promise.all([
    ObservationEvent.aggregate([
      { $match: { createdAt: { $gte: from, $lt: to }, event: 'checkout_started', impersonatedBy: null } },
      { $group: { _id: '$payload.surface', count: { $sum: 1 }, orgs: { $addToSet: '$organizationId' } } },
      { $sort: { count: -1 } },
    ]),
    Subscription.aggregate([
      { $match: { createdAt: { $gte: from, $lt: to }, planId: { $ne: 'free' } } },
      { $group: { _id: '$surface', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const subscribedBySurface = new Map(subs.map((s) => [s._id || '(not captured)', s.count]));
  const surfaces = new Set([
    ...intentRows.map((r) => r._id || '(unattributed)'),
    ...subscribedBySurface.keys(),
  ]);

  return [...surfaces].map((surface) => ({
    surface,
    checkoutsStarted: intentRows.find((r) => (r._id || '(unattributed)') === surface)?.count ?? 0,
    orgsStartingCheckout: distinct(intentRows.find((r) => (r._id || '(unattributed)') === surface)?.orgs),
    subscribed: subscribedBySurface.get(surface) ?? 0,
  })).sort((a, b) => b.subscribed - a.subscribed || b.checkoutsStarted - a.checkoutsStarted);
}

/**
 * Weekly consent split — the denominator that says how much of the client lane
 * we are allowed to see at all.
 *
 * NOTE (deviation from the plan's Phase 3 sketch): this reads RAW events, not
 * the rollups. ObservationDailyRollup is keyed by event name and carries no
 * payload, so accepted-vs-declined cannot be recovered from it — the split
 * would need its own rollup events. Raw-only means the 90-day horizon applies.
 */
async function getConsentTrend(from, to) {
  const rows = await ObservationEvent.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, event: 'consent_choice', impersonatedBy: null } },
    {
      $group: {
        _id: {
          week: { $dateTrunc: { date: '$createdAt', unit: 'week' } },
          accepted: '$payload.analytics',
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.week': 1 } },
  ]);

  const byWeek = new Map();
  for (const r of rows) {
    const key = r._id.week?.toISOString() ?? 'unknown';
    const entry = byWeek.get(key) ?? { week: r._id.week, accepted: 0, declined: 0 };
    if (r._id.accepted === true) entry.accepted += r.count;
    else entry.declined += r.count;
    byWeek.set(key, entry);
  }
  return [...byWeek.values()];
}

async function getConversion({ days = 28, from: rawFrom, to: rawTo } = {}) {
  const range = resolveRange({ days, from: rawFrom, to: rawTo, source: 'raw' });
  const { from, to } = range;

  const [walls, funnel, surfaces, consentTrend] = await Promise.all([
    getWalls(from, to),
    getUpgradeFunnel(from, to),
    getSurfaces(from, to),
    getConsentTrend(from, to),
  ]);

  return {
    days: range.days,
    range,
    // Every panel here except the funnel's last stage is payload-dimensioned
    // and therefore bounded by the raw TTL; the UI and export say so.
    rawHorizonDays: RAW_HORIZON_DAYS,
    walls,
    funnel,
    surfaces,
    consentTrend,
  };
}

module.exports = { getConversion, getWalls, getUpgradeFunnel, getSurfaces, getConsentTrend };
