/**
 * Data deletion service (Phase 18C) — hard-delete a workspace or an entire org,
 * and the automated retention purge that erases a suspended agency's client
 * workspaces once the 90-day window (Organization.purgeAt, set by
 * lifecycleService.suspend) has elapsed.
 *
 * Three entry points:
 *   deleteWorkspaceData(workspaceId)  — erase ONE workspace (client-erasure req).
 *   deleteOrgData(orgId)              — erase an ENTIRE org (agency account close).
 *   runDuePurges(now)                 — cron: purge suspended orgs past purgeAt.
 *
 * Coverage: every collection scoped by workspaceId / workspace / trackerId /
 * sitemapId (per workspace) and by organizationId (per org). The scoping map was
 * enumerated from the models; NEW scoped models MUST be added here or erasure
 * leaves orphans. AuditLog is DELIBERATELY excluded — it is the compliance trail
 * (and TTLs out on its own); deleting it would erase the proof of deletion.
 *
 * Before deleting records the service best-effort cancels any still-live client
 * subscription on Stripe (workspace) and removes custom hostnames from Cloudflare
 * (org), so erasing an ACTIVE tenant does not strand external state. On the purge
 * path those are already torn down by suspend(), so they are no-ops.
 *
 * DARK: runDuePurges self-gates on the dataErasure flag, so it is a silent no-op
 * until Phase 18C launches. The manual entry points are only reachable through the
 * requireFeature('dataErasure')-gated routes, which 404 while that flag is dark.
 */

const Organization = require('../models/Organization');
const Workspace = require('../models/Workspace');

// per-workspace scoped models
const Content = require('../models/Content');
const Plan = require('../models/Plan');
const AgentUsageLog = require('../models/AgentUsageLog');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const ReportShare = require('../models/ReportShare');
const ReportSnapshot = require('../models/ReportSnapshot');
const WorkspaceUsageTracker = require('../models/WorkspaceUsageTracker');
const WorkspaceMember = require('../models/WorkspaceMember');
const ClientSubscription = require('../models/ClientSubscription');
const Site = require('../models/Site');
const Sitemap = require('../models/Sitemap');
const CrawlPage = require('../models/CrawlPage');
const BrandVoice = require('../models/BrandVoice');
const Avatar = require('../models/Avatar');
const AiTracker = require('../models/AiTracker');
const AiTrackerScan = require('../models/AiTrackerScan');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTrackerCompetitor = require('../models/AiTrackerCompetitor');
const AiThread = require('../models/AiThread');
const AiThreadMessage = require('../models/AiThreadMessage');
const AiCostLedger = require('../models/AiCostLedger');

// org-scoped models
const AgencyPlan = require('../models/AgencyPlan');
const BrandConfig = require('../models/BrandConfig');
const Credit = require('../models/Credit');
const CreditTransaction = require('../models/CreditTransaction');
const Domain = require('../models/Domain');
const GscConnection = require('../models/GscConnection');
const Invite = require('../models/Invite');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const TriggerableEmailTemplate = require('../models/TriggerableEmailTemplate');
const UsageTracker = require('../models/UsageTracker');

const flagService = require('./flagService');
const auditService = require('./auditService');
const stripeService = require('./stripeService');
const cloudflareService = require('./cloudflareService');

const LIVE_SUB_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'paused'];
const MAX_PURGES_PER_RUN = 25; // bound one cron pass; overdue tail defers to following nights

// ─── helpers ────────────────────────────────────────────────────────

/** deleteMany that never throws: records the count (or the error) under `label`
 *  in the shared `counts` object so one failing collection cannot abort the
 *  whole erasure — a re-run completes the rest. */
async function _del(counts, label, Model, filter) {
  try {
    const res = await Model.deleteMany(filter);
    counts[label] = (counts[label] || 0) + (res?.deletedCount || 0);
  } catch (err) {
    console.error(`[deletion] deleteMany ${label} failed:`, err.message);
    counts.errors = counts.errors || {};
    counts.errors[label] = err.message;
  }
}

