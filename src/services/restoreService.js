/**
 * Tenant restore service (Phase 18D) — bring a SUSPENDED (not yet purged) agency
 * org back to 'active', reversing the teardown that lifecycleService.suspend did.
 * See docs/tenant-restore-runbook.md for the operator runbook.
 *
 * What suspend() did → what restore reverses:
 *   _deactivateDomains     → reset suspended domains to pending_dns + re-verify
 *                            (the Cloudflare hostname was deleted, so it is
 *                            re-created by the normal verifyDomain flow)
 *   _revertBrand           → clear the brand cache; branding re-applies AUTOMATICALLY
 *                            once the org is active AND entitled again
 *   _lockClientWorkspaces  → NOT reversed here. Client subs were cancelled, so the
 *                            workspaces stay locked (unlocking would grant unbilled
 *                            access). Each client unlocks their workspace by
 *                            re-subscribing THROUGH it — the checkout binds the new
 *                            sub and reconcileWorkspaceLock unlocks it, reusing the
 *                            same workspace (no duplicate, no unbilled access).
 *   _cancelClientSubs      → NOT auto-reversible. Stripe subscriptions were
 *                            cancelled; each client must re-subscribe. Restore
 *                            collects the ones this suspension cancelled into a
 *                            report for manual outreach.
 *
 * Trigger paths:
 *   - reconcile() auto-restores when a suspended org regains entitlement (re-subscribe)
 *   - operators can run scripts/restoreOrg.js for support-initiated restores
 *
 * A PURGED org (past retention, client workspaces deleted in Phase 18C) can still
 * be reactivated as a fresh shell, but its client data is gone — restore reports
 * purged:true and unlocks/collects nothing. Recovering purged data requires
 * importing an export archive (Phase 18B), which is out of scope here.
 *
 * Self-gates on saasMode; inert while the flag is dark.
 */

const Organization = require('../models/Organization');
const Domain = require('../models/Domain');
const ClientSubscription = require('../models/ClientSubscription');
const flagService = require('./flagService');
const brandService = require('./brandService');
const domainService = require('./domainService');
const cloudflareService = require('./cloudflareService');
const auditService = require('./auditService');

const STALE_RESTORE_MS = 60 * 60 * 1000; // resume a 'restoring' org stuck > 1h

