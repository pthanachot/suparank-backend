/**
 * Tenant lifecycle service (Phase 18A) — agency offboarding state machine.
 *
 * When an agency cancels or downgrades off the agency tier it loses its
 * white-label / SaaS entitlement. Rather than yank the rug on the agency's own
 * paying clients, we run a graceful offboarding:
 *
 *   active ──(entitlement lost, has live clients)──▶ winding_down
 *   winding_down ──(re-subscribes within grace)────▶ active        (recover)
 *   winding_down ──(GRACE_DAYS elapse)─────────────▶ suspended     (teardown)
 *
 * On suspend the tenant surface is torn down — custom domains deactivated (so a
 * suspended agency's branded host stops resolving), brand reverts to the platform
 * default, client workspaces are locked, and client subscriptions on the agency's
 * connected account are cancelled — but DATA IS RETAINED (RETENTION_DAYS) for
 * export/restore before it becomes purge-eligible (Phase 18C).
 *
 * DARK-SAFE: every entry point (reconcile / startWindDown / runDueSuspensions)
 * short-circuits unless `saasMode` is live. With the flag dark no org ever leaves
 * 'active', so every lifecycle gate elsewhere (signup blocking, access) is inert
 * and the system is byte-identical to pre-Phase-18. Recovery is deliberately NOT
 * flag-gated (restoring a stuck org to 'active' must always be possible).
 */

const Organization = require('../models/Organization');
const ClientSubscription = require('../models/ClientSubscription');
const Workspace = require('../models/Workspace');
const Domain = require('../models/Domain');
const Subscription = require('../models/Subscription');
const flagService = require('./flagService');
const brandService = require('./brandService');
const domainService = require('./domainService');
const auditService = require('./auditService');
const stripeService = require('./stripeService');
const cloudflareService = require('./cloudflareService');
const { sendEmail } = require('../utils/emailService');

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 30; // winding_down → suspended
const RETENTION_DAYS = 90; // suspended → purge-eligible (Phase 18C)

// Client subs in one of these statuses are the ones worth cancelling on suspend.
const CANCELABLE_SUB_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'paused'];
// A sub in one of these statuses is a genuinely LIVE client (used by the trigger).
const LIVE_SUB_STATUSES = ['active', 'trialing', 'past_due'];

// ─── Predicate: does this agency actually have clients to offboard? ──

/**
 * True if the org has at least one client subscription OR one client-provisioned
 * workspace. Trigger scope decision (2026-07-06): an agency that subscribed but
 * never onboarded a client just loses entitlement quietly — no grace ceremony.
 */
async function hasLiveClientAssets(orgId) {
  const sub = await ClientSubscription.findOne({
    organizationId: orgId,
    status: { $in: LIVE_SUB_STATUSES },
  }).select('_id').lean();
  if (sub) return true;
  const ws = await Workspace.findOne({
    organizationId: orgId,
    clientProvisionedSubId: { $type: 'string' },
  }).select('_id').lean();
  return !!ws;
}

// ─── Transitions ────────────────────────────────────────────────────

/**
 * active → winding_down. Idempotent; no-ops when the flag is dark, the org is
 * already past 'active', or the agency has no live client assets.
 */
async function startWindDown(orgId, reason = 'entitlement_lost') {
  if (!(await flagService.isFlagLive('saasMode'))) return null;
  if (!(await hasLiveClientAssets(orgId))) return null; // nothing to offboard

  // Atomic claim active→winding_down. The conditional filter makes this
  // idempotent under concurrent webhooks: only the caller that flips the status
  // gets a non-null result and therefore notifies clients + audits exactly once.
  const now = new Date();
  const org = await Organization.findOneAndUpdate(
    { _id: orgId, lifecycleStatus: 'active' },
    {
      $set: {
        lifecycleStatus: 'winding_down',
        lifecycleReason: reason,
        windDownStartedAt: now,
        suspendAt: new Date(now.getTime() + GRACE_DAYS * DAY_MS),
        suspendedAt: null,
        purgeAt: null,
      },
    },
    { new: true }
  );
  if (!org) return null; // already offboarding, or a concurrent caller won the claim

  auditService.record({
    organizationId: orgId,
    action: 'lifecycle.wind_down_started',
    resourceId: orgId,
    meta: { reason, graceDays: GRACE_DAYS, suspendAt: org.suspendAt },
  });

  // Best-effort: tell the agency + their clients. Never blocks the transition.
  _notifyWindDown(org).catch((err) =>
    console.error('[lifecycle] wind-down notification failed:', err.message)
  );

  return org;
}

