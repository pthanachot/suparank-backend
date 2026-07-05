const mongoose = require('mongoose');

/**
 * ClientSubscription (Phase 16) — a client's paid subscription to an AgencyPlan.
 *
 * Money flows to the AGENCY'S connected Stripe account (Connect Standard); this
 * subscription never touches the platform credit system. The Stripe objects
 * (`stripeSubscriptionId`, `stripeCustomerId`) live ON THE CONNECTED ACCOUNT.
 * `connectedAccountId` is denormalized from the agency Organization so Connect
 * webhooks (which carry `event.account`) can route to the right subscription
 * without an extra Organization lookup.
 *
 * Conceptually one subscription per workspace, but `workspaceId` is intentionally
 * NOT unique: a workspace may have a canceled sub followed by a fresh one. The
 * "one ACTIVE subscription per workspace" invariant is enforced in application
 * logic (checkout / webhook workstreams), not by a DB constraint.
 */
const clientSubscriptionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
      // The AGENCY that owns the plan / connected account.
    },
    agencyPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AgencyPlan',
      required: true,
    },
    stripeSubscriptionId: {
      type: String,
      default: null,
      // Subscription id ON the connected account. unique+sparse index below.
    },
    stripeCustomerId: {
      type: String,
      default: null,
      // Customer id ON the connected account.
    },
    connectedAccountId: {
      type: String,
      default: null,
      // Denormalized agency Stripe account id (acct_…) for webhook routing.
    },
    clientEmail: { type: String, default: null },
    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'paused'],
      default: 'incomplete',
    },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// workspaceId is already indexed via `index: true` on the field above.
clientSubscriptionSchema.index({ stripeSubscriptionId: 1 }, { unique: true, sparse: true });
clientSubscriptionSchema.index({ organizationId: 1, status: 1 });

module.exports = mongoose.model('ClientSubscription', clientSubscriptionSchema);