/** Resolve an org's connected-account id (memoised across one call). */
async function _orgConnectAcct(orgId, cache) {
  if (!orgId) return null;
  const key = String(orgId);
  if (cache.has(key)) return cache.get(key);
  let acct = null;
  try {
    const org = await Organization.findById(orgId).select('stripeConnectAccountId').lean();
    acct = org?.stripeConnectAccountId || null;
  } catch (err) {
    console.error('[deletion] resolving org connect account failed:', err.message);
  }
  cache.set(key, acct);
  return acct;
}

/** Cancel any still-live client subscription on Stripe before its record is
 *  deleted, so erasing an active workspace/org doesn't leave a billing sub
 *  running. Resolves the connected account from the sub, falling back to the
 *  org's (mirrors lifecycleService._cancelClientSubs) so an anomalous row with no
 *  denormalised connectedAccountId is still cancelled. Best-effort: a Stripe
 *  failure is logged and the record is still deleted (it carries the personal data). */
async function _cancelLiveClientSubs(filter) {
  let subs = [];
  try {
    subs = await ClientSubscription.find({ ...filter, status: { $in: LIVE_SUB_STATUSES } }).lean();
  } catch (err) {
    console.error('[deletion] loading live client subs failed:', err.message);
    return;
  }
  const acctCache = new Map();
  for (const cs of subs) {
    if (!cs.stripeSubscriptionId) continue;
    const acct = cs.connectedAccountId || (await _orgConnectAcct(cs.organizationId, acctCache));
    if (!acct) {
      console.error(`[deletion] no connected account to cancel client sub ${cs.stripeSubscriptionId}; record deleted without Stripe cancel`);
      continue;
    }
    try {
      await stripeService.stripe.subscriptions.cancel(
        cs.stripeSubscriptionId,
        stripeService.connectedAccountOptions(acct)
      );
    } catch (err) {
      if (err?.code !== 'resource_missing' && err?.statusCode !== 404) {
        console.error(`[deletion] Stripe cancel failed for sub ${cs.stripeSubscriptionId}:`, err.message);
      }
    }
  }
}

/** Cancel the AGENCY's own platform subscription (on the PLATFORM account, no
 *  connected-account option) when its org is erased, so account closure stops
 *  platform billing instead of stranding a live sub with no local record. */
async function _cancelPlatformSubscription(orgId) {
  let subs = [];
  try {
    subs = await Subscription.find({
      organizationId: orgId,
      status: { $in: ['active', 'trialing', 'past_due', 'incomplete'] },
    }).lean();
  } catch (err) {
    console.error('[deletion] loading platform subscription failed:', err.message);
    return;
  }
  for (const s of subs) {
    if (!s.stripeSubscriptionId) continue;
    try {
      await stripeService.stripe.subscriptions.cancel(s.stripeSubscriptionId);
    } catch (err) {
      if (err?.code !== 'resource_missing' && err?.statusCode !== 404) {
        console.error(`[deletion] platform Stripe cancel failed for ${s.stripeSubscriptionId}:`, err.message);
      }
    }
  }
}

/** Remove custom hostnames from Cloudflare before the Domain records are deleted,
 *  so erasing an active org doesn't orphan edge hostnames. Best-effort. */
async function _deleteDomainHostnames(orgId) {
  if (!cloudflareService.isConfigured()) return;
  let domains = [];
  try {
    domains = await Domain.find({ organizationId: orgId, cloudflareId: { $ne: '' } }).lean();
  } catch (err) {
    console.error('[deletion] loading domains failed:', err.message);
    return;
  }
  for (const d of domains) {
    try {
      await cloudflareService.deleteCustomHostname(d.cloudflareId);
    } catch (err) {
      console.error(`[deletion] Cloudflare hostname delete failed for ${d.cloudflareId}:`, err.message);
    }
  }
}

// ─── workspace erasure ──────────────────────────────────────────────

/**
 * Hard-delete every record scoped to one workspace, then the workspace itself.
 * Idempotent: re-running on an already-erased workspace deletes nothing more and
 * returns zero counts. `counts` is threaded so org erasure can accumulate totals.
 */
