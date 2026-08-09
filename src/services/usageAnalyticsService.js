'use strict';

/**
 * Usage analytics service (Wave 4, plan §7 — dashboard v1).
 *
 * Read-model over ObservationEvent (raw, ≤90d) and ObservationDailyRollup
 * (durable) powering the admin Usage tab. Impersonated rows are excluded in
 * every query.
 *
 * FUNNELS are STAGE-REACH funnels: distinct actors emitting each stage's
 * event(s) inside the window — NOT per-actor sequencing (an actor who fired
 * stage 3 without stage 1 still counts in stage 3). Honest for "how far does
 * usage reach into each tool"; strict conversion sequencing is a later
 * refinement and the UI labels this explicitly. Stage events must exist in
 * the analytics registry — unregistered names would silently read as zero,
 * so a test pins every name against ALLOWED_EVENTS.
 */

const ObservationEvent = require('../models/ObservationEvent');
const ObservationDailyRollup = require('../models/ObservationDailyRollup');
const { EVENTS } = require('../config/analyticsEvents');

const DAY_MS = 24 * 60 * 60 * 1000;

// Denominators are deliberate per tool (plan §7.1): editing is individual
// craft (users); research/tracker/GSC are workspace resources.
const FUNNELS = [
  {
    id: 'editor', title: 'Editor / AI Writing', denom: 'users',
    stages: [
      { label: 'Opened editor', events: ['editor_opened'] },
      { label: 'Engaged AI', events: ['ai_chat_message_sent', 'slash_command_run', 'inline_action_used'] },
      { label: 'Edit applied', events: ['ai_edit_applied', 'inline_action_applied'] },
    ],
    annotations: [
      { label: 'Reverted (regret)', events: ['ai_edit_reverted', 'inline_action_reverted'] },
      { label: 'Stopped a run', events: ['ai_run_stopped_by_user'] },
    ],
  },
  {
    id: 'onboarding', title: 'Onboarding', denom: 'users',
    stages: [
      { label: 'Engaged questions', events: ['onboarding_answer_selected'] },
      { label: 'Completed', events: ['onboarding_completed'] },
      { label: 'First workspace action', events: ['editor_opened', 'keyword_search', 'tracker_setup_step_reached', 'gsc_connect_clicked', 'ai_chat_message_sent'] },
    ],
    annotations: [{ label: 'Skipped', events: ['onboarding_skipped'] }],
  },
  {
    id: 'keywords', title: 'Keyword Research', denom: 'workspaces',
    stages: [
      { label: 'Searched', events: ['keyword_search'] },
      { label: 'Opened a detail', events: ['keyword_detail_opened'] },
      { label: 'Acted (export / → article)', events: ['keyword_exported', 'keyword_to_article_clicked'] },
    ],
  },
  {
    id: 'tracker', title: 'AI Tracker', denom: 'workspaces',
    stages: [
      { label: 'Setup reached', events: ['tracker_setup_step_reached'] },
      { label: 'Setup completed', events: ['suggested_prompts_accepted'] },
      { label: 'Worked with results', events: ['engine_filter_toggled', 'tracker_export_downloaded'] },
    ],
  },
  {
    id: 'gsc', title: 'Sites / GSC', denom: 'workspaces',
    stages: [
      { label: 'Connect clicked', events: ['gsc_connect_clicked'] },
      { label: 'Explored', events: ['site_tab_viewed'] },
      { label: 'Acted (export / optimize)', events: ['csv_exported', 'opportunity_optimize_clicked'] },
    ],
  },
  {
    id: 'reports', title: 'Client Reports', denom: 'users',
    stages: [
      { label: 'Viewed in-app', events: ['report_viewed'] },
      { label: 'Exported PDF', events: ['report_pdf_exported'] },
    ],
    // share opens carry no user identity (logged-out end clients) — event
    // count only, never an actor stage. countOnly tells the UI to render the
    // event count (V4-4: keying on the label string was silent-breakage bait).
    annotations: [{ label: 'End-client opens', events: ['report_share_opened'], countOnly: true }],
  },
  {
    id: 'conversion', title: 'Free → Paid intent', denom: 'users',
    stages: [
      { label: 'Hit a wall (denied)', events: ['quota_denied'] },
      { label: 'Upgrade clicked', events: ['upgrade_clicked'] },
      { label: 'Checkout started', events: ['checkout_started'] },
    ],
  },
];