async function _step(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[restore] step "${label}" failed:`, err.message);
  }
}

/** Reverse _deactivateDomains: reset suspended domains to pending_dns and attempt
 *  an immediate re-verify (DNS is usually unchanged during suspension, so the
 *  Cloudflare hostname is re-created and the host goes active again). A failed
 *  re-verify simply leaves the domain at pending_dns for the agency to re-verify. */
async function _restoreDomains(orgId, report) {
  const domains = await Domain.find({ organizationId: orgId, status: 'suspended' });
  report.domainsReset = 0;
  for (const d of domains) {
    // If suspend's CF delete had FAILED, the domain still carries a live
    // cloudflareId. Delete that hostname before clearing the id — otherwise the
    // re-verify below creates a SECOND hostname and orphans the first (whose only
    // handle we're about to discard).
    if (d.cloudflareId && cloudflareService.isConfigured()) {
      try {
        await cloudflareService.deleteCustomHostname(d.cloudflareId);
      } catch (err) {
        console.error(`[restore] pre-restore CF cleanup failed for ${d.hostname} (may orphan a hostname):`, err.message);
      }
    }
    d.status = 'pending_dns';
    d.statusDetail = 'Restored — re-verifying DNS to reactivate the branded host';
    d.cloudflareId = ''; // verifyDomain re-creates it
    await d.save();
    report.domainsReset += 1;
    try {
      await domainService.verifyDomain(d._id);
    } catch (err) {
      console.error(`[restore] re-verify failed for ${d.hostname} (agency can re-verify manually):`, err.message);
    }
  }
  domainService.clearDomainCache();
}

/** Collect the client subs THIS suspension cancelled — they cannot be un-cancelled
 *  on Stripe, so each client must re-subscribe. Scoped to canceledAt >= suspendedAt
 *  so long-departed clients aren't listed for re-subscription. Surfaced for
 *  manual outreach. */
async function _collectCanceledSubs(orgId, suspendedAt, report) {
  const filter = { organizationId: orgId, status: 'canceled' };
  if (suspendedAt) filter.canceledAt = { $gte: suspendedAt };
  const subs = await ClientSubscription.find(filter).select('clientEmail workspaceId').lean();
  report.clientSubsNeedingResubscribe = subs.map((s) => ({
    clientEmail: s.clientEmail || null,
    workspaceId: s.workspaceId ? String(s.workspaceId) : null,
  }));
}

/**
 * Restore a suspended org. Returns a report (never throws for expected states).
 */
async function restoreSuspendedOrg(orgId) {
  if (!orgId) return { restored: false, reason: 'no_org' };

  const current = await Organization.findById(orgId).select('lifecycleStatus purgedAt').lean();
  if (!current) return { restored: false, reason: 'not_found' };
  if (!['suspended', 'restoring'].includes(current.lifecycleStatus)) {
    return { restored: false, reason: 'not_suspended', lifecycleStatus: current.lifecycleStatus };
  }

  // STARTING a new restore (from 'suspended') requires the flag. FINISHING an
  // in-flight 'restoring' is deliberately NOT flag-gated: darking saasMode must
  // never strand an org in a transient state (recovery to 'active' is always
  // possible). Dark-safe: while dark no org can ever ENTER 'restoring'.
  if (current.lifecycleStatus === 'suspended' && !(await flagService.isFlagLive('saasMode'))) {
    return { restored: false, skipped: 'dark' };
  }

  // Atomic claim suspended→restoring BEFORE any reversal work, so the retention
  // purge (which targets 'suspended') cannot fire mid-restore. LEASE semantics:
  // an in-flight 'restoring' (fresh updatedAt) is NOT re-claimable — that would
  // let two live restores run the reversal concurrently and clobber each other's
  // cloudflareId writes. Only a STALE 'restoring' (crashed; > STALE_RESTORE_MS)
  // can be re-claimed; the claim's own $set bumps updatedAt, renewing the lease.
  const claimed = await Organization.findOneAndUpdate(
    {
      _id: orgId,
      $or: [
        { lifecycleStatus: 'suspended' },
        { lifecycleStatus: 'restoring', updatedAt: { $lt: new Date(Date.now() - STALE_RESTORE_MS) } },
      ],
    },
    { $set: { lifecycleStatus: 'restoring' } },
    { new: true }
  );
  if (!claimed) return { restored: false, reason: 'claim_lost' };

  const purged = !!claimed.purgedAt;
  const report = { purged, clientSubsNeedingResubscribe: [] };

  // Reactivate the agency's own infrastructure (domains + branding) in both cases.
  await _step('restore domains', () => _restoreDomains(orgId, report));
  await _step('reapply brand', () => brandService.clearBrandCache(orgId));
  if (!purged) {
    // Data is intact. Client workspaces stay LOCKED (subs cancelled) — clients
    // unlock them by re-subscribing. Collect those subs for manual outreach.
    await _step('collect cancelled client subs', () => _collectCanceledSubs(orgId, claimed.suspendedAt, report));
  }
  // (purged: client workspaces + subs are gone — nothing to collect.)

  // Finalize restoring→active, clearing every lifecycle field (incl. purgedAt).
  const done = await Organization.findOneAndUpdate(
    { _id: orgId, lifecycleStatus: 'restoring' },
    {
      $set: {
        lifecycleStatus: 'active',
        lifecycleReason: null,
        windDownStartedAt: null,
        suspendAt: null,
        suspendedAt: null,
        purgeAt: null,
        purgedAt: null,
      },
    },
    { new: true }
  );
  if (!done) return { restored: false, reason: 'finalize_lost' };

  auditService.record({
    organizationId: orgId,
    action: 'lifecycle.restored',
    resourceId: orgId,
    meta: report,
  });
  return { restored: true, ...report };
}

/**
 * Cron/boot sweep: re-drive orgs stuck in 'restoring' (a crash between the claim
 * and the finalize would otherwise strand them — no other sweep targets
 * 'restoring', and the tenant surface stays down while non-active). Only picks
 * orgs stale > STALE_RESTORE_MS so it never collides with an in-flight restore.
 * Deliberately NOT flag-gated: it only FINISHES in-flight restores (none can
 * exist unless saasMode was live), and darking the flag must not strand them.
 */
async function resumeStuckRestores(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_RESTORE_MS);
  const stuck = await Organization.find({ lifecycleStatus: 'restoring', updatedAt: { $lt: cutoff } })
    .select('_id').lean();
  let resumed = 0;
  for (const o of stuck) {
    try {
      const r = await restoreSuspendedOrg(o._id);
      if (r.restored) resumed++;
    } catch (err) {
      console.error(`[restore] resume failed for org ${o._id}:`, err.message);
    }
  }
  return { resumed, stuck: stuck.length };
}

/**
 * Cron sweep: restore any SUSPENDED org that is entitled again. Closes the
 * lost-wakeup: reconcile() has no branch for the transient 'suspending'/'purging'
 * states, so a re-subscribe landing mid-teardown/mid-purge is silently dropped —
 * and nothing re-fires reconcile until the next subscription webhook (~a billing
 * cycle away). This sweep picks the org up within the hour of it settling to
 * 'suspended'. Self-gates on saasMode (it STARTS new restores). Cheap: suspended
 * orgs are rare, and the entitlement check is one query each.
 */
async function restoreEntitledSuspended() {
  if (!(await flagService.isFlagLive('saasMode'))) return { restored: 0, skipped: 'dark' };
  const suspended = await Organization.find({ lifecycleStatus: 'suspended' }).select('_id').lean();
  let restored = 0;
  for (const o of suspended) {
    try {
      if (!(await brandService.isSaasModeEntitled(o._id))) continue;
      const r = await restoreSuspendedOrg(o._id);
      if (r.restored) restored++;
    } catch (err) {
      console.error(`[restore] entitled-suspended sweep failed for org ${o._id}:`, err.message);
    }
  }
  return { restored, checked: suspended.length };
}

module.exports = { restoreSuspendedOrg, resumeStuckRestores, restoreEntitledSuspended };