async function deleteWorkspaceData(workspaceId, counts = {}) {
  // Stop external billing before dropping the sub records.
  await _cancelLiveClientSubs({ workspaceId });

  // AI Tracker children (scoped by trackerId) BEFORE the trackers themselves.
  const trackerIds = (await AiTracker.find({ workspaceId }).select('_id').lean()).map((t) => t._id);
  if (trackerIds.length) {
    await _del(counts, 'aiTrackerScans', AiTrackerScan, { trackerId: { $in: trackerIds } });
    await _del(counts, 'aiTrackerPrompts', AiTrackerPrompt, { trackerId: { $in: trackerIds } });
    await _del(counts, 'aiTrackerCompetitors', AiTrackerCompetitor, { trackerId: { $in: trackerIds } });
  }
  await _del(counts, 'aiTrackers', AiTracker, { workspaceId });

  // Sitemap children (CrawlPage scoped by sitemapId) BEFORE the sitemaps.
  const sitemapIds = (await Sitemap.find({ workspaceId }).select('_id').lean()).map((s) => s._id);
  if (sitemapIds.length) {
    await _del(counts, 'crawlPages', CrawlPage, { sitemapId: { $in: sitemapIds } });
  }
  await _del(counts, 'sitemaps', Sitemap, { workspaceId });

  // Threads P5: conversation threads (children BEFORE parents — same
  // discipline as the tracker scans above; AiThreadMessage is keyed only by
  // threadId).
  const threadIds = (await AiThread.find({ workspaceId }).select('_id').lean()).map((t) => t._id);
  if (threadIds.length) {
    await _del(counts, 'aiThreadMessages', AiThreadMessage, { threadId: { $in: threadIds } });
  }
  await _del(counts, 'aiThreads', AiThread, { workspaceId });

  // Threads P5 (drive-by, twice review-flagged): AiCostLedger rows carried
  // dangling tenant linkage after erasure. COGS rows are OUR accounting —
  // aggregate margins must survive — so SCRUB the tenant fields rather than
  // delete: the numbers stay, the erased tenant's linkage (and contentId
  // metadata) goes.
  try {
    const scrub = await AiCostLedger.updateMany(
      { workspaceId },
      { $set: { workspaceId: null, organizationId: null, userId: null, metadata: {} } },
    );
    if (scrub.modifiedCount) counts.aiCostLedgerScrubbed = (counts.aiCostLedgerScrubbed || 0) + scrub.modifiedCount;
  } catch (err) {
    console.error('[deletion] AiCostLedger scrub failed (non-fatal):', err.message);
  }

  await _del(counts, 'content', Content, { workspaceId });
  await _del(counts, 'plans', Plan, { workspaceId });
  await _del(counts, 'agentUsageLogs', AgentUsageLog, { workspaceId });
  await _del(counts, 'keywordResearch', KeywordResearchHistory, { workspaceId });
  await _del(counts, 'reportShares', ReportShare, { workspaceId });
  await _del(counts, 'reportSnapshots', ReportSnapshot, { workspaceId });
  await _del(counts, 'workspaceUsage', WorkspaceUsageTracker, { workspaceId });
  await _del(counts, 'workspaceMembers', WorkspaceMember, { workspaceId });
  await _del(counts, 'clientSubscriptions', ClientSubscription, { workspaceId });
  await _del(counts, 'sites', Site, { workspaceId });
  // BrandVoice & Avatar are scoped by `workspace`, NOT `workspaceId`.
  await _del(counts, 'brandVoices', BrandVoice, { workspace: workspaceId });
  await _del(counts, 'avatars', Avatar, { workspace: workspaceId });
  // Pending invites reference workspaces via the `workspaceIds` array (holds the
  // invitee email — personal data). Delete any invite that targets this workspace
  // so a per-workspace erasure leaves none orphaned. (A rare multi-workspace
  // assigned invite is removed wholesale; the invitee is simply re-invitable.)
  await _del(counts, 'invites', Invite, { workspaceIds: workspaceId });

  await _del(counts, 'workspace', Workspace, { _id: workspaceId });
  return counts;
}

// ─── org erasure ────────────────────────────────────────────────────

/**
 * Hard-delete an entire org: every workspace's data, all org-scoped records, and
 * the Organization document. Does NOT delete the owner's User account (they may
 * own other orgs). Idempotent.
 */