/**
 * winding_down → active. The agency re-subscribed within grace. Not flag-gated —
 * recovering a stuck org must always work.
 */
async function recover(orgId) {
  // Atomic claim winding_down→active (idempotent under concurrency).
  const org = await Organization.findOneAndUpdate(
    { _id: orgId, lifecycleStatus: 'winding_down' },
    { $set: { lifecycleStatus: 'active', lifecycleReason: null, windDownStartedAt: null, suspendAt: null } },
    { new: true }
  );
  if (!org) return null;

  auditService.record({
    organizationId: orgId,
    action: 'lifecycle.recovered',
    resourceId: orgId,
  });
  return org;
}

/**
 * winding_down → suspended. Grace expired: tear down the tenant surface but keep
 * the data. Each teardown step is isolated (one failure never blocks the others
 * or the status transition).
 */
async function suspend(orgId) {
  // Atomically claim the org into the transient 'suspending' state BEFORE any
  // teardown. Because recover() requires 'winding_down', once we hold 'suspending'
  // a concurrent re-subscribe can no longer flip the org back to 'active'
  // mid-teardown and strand cancelled subs / dead domains under an active org.
  // The {$in: [winding_down, suspending]} filter also re-claims a crashed
  // 'suspending' org so the cron can re-drive it.
  const claimed = await Organization.findOneAndUpdate(
    { _id: orgId, lifecycleStatus: { $in: ['winding_down', 'suspending'] } },
    { $set: { lifecycleStatus: 'suspending' } },
    { new: true }
  );
  if (!claimed) return null; // active / already suspended / gone → nothing to do

  // Teardown runs while 'suspending', and every step is idempotent, so a crash
  // leaves the org 'suspending' and the next runDueSuspensions re-drives it — a
  // partial teardown is never stranded. (Order-independent, each best-effort.)
  // Pessimistic default: if the cancel step THROWS we don't know what remains,
  // so hold 'suspending' and let the daily re-drive retry.
  let cancelsPendingRetry = 1;
  await _step('cancel client subscriptions', async () => { cancelsPendingRetry = await _cancelClientSubs(claimed); });
  await _step('lock client workspaces', () => _lockClientWorkspaces(orgId));
  await _step('deactivate custom domains', () => _deactivateDomains(orgId));
  await _step('revert brand', () => _revertBrand(orgId));

  // A transiently-failed Stripe cancel means a client sub is STILL BILLING. Do
  // not finalize — staying 'suspending' keeps the org in the daily re-drive,
  // which is the only thing that actually retries the cancel. (Everything else
  // is already torn down; the retry re-runs idempotent steps.)
  if (cancelsPendingRetry > 0) {
    console.error(`[lifecycle] suspend for org ${orgId} held in 'suspending' — ${cancelsPendingRetry} client sub cancel(s) pending retry`);
    return null;
  }

  // Finalize suspending→suspended. Under a concurrent suspend both run the
  // (idempotent) teardown but only the winner finalizes + audits. suspendAt is
  // cleared as hygiene (it has served its purpose; a stale past deadline on a
  // suspended org is a trap for any future sweep that forgets the status filter).
  const now = new Date();
  const done = await Organization.findOneAndUpdate(
    { _id: orgId, lifecycleStatus: 'suspending' },
    { $set: { lifecycleStatus: 'suspended', suspendAt: null, suspendedAt: now, purgeAt: new Date(now.getTime() + RETENTION_DAYS * DAY_MS) } },
    { new: true }
  );
  if (!done) return null;

  auditService.record({
    organizationId: orgId,
    action: 'lifecycle.suspended',
    resourceId: orgId,
    meta: { retentionDays: RETENTION_DAYS, purgeAt: done.purgeAt },
  });
  return done;
}

// ─── Reconcile-from-state (called after platform-billing changes) ───

