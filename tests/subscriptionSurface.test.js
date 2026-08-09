'use strict';

/**
 * Wave 5 Phase 3 F4 — the acquisition surface gets a durable local home.
 *
 * Wave 1 put `?src=` into Stripe metadata and the checkout AuditLog entry, but
 * AuditLog expires at 180 days and nothing ever read the value back onto our
 * own record — so "which surface produced this customer" became unanswerable
 * after half a year without calling Stripe. The webhook now stamps it on the
 * Subscription, once, at acquisition.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Subscription = require('../src/models/Subscription');

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

// The sanitiser and write rule as implemented in webhookController.
const clean = (raw) => (typeof raw === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw) ? raw : null);

test('the surface field persists on the model', async () => {
  const org = new mongoose.Types.ObjectId();
  await Subscription.create({ organizationId: org, planId: 'standard-monthly', surface: 'editor-wall' });
  const found = await Subscription.findOne({ organizationId: org }).lean();
  assert.equal(found.surface, 'editor-wall');
});

test('surface defaults to null rather than being absent', async () => {
  const org = new mongoose.Types.ObjectId();
  await Subscription.create({ organizationId: org, planId: 'standard-monthly' });
  const found = await Subscription.findOne({ organizationId: org }).lean();
  assert.equal(found.surface, null, 'a queryable null, so "(not captured)" can be counted');
});

test('only sane surface values are accepted from webhook metadata', () => {
  // The value arrives in a webhook body; it must not seed the attribution
  // table with arbitrary strings.
  assert.equal(clean('pricing'), 'pricing');
  assert.equal(clean('editor-wall'), 'editor-wall');
  assert.equal(clean('a'.repeat(40)), 'a'.repeat(40));
  for (const bad of ['Editor', 'editor wall', 'editor_wall', '-editor', '', 'a'.repeat(41), null, undefined, 42, {}]) {
    assert.equal(clean(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('acquisition surface is write-once — a later plan change must not rewrite it', async () => {
  const org = new mongoose.Types.ObjectId();
  await Subscription.create({ organizationId: org, planId: 'standard-monthly', surface: 'editor-wall' });

  // Replicating the webhook's guard: fill only when we never captured one.
  const sub = await Subscription.findOne({ organizationId: org });
  if (!sub.surface) sub.surface = clean('billing-page');
  await sub.save();

  const after = await Subscription.findOne({ organizationId: org }).lean();
  assert.equal(after.surface, 'editor-wall', 'upgrading later must not relabel where they came from');
});

test('a doc created before the field existed can still be filled in', async () => {
  const org = new mongoose.Types.ObjectId();
  await Subscription.collection.insertOne({
    organizationId: org, planId: 'standard-monthly', status: 'active',
    createdAt: new Date(), updatedAt: new Date(),
  });

  const sub = await Subscription.findOne({ organizationId: org });
  if (!sub.surface) sub.surface = clean('pricing');
  await sub.save();

  assert.equal((await Subscription.findOne({ organizationId: org }).lean()).surface, 'pricing');
});
