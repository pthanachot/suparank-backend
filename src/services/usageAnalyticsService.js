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
    // count only, never an actor stage.
    annotations: [{ label: 'End-client opens', events: ['report_share_opened'] }],
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

async function getOverview({ days = 28 } = {}) {
  const now = new Date();
  const from = since(days);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);

  const [current, previous, byEvent, consentRows] = await Promise.all([
    windowStats(from, now),
    windowStats(prevFrom, from),
    ObservationEvent.aggregate([
      { $match: { createdAt: { $gte: from }, impersonatedBy: null } },
      { $group: { _id: '$event', count: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      { $sort: { count: -1 } },
    ]),
    ObservationEvent.aggregate([
      { $match: { createdAt: { $gte: from }, event: 'consent_choice' } },
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
    days,
    current,
    previous,
    lanes,
    // The [C]-lane correction denominator (F1): what share of choosing users
    // the client lane can even see. Signed-in choices only.
    consent,
    topEvents: byEvent.slice(0, 12).map((r) => ({
      event: r._id,
      lane: EVENTS[r._id]?.lane || 'unknown',
      count: r.count,
      users: (r.users || []).filter(Boolean).length,
    })),
  };
}

async function getFunnels({ days = 28 } = {}) {
  const from = since(days);
  const results = [];
  for (const f of FUNNELS) {
    const allEvents = [
      ...new Set(f.stages.flatMap((s) => s.events).concat((f.annotations ?? []).flatMap((a) => a.events))),
    ];
    const actorField = f.denom === 'workspaces' ? '$workspaceNumber' : '$userId';
    const rows = await ObservationEvent.aggregate([
      { $match: { createdAt: { $gte: from }, event: { $in: allEvents }, impersonatedBy: null } },
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
      annotations: (f.annotations ?? []).map((a) => ({ label: a.label, actors: actorCount(a.events), events: eventCount(a.events) })),
    });
  }
  return { days, mode: 'stage-reach', funnels: results };
}

/** Daily activity series from the durable rollups (optionally one event). */
async function getSeries({ days = 28, event = null } = {}) {
  const from = since(days);
  const match = { day: { $gte: from } };
  if (event) match.event = event;
  const rows = await ObservationDailyRollup.aggregate([
    { $match: match },
    { $group: { _id: '$day', count: { $sum: '$count' } } },
    { $sort: { _id: 1 } },
  ]);
  return { days, event, series: rows.map((r) => ({ day: r._id, count: r.count })) };
}

module.exports = { getOverview, getFunnels, getSeries, FUNNELS };
