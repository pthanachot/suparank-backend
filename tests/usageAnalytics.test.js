'use strict';

/**
 * Wave 4 — usage analytics service (dashboard v1 read-model).
 *
 * Covers: every funnel event name is registered (unregistered names silently
 * read as ZERO — the exact drift the registry exists to stop), stage-reach
 * actor math (union dedupe across multi-event stages), denominator selection
 * (users vs workspaces), impersonation exclusion, overview lanes/consent, and
 * the rollup-backed series.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const ObservationEvent = require('../src/models/ObservationEvent');
const ObservationDailyRollup = require('../src/models/ObservationDailyRollup');
const { ALLOWED_EVENTS } = require('../src/config/analyticsEvents');
const { getOverview, getFunnels, getSeries, FUNNELS } = require('../src/services/usageAnalyticsService');

const oid = () => new mongoose.Types.ObjectId();
const DAY_MS = 24 * 60 * 60 * 1000;

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

async function seed(event, { userId = null, ws = null, ago = 1, impersonatedBy = null, payload = {} } = {}) {
  const createdAt = new Date(Date.now() - ago * DAY_MS);
  await ObservationEvent.collection.insertOne({
    event, userId, workspaceNumber: ws, organizationId: null,
    impersonatedBy, payload, createdAt, updatedAt: createdAt,
  });
}

test('every funnel stage/annotation event is registered (zero-read drift guard)', () => {
  for (const f of FUNNELS) {
    for (const s of [...f.stages, ...(f.annotations ?? [])]) {
      for (const e of s.events) {
        assert.ok(ALLOWED_EVENTS.has(e), `${f.id} → "${e}" is not in the registry — it would silently read 0`);
      }
    }
  }
});

test('stage-reach: multi-event stages union-dedupe actors; denom picks the actor field', async () => {
  const u1 = oid(); const u2 = oid();
  // Editor funnel (denom users): u1 engages via chat AND slash — one actor.
  await seed('editor_opened', { userId: u1, ws: 1 });
  await seed('editor_opened', { userId: u2, ws: 1 });
  await seed('ai_chat_message_sent', { userId: u1, ws: 1 });
  await seed('slash_command_run', { userId: u1, ws: 1 });
  await seed('ai_edit_applied', { userId: u1, ws: 1 });
  // Keywords funnel (denom workspaces): same user across two workspaces = 2 actors.
  await seed('keyword_search', { userId: u1, ws: 7 });
  await seed('keyword_search', { userId: u1, ws: 8 });

  const { funnels, mode } = await getFunnels({ days: 7 });
  assert.equal(mode, 'stage-reach');

  const editor = funnels.find((f) => f.id === 'editor');
  assert.equal(editor.stages[0].actors, 2, 'two users opened');
  assert.equal(editor.stages[1].actors, 1, 'chat+slash by the same user = ONE engaged actor');
  assert.equal(editor.stages[1].events, 2, 'but two raw events');
  assert.equal(editor.stages[2].actors, 1);

  const keywords = funnels.find((f) => f.id === 'keywords');
  assert.equal(keywords.stages[0].actors, 2, 'workspace denominator: one user, two workspaces = 2');
});

test('impersonated events are excluded from funnels and overview', async () => {
  const u1 = oid();
  await seed('editor_opened', { userId: u1, ws: 1 });
  await seed('editor_opened', { userId: u1, ws: 1, impersonatedBy: String(oid()) });

  const { funnels } = await getFunnels({ days: 7 });
  assert.equal(funnels.find((f) => f.id === 'editor').stages[0].events, 1);

  const overview = await getOverview({ days: 7 });
  assert.equal(overview.current.events, 1);
});

test('overview: window stats, prior window, lanes, consent, topEvents', async () => {
  const u1 = oid(); const u2 = oid();
  await seed('editor_opened', { userId: u1, ws: 1, ago: 1 });          // client lane
  await seed('keyword_search', { userId: u2, ws: 2, ago: 2 });         // server lane
  await seed('editor_opened', { userId: u1, ws: 1, ago: 10 });         // prior window (days=7)
  await seed('consent_choice', { userId: u1, payload: { analytics: true }, ago: 1 });
  await seed('consent_choice', { userId: u2, payload: { analytics: false }, ago: 1 });
  // V4-2: an impersonating admin's banner choice must not pollute the denominator.
  await seed('consent_choice', { userId: u1, payload: { analytics: true }, ago: 1, impersonatedBy: String(oid()) });

  const o = await getOverview({ days: 7 });
  assert.equal(o.current.activeWorkspaces, 2);
  assert.equal(o.current.activeUsers, 2);
  assert.equal(o.previous.events, 1, 'prior-window event counted separately');
  assert.equal(o.lanes.client >= 1, true);
  assert.equal(o.lanes.server >= 1, true);
  assert.deepEqual(o.consent, { accepted: 1, declined: 1 });
  assert.ok(o.topEvents.length >= 2);
  assert.ok(o.topEvents.every((t) => typeof t.event === 'string' && t.count > 0));
});

test('series reads the durable rollups (optionally filtered by event)', async () => {
  const day1 = new Date(Date.now() - 2 * DAY_MS);
  const day2 = new Date(Date.now() - 1 * DAY_MS);
  await ObservationDailyRollup.collection.insertMany([
    { day: day1, event: 'editor_opened', organizationId: null, workspaceNumber: 1, count: 5, uniqueUsers: 2, source: 'observation' },
    { day: day1, event: 'keyword_search', organizationId: null, workspaceNumber: 1, count: 3, uniqueUsers: 1, source: 'observation' },
    { day: day2, event: 'editor_opened', organizationId: null, workspaceNumber: 1, count: 4, uniqueUsers: 2, source: 'observation' },
    // V4-3: the AuditLog billing lane must NOT appear in "daily events".
    { day: day1, event: 'billing.plan_change', organizationId: null, workspaceNumber: null, count: 99, uniqueUsers: 1, source: 'audit' },
  ]);

  const all = await getSeries({ days: 7 });
  assert.equal(all.series.length, 2);
  assert.deepEqual(all.series.map((s) => s.count), [8, 4]);

  const one = await getSeries({ days: 7, event: 'editor_opened' });
  assert.deepEqual(one.series.map((s) => s.count), [5, 4]);
});