async function deleteOrgData(orgId, counts = {}) {
  await _deleteDomainHostnames(orgId);
  // Stop the agency's own platform billing before its records are gone.
  await _cancelPlatformSubscription(orgId);

  const workspaces = await Workspace.find({ organizationId: orgId }).select('_id').lean();
  for (const ws of workspaces) {
    await deleteWorkspaceData(ws._id, counts);
  }

  // Cancel any client sub that survived the per-workspace sweep (e.g. an orphaned
  // row whose workspaceId no longer maps to one of this org's workspaces) before
  // the org-level ClientSubscription delete below drops it uncancelled.
  await _cancelLiveClientSubs({ organizationId: orgId });

  await _del(counts, 'agencyPlans', AgencyPlan, { organizationId: orgId });
  await _del(counts, 'brandConfigs', BrandConfig, { organizationId: orgId });
  await _del(counts, 'credits', Credit, { organizationId: orgId });
  await _del(counts, 'creditTransactions', CreditTransaction, { organizationId: orgId });
  await _del(counts, 'domains', Domain, { organizationId: orgId });
  await _del(counts, 'gscConnections', GscConnection, { organizationId: orgId });
  await _del(counts, 'invites', Invite, { organizationId: orgId });
  await _del(counts, 'orgMembers', OrgMember, { organizationId: orgId });
  await _del(counts, 'subscriptions', Subscription, { organizationId: orgId });
  await _del(counts, 'emailTemplates', TriggerableEmailTemplate, { organizationId: orgId });
  await _del(counts, 'usageTrackers', UsageTracker, { organizationId: orgId });
  // Org-level remnants of models that ALSO carry organizationId (belt-and-suspenders
  // in case a record's workspaceId was ever unset).
  await _del(counts, 'clientSubscriptions', ClientSubscription, { organizationId: orgId });
  await _del(counts, 'reportSnapshots', ReportSnapshot, { organizationId: orgId });
  await _del(counts, 'reportShares', ReportShare, { organizationId: orgId });
  await _del(counts, 'sites', Site, { organizationId: orgId });
  // CrawlPage is scoped by sitemapId, so collect ids BEFORE the org-level Sitemap
  // sweep — any sitemap reached here (rather than by the per-workspace pass, e.g.
  // one whose workspaceId no longer maps to a live workspace) would otherwise
  // leave its crawl pages orphaned.
  const orgSitemapIds = (await Sitemap.find({ organizationId: orgId }).select('_id').lean()).map((s) => s._id);
  if (orgSitemapIds.length) await _del(counts, 'crawlPages', CrawlPage, { sitemapId: { $in: orgSitemapIds } });
  await _del(counts, 'sitemaps', Sitemap, { organizationId: orgId });
  await _del(counts, 'workspaceMembers', WorkspaceMember, { organizationId: orgId });
  // Threads P5 review (BUG-1): the per-workspace ledger scrub misses rows
  // whose workspace was deleted via the NON-erasure paths (workspace/admin
  // cascade deletes never scrub) and org-only rows (schema allows null
  // workspaceId). An org erasure must not certify with live org linkage.
  try {
    const scrub = await AiCostLedger.updateMany(
      { organizationId: orgId },
      { $set: { workspaceId: null, organizationId: null, userId: null, metadata: {} } },
    );
    if (scrub.modifiedCount) counts.aiCostLedgerScrubbed = (counts.aiCostLedgerScrubbed || 0) + scrub.modifiedCount;
  } catch (err) {
    console.error('[deletion] org-level AiCostLedger scrub failed (non-fatal):', err.message);
  }

  await _del(counts, 'organization', Organization, { _id: orgId });
  return counts;
}

// ─── retention purge (cron) ─────────────────────────────────────────

/**
 * Purge the client-provisioned workspaces of every suspended org whose retention
 * window has elapsed. The AGENCY org itself is NOT deleted here — only its client
 * data — because the agency may still use SupaRank on a downgraded plan. After
 * purging, purgeAt is cleared and purgedAt stamped so the org is not re-picked.
 * Self-gates on the dataErasure flag (deletion is controlled separately from the
 * lifecycle state machine, so you can launch suspend without enabling purge); a
 * silent no-op while that flag is dark. Orgs only ever reach 'suspended' under
 * saasMode, so the due-set is empty anyway until the lifecycle is also live.
 */
