'use strict';

/**
 * Wave 5 Phase 3 — conversion analytics (plan §9).
 *
 * The claims worth pinning: the funnel's last stage reads the no-TTL
 * Subscription collection rather than the 180-day audit lane (F3), the whole
 * funnel is org-denominated so its stages compare like with like, walls keep
 * the payload dimensions that make them actionable, and impersonation is
 * excluded everywhere as in every other analytics read.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const ObservationEvent = require('../src/models/ObservationEvent');
const Subscription = require('../src/models/Subscription');
const { getConversion } = require('../src/services/conversionAnalyticsService');

const DAY_MS = 24 * 60 * 60 * 1000;
const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

async function ev(event, { org = null, user = null, ago = 1, impersonatedBy = null, payload = {} } = {}) {
  const createdAt = new Date(Date.now() - ago * DAY_MS);
  await ObservationEvent.collection.insertOne({
    event, userId: user, organizationId: org, workspaceNumber: null,
    impersonatedBy, payload, createdAt, updatedAt: createdAt,
  });
}

async function sub(org, { planId = 'standard-monthly', ago = 1, surface = null } = {}) {
  const createdAt = new Date(Date.now() - ago * DAY_MS);
  await Subscription.collection.insertOne({
    organizationId: org, planId, status: 'active', surface,
    stripeSubscriptionId: `sub_${String(org)}`, createdAt, updatedAt: createdAt,
  });
}

test('walls keep the payload dimensions that make them actionable', async () => {
  const org = oid(); const user = oid();
  await ev('quota_denied', { org, user, payload: { action: 'analyze', tier: 'free', limitKey: 'maxAnalyses', scope: 'org' } });
  await ev('quota_denied', { org, user, payload: { action: 'analyze', tier: 'free', limitKey: 'maxAnalyses', scope: 'org' } });
  // A paid org denied on a free lifetime slot must stay distinguishable (W5).
  await ev('quota_denied', { org, user, payload: { action: 'article', tier: 'standard', quotaSource: 'free', limitKey: 'freeArticles', scope: 'org' } });

  const { walls } = await getConversion({ days: 7 });
  const analyze = walls.find((w) => w.action === 'analyze');
  assert.equal(analyze.denials, 2);
  assert.equal(analyze.orgs, 1);
  assert.equal(analyze.quotaSource, 'plan', 'a plan ceiling is not a free slot');

  const freeSlot = walls.find((w) => w.action === 'article');
  assert.equal(freeSlot.tier, 'standard', 'the org tier stays real');
  assert.equal(freeSlot.quotaSource, 'free', 'the slot distinction survives');
});

test('the funnel is org-denominated across every stage', async () => {
  const org = oid(); const u1 = oid(); const u2 = oid();
  // Two users of the SAME org hitting walls is one organisation, not two.
  await ev('quota_denied', { org, user: u1, payload: {} });
  await ev('quota_denied', { org, user: u2, payload: {} });
  await ev('upgrade_clicked', { org, user: u1, payload: {} });
  await ev('checkout_started', { org, user: u1, payload: { surface: 'editor' } });
  await sub(org, { surface: 'editor' });

  const { funnel } = await getConversion({ days: 7 });
  assert.equal(funnel.denom, 'organizations');
  assert.deepEqual(funnel.stages.map((s) => s.orgs), [1, 1, 1, 1]);
  assert.equal(funnel.stages[0].events, 2, 'but both denial events are still counted');
});

test('the last stage reads Subscription, not the audit lane (F3)', async () => {
  const org = oid();
  // No observation event and no audit row — only the durable subscription.
  await sub(org, { ago: 2 });
  const { funnel } = await getConversion({ days: 7 });
  assert.equal(funnel.stages[3].label, 'Subscribed');
  assert.equal(funnel.stages[3].orgs, 1);
});

test('free organisations are not counted as conversions', async () => {
  await sub(oid(), { planId: 'free' });
  const { funnel } = await getConversion({ days: 7 });
  assert.equal(funnel.stages[3].orgs, 0);
});

test('subscriptions created outside the window are not counted', async () => {
  await sub(oid(), { ago: 40 });
  const { funnel } = await getConversion({ days: 7 });
  assert.equal(funnel.stages[3].orgs, 0);
});

test('every stage declares its lane so inversions can be explained', async () => {
  const { funnel } = await getConversion({ days: 7 });
  assert.deepEqual(funnel.stages.map((s) => s.lane), ['server', 'client', 'client', 'server']);
});

test('a client stage reading lower than the server stage after it is representable', async () => {
  const org = oid();
  // The consent gate can hide the click while the subscription still lands.
  await ev('quota_denied', { org, payload: {} });
  await sub(org);
  const { funnel } = await getConversion({ days: 7 });
  assert.equal(funnel.stages[1].orgs, 0, 'no click seen');
  assert.equal(funnel.stages[3].orgs, 1, 'yet the conversion is real');
});

test('surface attribution pairs intent with revenue', async () => {
  const orgA = oid(); const orgB = oid();
  await ev('checkout_started', { org: orgA, payload: { surface: 'editor' } });
  await ev('checkout_started', { org: orgB, payload: { surface: 'pricing' } });
  await sub(orgA, { surface: 'editor' });
  await sub(orgB, { surface: null }); // predates capture

  const { surfaces } = await getConversion({ days: 7 });
  const editor = surfaces.find((s) => s.surface === 'editor');
  assert.equal(editor.checkoutsStarted, 1);
  assert.equal(editor.subscribed, 1);

  const uncaptured = surfaces.find((s) => s.surface === '(not captured)');
  assert.equal(uncaptured.subscribed, 1, 'missing attribution is named, not dropped');
});

test('impersonated activity is excluded from walls and funnel', async () => {
  const org = oid();
  await ev('quota_denied', { org, payload: { action: 'analyze' }, impersonatedBy: String(oid()) });
  await ev('upgrade_clicked', { org, impersonatedBy: String(oid()) });
  const { walls, funnel } = await getConversion({ days: 7 });
  assert.equal(walls.length, 0);
  assert.equal(funnel.stages[0].orgs, 0);
  assert.equal(funnel.stages[1].orgs, 0);
});

test('consent trend splits accepted from declined by week', async () => {
  const u1 = oid(); const u2 = oid();
  await ev('consent_choice', { user: u1, payload: { analytics: true } });
  await ev('consent_choice', { user: u2, payload: { analytics: false } });

  const { consentTrend } = await getConversion({ days: 28 });
  const total = consentTrend.reduce((acc, w) => ({ a: acc.a + w.accepted, d: acc.d + w.declined }), { a: 0, d: 0 });
  assert.equal(total.a, 1);
  assert.equal(total.d, 1);
});

test('the response reports the raw horizon it is bounded by', async () => {
  const r = await getConversion({ days: 365 });
  assert.equal(r.rawHorizonDays, 90);
  assert.equal(r.range.truncated, true, 'a 365-day ask must not pretend to be covered');
});
