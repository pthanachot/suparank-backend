/**
 * Schema-default tests for the Phase 16 agency-billing models. Mongoose applies
 * schema defaults on document construction, so these assert defaults/enums with
 * no database connection.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AgencyPlan = require('../src/models/AgencyPlan');
const ClientSubscription = require('../src/models/ClientSubscription');

describe('AgencyPlan schema defaults', () => {
  it('applies currency, interval, trial, active and null limits', () => {
    const plan = new AgencyPlan({
      organizationId: new mongoose.Types.ObjectId(),
      name: 'Starter',
      amount: 4900, // cents = $49.00
    });

    assert.equal(plan.amount, 4900); // stored in CENTS
    assert.equal(plan.currency, 'usd');
    assert.equal(plan.interval, 'month');
    assert.equal(plan.trialDays, 0);
    assert.equal(plan.active, true);
    assert.equal(plan.stripeProductId, null);
    assert.equal(plan.stripePriceId, null);

    // limits: null everywhere = unlimited
    assert.equal(plan.limits.maxArticlesPerMonth, null);
    assert.equal(plan.limits.maxAiTrackerPromptsPerMonth, null);
    assert.equal(plan.limits.maxKeywordLookupsPerMonth, null);
    assert.equal(plan.limits.creditsPerMonth, null);
    assert.equal(plan.limits.maxSeats, null);
  });

  it('lowercases currency and validates interval enum', () => {
    const plan = new AgencyPlan({
      organizationId: new mongoose.Types.ObjectId(),
      name: 'Yearly',
      amount: 0,
      currency: 'EUR',
      interval: 'year',
    });
    assert.equal(plan.currency, 'eur');
    assert.equal(plan.interval, 'year');

    plan.interval = 'week';
    const err = plan.validateSync();
    assert.ok(err && err.errors.interval, 'invalid interval should fail validation');
  });
});

describe('ClientSubscription schema defaults', () => {
  it('defaults status to incomplete with the right flags', () => {
    const sub = new ClientSubscription({
      workspaceId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
      agencyPlanId: new mongoose.Types.ObjectId(),
    });

    assert.equal(sub.status, 'incomplete');
    assert.equal(sub.cancelAtPeriodEnd, false);
    assert.equal(sub.stripeSubscriptionId, null);
    assert.equal(sub.stripeCustomerId, null);
    assert.equal(sub.connectedAccountId, null);
    assert.equal(sub.currentPeriodEnd, null);
    assert.equal(sub.canceledAt, null);
  });

  it('rejects a status outside the enum', () => {
    const sub = new ClientSubscription({
      workspaceId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
      agencyPlanId: new mongoose.Types.ObjectId(),
      status: 'expired',
    });
    const err = sub.validateSync();
    assert.ok(err && err.errors.status, 'invalid status should fail validation');
  });
});