/**
 * Reconcile an org's lifecycle from its CURRENT entitlement — the codebase's
 * preferred pattern over event deltas (mirrors reconcileWorkspaceLock). Called
 * after a platform subscription change re-evaluates the tier:
 *   entitled again while winding_down → recover
 *   entitled again while suspended    → restore (Phase 18D; reverses teardown)
 *   not entitled while active         → startWindDown (which self-gates on assets)
 */
async function reconcile(orgId) {
  if (!orgId) return;
  if (!(await flagService.isFlagLive('saasMode'))) return;

  const org = await Organization.findById(orgId).select('lifecycleStatus').lean();
  if (!org) return;

  const entitled = await brandService.isSaasModeEntitled(orgId);
  if (entitled && org.lifecycleStatus === 'winding_down') return recover(orgId);
  if (entitled && org.lifecycleStatus === 'suspended') {
    // A re-subscribe after suspension auto-restores the tenant (lazy-required to
    // avoid a load-order cycle). Purged orgs reactivate as a fresh shell.
    return require('./restoreService').restoreSuspendedOrg(orgId);
  }
  if (!entitled && org.lifecycleStatus === 'active') {
    // Dunning grace: a merely past_due platform sub (card declined, Stripe is
    // retrying) must NOT trigger offboarding — startWindDown emails every client
    // a "your provider is winding down" notice, and recover() sends no
    // retraction. Wind down only once the sub actually cancels (or is gone);
    // Stripe's dunning either recovers the payment or moves the sub to
    // canceled/unpaid, which lands back here without the past_due guard.
    const dunning = await Subscription.exists({ organizationId: orgId, status: 'past_due' });
    if (dunning) return;
    return startWindDown(orgId, 'entitlement_lost');
  }
  // 'suspending' / 'purging' / 'restoring': transient — no action here. A
  // re-subscribe landing mid-transient is picked up by the hourly
  // restoreEntitledSuspended sweep once the org settles to 'suspended'.
}

/**
 * Cron/boot sweep: suspend every org whose grace has elapsed. Returns a count.
 */
async function runDueSuspensions(now = new Date()) {
  if (!(await flagService.isFlagLive('saasMode'))) return { suspended: 0, skipped: 'dark' };

  const due = await Organization.find({
    // 'suspending' too: re-drive an org whose teardown was interrupted by a crash.
    lifecycleStatus: { $in: ['winding_down', 'suspending'] },
    suspendAt: { $lte: now },
  }).select('_id').lean();

  let suspended = 0;
  for (const o of due) {
    try {
      if (await suspend(o._id)) suspended++; // null = held for retry / lost claim
    } catch (err) {
      console.error(`[lifecycle] suspend failed for org ${o._id}:`, err.message);
    }
  }
  return { suspended, due: due.length };
}

// ─── Teardown steps (internal, best-effort) ─────────────────────────