async function runDuePurges(now = new Date()) {
  // Gate on BOTH flags: dataErasure (deletion switch) AND saasMode (the purge is
  // the destructive tail of the saas lifecycle — if ops darked saasMode in an
  // emergency, restores are the priority and destruction must pause with them;
  // retention is a minimum, not a deadline).
  const live = (await flagService.isFlagLive('dataErasure')) && (await flagService.isFlagLive('saasMode'));
  if (!live) {
    // Roll back any org stranded mid-purge back to the SAFE 'suspended' state so
    // it isn't frozen in 'purging' (invisible to restore) while the flags are
    // dark. purgeAt stays set, so the purge resumes when the flags return; being
    // 'suspended' makes restore possible meanwhile. No-op when dark-from-birth.
    try {
      await Organization.updateMany(
        { lifecycleStatus: 'purging' },
        { $set: { lifecycleStatus: 'suspended' } }
      );
    } catch (err) {
      console.error('[deletion] purging-rollback sweep failed:', err.message);
    }
    return { purged: 0, skipped: 'dark' };
  }

  const dueAll = await Organization.find({
    // 'purging' too: re-drive an org whose purge was interrupted by a crash.
    lifecycleStatus: { $in: ['suspended', 'purging'] },
    purgeAt: { $ne: null, $lte: now },
  }).select('_id').lean();

  // Cap each run: if dataErasure launches after months of saasMode, every
  // overdue org would otherwise purge in one thundering pass. Retention is a
  // minimum — deferring the tail to following nights is always safe.
  const due = dueAll.slice(0, MAX_PURGES_PER_RUN);
  if (dueAll.length > due.length) {
    console.log(`[deletion] purge run capped at ${MAX_PURGES_PER_RUN}; ${dueAll.length - due.length} overdue org(s) deferred to the next run`);
  }

  let purged = 0;
  for (const o of due) {
    try {
      // Atomically claim suspended→'purging' BEFORE deleting anything. This
      // serialises against restore: restore claims {suspended,restoring} and we
      // claim {suspended,purging}, so only one can win the 'suspended' transition.
      // If restore already flipped the org to 'restoring'/'active', this claim
      // finds no match and we skip WITHOUT deleting a live org's data. Re-claims a
      // crashed 'purging'.
      const claimed = await Organization.findOneAndUpdate(
        { _id: o._id, lifecycleStatus: { $in: ['suspended', 'purging'] }, purgeAt: { $ne: null, $lte: now } },
        { $set: { lifecycleStatus: 'purging' } },
        { new: true }
      );
      if (!claimed) continue; // restored / already purged / not due → skip

      const clientWorkspaces = await Workspace.find({
        organizationId: o._id,
        clientProvisionedSubId: { $type: 'string' },
      }).select('_id').lean();

      const counts = {};
      for (const ws of clientWorkspaces) {
        await deleteWorkspaceData(ws._id, counts);
      }

      // Finalize purging→suspended: data gone, keep the org suspended, mark purged
      // (clear purgeAt) so it is not re-picked.
      const done = await Organization.findOneAndUpdate(
        { _id: o._id, lifecycleStatus: 'purging' },
        { $set: { lifecycleStatus: 'suspended', purgeAt: null, purgedAt: now } },
        { new: true }
      );
      if (!done) continue; // another worker finalized it → don't double-audit

      purged++;
      auditService.record({
        organizationId: o._id,
        action: 'lifecycle.purged',
        resourceId: o._id,
        meta: { workspacesPurged: clientWorkspaces.length, counts },
      });
    } catch (err) {
      console.error(`[deletion] purge failed for org ${o._id}:`, err.message);
    }
  }
  return { purged, due: due.length };
}

module.exports = {
  deleteWorkspaceData,
  deleteOrgData,
  runDuePurges,
  LIVE_SUB_STATUSES,
};