function since(days) {
  return new Date(Date.now() - days * DAY_MS);
}

// Raw ObservationEvent TTLs at 90 days; ObservationDailyRollup never expires.
// A window is therefore only "complete" for raw-backed panels if it starts
// inside the horizon — see resolveRange.
const RAW_HORIZON_DAYS = 90;

/**
 * Resolve a requested window into concrete bounds plus honest coverage info
 * (Wave 5 Phase 2, plan §9.0).
 *
 * `source` decides the horizon, NOT the request: 'rollup' panels serve any
 * range because the rollups have no TTL; 'raw' panels can only see the last
 * RAW_HORIZON_DAYS, so a longer request is clamped and reported as partial
 * rather than silently under-reporting.
 *
 * Throws RangeError on invalid input so the controller can answer 400 — a
 * malformed date must not quietly fall back to a default window and hand the
 * caller numbers for a period they didn't ask about.
 */
function resolveRange({ days, from, to, source = 'raw', now = new Date() } = {}) {
  let start;
  let end = now;

  if (from != null || to != null) {
    if (from == null || to == null) throw new RangeError('from and to must be supplied together');
    start = new Date(from);
    end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new RangeError('from and to must be ISO dates');
    }
    if (start >= end) throw new RangeError('from must be before to');
    // A window ending in the future isn't wrong, it's just empty out there.
    if (end > now) end = now;
    if (start >= end) throw new RangeError('from must be in the past');
  } else {
    const d = Math.max(1, Math.min(3650, parseInt(days, 10) || 28));
    start = new Date(end.getTime() - d * DAY_MS);
  }

  const requestedFrom = start;
  const horizonStart = new Date(now.getTime() - RAW_HORIZON_DAYS * DAY_MS);
  const truncated = source === 'raw' && requestedFrom < horizonStart;
  if (truncated) start = horizonStart;

  return {
    from: start,
    to: end,
    requestedFrom,
    days: Math.max(1, Math.round((end - start) / DAY_MS)),
    source,
    // The UI hatches the uncovered span and the export writes a `partial:` note.
    truncated,
    rawAvailableFrom: source === 'raw' ? horizonStart : null,
  };
}

/** Distinct-actor + volume snapshot for one time window. */
async function windowStats(from, to) {
  const rows = await ObservationEvent.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, impersonatedBy: null } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        workspaces: { $addToSet: '$workspaceNumber' },
        users: { $addToSet: '$userId' },
      },
    },
  ]);
  const r = rows[0];
  return {
    events: r?.total ?? 0,
    activeWorkspaces: (r?.workspaces ?? []).filter((w) => w != null).length,
    activeUsers: (r?.users ?? []).filter(Boolean).length,
  };
}