async function _step(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[lifecycle] suspend step "${label}" failed:`, err.message);
  }
}

/** Cancel the agency's client subscriptions on ITS connected account.
 *  Returns the number of subs left cancelable due to a TRANSIENT Stripe failure —
 *  the caller must NOT finalize the suspension while any remain (staying
 *  'suspending' is what makes the daily re-drive actually retry the cancel). */
async function _cancelClientSubs(org) {
  const subs = await ClientSubscription.find({
    organizationId: org._id,
    status: { $in: CANCELABLE_SUB_STATUSES },
  });
  let retryLater = 0;
  for (const cs of subs) {
    if (cs.stripeSubscriptionId) {
      const acct = cs.connectedAccountId || org.stripeConnectAccountId;
      if (!acct) {
        // We have a live Stripe sub but no connected account to route the cancel
        // through — do NOT mark it canceled locally (that would strand a
        // still-billing sub outside the retry set). Leave it for manual handling;
        // this does not block the finalize (it would never succeed on retry).
        console.error(`[lifecycle] no connected account to cancel sub ${cs.stripeSubscriptionId}; left cancelable for manual handling`);
        continue;
      }
      try {
        await stripeService.stripe.subscriptions.cancel(
          cs.stripeSubscriptionId,
          stripeService.connectedAccountOptions(acct)
        );
      } catch (err) {
        // resource_missing / 404 = already gone on Stripe → safe to finalize
        // locally. Any OTHER error (network / 5xx / rate-limit) is TRANSIENT:
        // leave the sub cancelable so the re-drive retries; do NOT mark canceled.
        if (err?.code !== 'resource_missing' && err?.statusCode !== 404) {
          console.error(`[lifecycle] Stripe cancel failed (will retry) for sub ${cs.stripeSubscriptionId}:`, err.message);
          retryLater++;
          continue;
        }
      }
    }
    cs.status = 'canceled';
    cs.canceledAt = new Date();
    await cs.save();
  }
  return retryLater;
}

/** Lock every client-provisioned workspace (suspend-not-delete). */
async function _lockClientWorkspaces(orgId) {
  await Workspace.updateMany(
    { organizationId: orgId, clientProvisionedSubId: { $type: 'string' }, clientLocked: { $ne: true } },
    { $set: { clientLocked: true, clientLockedAt: new Date() } }
  );
}

/** Deactivate custom domains so the agency's branded host stops resolving. */
async function _deactivateDomains(orgId) {
  // Pick domains still needing work: not-yet-suspended, OR already suspended but
  // with a lingering cloudflareId (a prior CF delete failed → retry the cleanup).
  // Without the second clause a failed CF delete would be skipped forever once
  // the domain flipped to 'suspended'.
  const domains = await Domain.find({
    organizationId: orgId,
    $or: [
      { status: { $ne: 'suspended' } },
      { status: 'suspended', cloudflareId: { $ne: '' } },
    ],
  });
  for (const d of domains) {
    let cfCleared = true;
    if (d.cloudflareId && cloudflareService.isConfigured()) {
      try {
        await cloudflareService.deleteCustomHostname(d.cloudflareId);
      } catch (err) {
        // KEEP the id: it's the only handle to delete the orphaned Cloudflare
        // hostname later (clearing it on failure would leak the CF resource with
        // no way to find it). The domain is still deactivated below regardless.
        cfCleared = false;
        console.error(`[lifecycle] Cloudflare hostname delete failed for ${d.hostname} (id kept for cleanup):`, err.message);
      }
    }
    // Stop host→org resolution regardless (resolveOrgByHost only matches 'active').
    d.status = 'suspended';
    d.statusDetail = cfCleared
      ? 'Agency offboarded — domain deactivated'
      : 'Agency offboarded — Cloudflare hostname cleanup pending';
    if (cfCleared) d.cloudflareId = '';
    await d.save();
  }
  domainService.clearDomainCache();
}

/** Brand reverts automatically via the entitlement gate; just drop the cache. */
async function _revertBrand(orgId) {
  brandService.clearBrandCache(orgId);
}

// ─── Notifications (best-effort) ────────────────────────────────────

async function _notifyWindDown(org) {
  const { brand } = await brandService.getBrandForOrg(org._id);
  const brandName = brand?.brandName || 'Your provider';
  const graceEnds = org.suspendAt ? org.suspendAt.toDateString() : `${GRACE_DAYS} days`;

  // Notify each distinct client on the agency's plans.
  const subs = await ClientSubscription.find({
    organizationId: org._id,
    status: { $in: LIVE_SUB_STATUSES }, // only email CURRENT clients, not long-departed ones
    clientEmail: { $ne: null },
  }).select('clientEmail').lean();
  const emails = [...new Set(subs.map((s) => s.clientEmail).filter(Boolean))];

  for (const to of emails) {
    try {
      await sendEmail({
        to,
        orgId: org._id, // tenant-branded FROM identity
        subject: `Important: changes to your ${brandName} account`,
        html:
          // NOTE: clients cannot use the export endpoints (agency-staff only), so
          // don't instruct them to "export" — tell them to save copies and to ask
          // their provider (who CAN export the workspace on their behalf).
          `<p>Your ${brandName} workspace will remain available until <strong>${graceEnds}</strong>.</p>` +
          `<p>Please save a copy of any content you'd like to keep before then. ` +
          `If you'd like a full export of your workspace, reply to this email and we'll provide one.</p>`,
      });
    } catch (err) {
      console.error(`[lifecycle] client wind-down email failed for ${to}:`, err.message);
    }
  }
}

module.exports = {
  DAY_MS,
  GRACE_DAYS,
  RETENTION_DAYS,
  hasLiveClientAssets,
  startWindDown,
  recover,
  suspend,
  reconcile,
  runDueSuspensions,
};