async function getOverview({ days = 28, from: rawFrom, to: rawTo } = {}) {
  const range = resolveRange({ days, from: rawFrom, to: rawTo, source: 'raw' });
  const { from, to } = range;
  // The comparison window is the same length immediately before this one, so a
  // custom range compares like-for-like rather than against a fixed 28 days.
  const span = to - from;
  const prevFrom = new Date(from.getTime() - span);

  const [current, previous, byEvent, consentRows] = await Promise.all([
    windowStats(from, to),
    windowStats(prevFrom, from),
    ObservationEvent.aggregate([
      { $match: { createdAt: { $gte: from, $lt: to }, impersonatedBy: null } },
      { $group: { _id: '$event', count: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      { $sort: { count: -1 } },
    ]),
    ObservationEvent.aggregate([
      // V4-2 review fix: same impersonation filter as every other query —
      // this is the one metric whose entire job is precision about who is
      // being counted, and it was the only aggregation missing the filter.
      { $match: { createdAt: { $gte: from, $lt: to }, event: 'consent_choice', impersonatedBy: null } },
      { $group: { _id: '$payload.analytics', count: { $sum: 1 } } },
    ]),
  ]);

  const lanes = { client: 0, server: 0, unknown: 0 };
  for (const r of byEvent) {
    const lane = EVENTS[r._id]?.lane || 'unknown';
    lanes[lane] = (lanes[lane] || 0) + r.count;
  }

  const consent = { accepted: 0, declined: 0 };
  for (const r of consentRows) {
    if (r._id === true) consent.accepted += r.count;
    else consent.declined += r.count;
  }

  return {
    days: range.days,
    range,
    current,
    previous,
    lanes,
    // The [C]-lane correction denominator (F1): what share of choosing users
    // the client lane can even see. Signed-in choices only.
    consent,
    // Every event, sorted desc — the UI slices for display, but the Copy-for-AI
    // export must carry the full table (§9 Phase 2), and it reads this object
    // rather than re-fetching. Bounded by the registry size, so it stays small.
    topEvents: byEvent.map((r) => ({
      event: r._id,
      lane: EVENTS[r._id]?.lane || 'unknown',
      count: r.count,
      users: (r.users || []).filter(Boolean).length,
    })),
  };
}

async function getFunnels({ days = 28, from: rawFrom, to: rawTo } = {}) {
  const range = resolveRange({ days, from: rawFrom, to: rawTo, source: 'raw' });
  const { from, to } = range;
  const results = [];
  for (const f of FUNNELS) {
    const allEvents = [
      ...new Set(f.stages.flatMap((s) => s.events).concat((f.annotations ?? []).flatMap((a) => a.events))),
    ];
    const actorField = f.denom === 'workspaces' ? '$workspaceNumber' : '$userId';
    const rows = await ObservationEvent.aggregate([
      { $match: { createdAt: { $gte: from, $lt: to }, event: { $in: allEvents }, impersonatedBy: null } },
      { $group: { _id: '$event', actors: { $addToSet: actorField }, count: { $sum: 1 } } },
    ]);
    const byEvent = new Map(rows.map((r) => [r._id, r]));
    const actorCount = (events) => {
      const s = new Set();
      for (const e of events) {
        for (const a of byEvent.get(e)?.actors ?? []) if (a != null) s.add(String(a));
      }
      return s.size;
    };
    const eventCount = (events) => events.reduce((n, e) => n + (byEvent.get(e)?.count ?? 0), 0);
    results.push({
      id: f.id,
      title: f.title,
      denom: f.denom,
      stages: f.stages.map((s) => ({ label: s.label, actors: actorCount(s.events), events: eventCount(s.events) })),
      annotations: (f.annotations ?? []).map((a) => ({
        label: a.label,
        actors: actorCount(a.events),
        events: eventCount(a.events),
        ...(a.countOnly ? { countOnly: true } : {}),
      })),
    });
  }
  return { days: range.days, range, mode: 'stage-reach', funnels: results };
}

/** Daily activity series from the durable rollups (optionally one event). */
async function getSeries({ days = 28, event = null, from: rawFrom, to: rawTo } = {}) {
  // source:'rollup' — these rows never expire, so this panel honours any
  // requested range instead of being clamped to the raw 90-day horizon.
  const range = resolveRange({ days, from: rawFrom, to: rawTo, source: 'rollup' });
  // V4-3 review fix: the rollup collection also carries the AuditLog
  // billing/lifecycle lane (source:'audit') — "daily events" must not quietly
  // include billing bookkeeping. The audit lane gets its own view later.
  const match = { day: { $gte: range.from, $lt: range.to }, source: 'observation' };
  if (event) match.event = event;
  const rows = await ObservationDailyRollup.aggregate([
    { $match: match },
    { $group: { _id: '$day', count: { $sum: '$count' } } },
    { $sort: { _id: 1 } },
  ]);
  return { days: range.days, range, event, series: rows.map((r) => ({ day: r._id, count: r.count })) };
}

module.exports = { getOverview, getFunnels, getSeries, resolveRange, FUNNELS, RAW_HORIZON_DAYS };
