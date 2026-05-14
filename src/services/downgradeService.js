/**
 * Downgrade locking service — static locking on tier changes.
 *
 * When an org's tier changes (up or down), this service re-evaluates all
 * lockable resources and locks excess beyond the new tier's limits.
 *
 * Two kinds of resources:
 *
 * 1. QUOTA resources (articles, keywords, etc.): controlled by UsageTracker
 *    counters. Users keep ALL existing resources — they just can't create
 *    beyond their plan limit. Articles are NEVER locked.
 *
 * 2. CAPACITY resources (workspaces, brand voices, seats): represent active
 *    slots. Excess beyond the new tier's limit IS locked on tier change.
 *    Once locked, resources stay locked until the next tier change.
 */

const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const Avatar = require('../models/Avatar');
const BrandVoice = require('../models/BrandVoice');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const AiTracker = require('../models/AiTracker');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const tierService = require('./tierService');

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Get all workspace IDs belonging to an organization.
 */
async function getOrgWorkspaceIds(orgId) {
  return Workspace.find({ organizationId: orgId }).distinct('_id');
}

/**
 * Generic lock function: given a list of sorted resource IDs,
 * unlock the first `limit` and lock the rest via bulkWrite.
 */
async function applyLocks(Model, allIds, limit) {
  if (allIds.length === 0) return;

  const unlockIds = allIds.slice(0, limit);
  const lockIds = allIds.slice(limit);

  const ops = [];
  if (unlockIds.length > 0) {
    ops.push({
      updateMany: {
        filter: { _id: { $in: unlockIds } },
        update: { $set: { locked: false } },
      },
    });
  }
  if (lockIds.length > 0) {
    ops.push({
      updateMany: {
        filter: { _id: { $in: lockIds } },
        update: { $set: { locked: true } },
      },
    });
  }

  if (ops.length > 0) {
    await Model.bulkWrite(ops, { ordered: false });
  }
}

// ─── Per-resource lock functions ────────────────────────────────

// Articles are NEVER locked — they are quota-controlled via UsageTracker.
// Users keep all existing articles; they just can't create beyond their limit.

async function unlockAllArticles(orgId) {
  const wsIds = await getOrgWorkspaceIds(orgId);
  if (wsIds.length > 0) {
    await Content.updateMany(
      { workspaceId: { $in: wsIds }, locked: true },
      { $set: { locked: false } }
    );
  }
}

async function lockWorkspaces(orgId, limit) {
  if (limit === null || limit === undefined) {
    await Workspace.updateMany(
      { organizationId: orgId, locked: true },
      { $set: { locked: false } }
    );
    return;
  }

  // Default workspace gets priority (isDefault: -1 sorts true first), then oldest
  const workspaces = await Workspace.find({ organizationId: orgId })
    .sort({ isDefault: -1, createdAt: 1 })
    .select('_id')
    .lean();

  await applyLocks(Workspace, workspaces.map((w) => w._id), limit);
}

async function lockBrandVoiceConfigs(orgId, limit) {
  const wsIds = await getOrgWorkspaceIds(orgId);

  if (limit === null || limit === undefined) {
    if (wsIds.length > 0) {
      await BrandVoice.updateMany(
        { workspace: { $in: wsIds }, locked: true },
        { $set: { locked: false } }
      );
    }
    return;
  }

  if (wsIds.length === 0) return;

  // Apply limit PER WORKSPACE (each workspace gets `limit` brand voices)
  await Promise.all(wsIds.map(async (wsId) => {
    const voices = await BrandVoice.find({ workspace: wsId })
      .sort({ createdAt: 1 })
      .select('_id')
      .lean();
    await applyLocks(BrandVoice, voices.map((v) => v._id), limit);
  }));
}

async function lockAvatars(orgId, limit) {
  const wsIds = await getOrgWorkspaceIds(orgId);

  if (limit === null || limit === undefined) {
    if (wsIds.length > 0) {
      await Avatar.updateMany(
        { workspace: { $in: wsIds }, locked: true },
        { $set: { locked: false } }
      );
    }
    return;
  }

  if (wsIds.length === 0) return;

  // Apply limit PER WORKSPACE (each workspace gets `limit` avatars)
  await Promise.all(wsIds.map(async (wsId) => {
    const avatars = await Avatar.find({ workspace: wsId })
      .sort({ createdAt: 1 })
      .select('_id')
      .lean();
    await applyLocks(Avatar, avatars.map((a) => a._id), limit);
  }));
}

async function lockMembers(orgId, maxSeats) {
  if (maxSeats === null || maxSeats === undefined) {
    await OrgMember.updateMany(
      { organizationId: orgId, locked: true },
      { $set: { locked: false } }
    );
    return;
  }

  // Owner is implicit (not in OrgMember), takes 1 seat
  const memberSlots = Math.max(0, maxSeats - 1);

  const members = await OrgMember.find({ organizationId: orgId })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();

  await applyLocks(OrgMember, members.map((m) => m._id), memberSlots);
}

/**
 * Reset AI Tracker platform selections when they exceed the new tier limit.
 *
 * Clears `defaultModels` to [] on any monitor that has more platforms than
 * `maxAiTrackerPlatforms` allows, forcing the user to re-select.
 */
async function resetAiTrackerPlatforms(orgId, maxPlatforms) {
  const wsIds = await getOrgWorkspaceIds(orgId);
  if (wsIds.length === 0) return;

  // Unlimited — unlock all (no-op, nothing to clear)
  if (maxPlatforms === null || maxPlatforms === undefined) return;

  // Find monitors that exceed the new platform limit
  const trackers = await AiTracker.find({
    workspaceId: { $in: wsIds },
    $expr: { $gt: [{ $size: '$defaultModels' }, maxPlatforms] },
  }).select('_id').lean();

  if (trackers.length === 0) return;

  const trackerIds = trackers.map((t) => t._id);

  await Promise.all([
    AiTracker.updateMany(
      { _id: { $in: trackerIds } },
      { $set: { defaultModels: [] } }
    ),
    // Also clear prompt-level models so they re-inherit from tracker after reselection
    AiTrackerPrompt.updateMany(
      { trackerId: { $in: trackerIds } },
      { $set: { models: [] } }
    ),
  ]);

  console.log(`[downgradeService] Cleared defaultModels on ${trackers.length} AI Tracker monitor(s) and their prompt models for org ${orgId}`);
}

// ─── Free-tier plan-origin locking ──────────────────────────────
//
// When an org downgrades to free, lock all resources created while on a paid
// plan. Users can only access resources they created on the free tier.
// On upgrade back to any paid tier, unlock those resources.

async function lockPaidCreatedResources(orgId) {
  const wsIds = await getOrgWorkspaceIds(orgId);
  if (wsIds.length === 0) return;

  // Resolve AI Tracker IDs for prompt locking
  const trackerIds = await AiTracker.find({ workspaceId: { $in: wsIds } }).distinct('_id');

  await Promise.all([
    Content.updateMany(
      { workspaceId: { $in: wsIds }, createdOnPlan: 'paid' },
      { $set: { locked: true } }
    ),
    BrandVoice.updateMany(
      { workspace: { $in: wsIds }, createdOnPlan: 'paid' },
      { $set: { locked: true } }
    ),
    Avatar.updateMany(
      { workspace: { $in: wsIds }, createdOnPlan: 'paid' },
      { $set: { locked: true } }
    ),
    KeywordResearchHistory.updateMany(
      { workspaceId: { $in: wsIds }, createdOnPlan: 'paid' },
      { $set: { locked: true } }
    ),
    ...(trackerIds.length > 0 ? [
      AiTrackerPrompt.updateMany(
        { trackerId: { $in: trackerIds }, createdOnPlan: 'paid' },
        { $set: { locked: true } }
      ),
    ] : []),
  ]);

  console.log(`[downgradeService] Locked paid-created resources for org ${orgId}`);
}

async function unlockPaidCreatedResources(orgId) {
  const wsIds = await getOrgWorkspaceIds(orgId);
  if (wsIds.length === 0) return;

  const trackerIds = await AiTracker.find({ workspaceId: { $in: wsIds } }).distinct('_id');

  await Promise.all([
    Content.updateMany(
      { workspaceId: { $in: wsIds }, createdOnPlan: 'paid', locked: true },
      { $set: { locked: false } }
    ),
    BrandVoice.updateMany(
      { workspace: { $in: wsIds }, createdOnPlan: 'paid', locked: true },
      { $set: { locked: false } }
    ),
    Avatar.updateMany(
      { workspace: { $in: wsIds }, createdOnPlan: 'paid', locked: true },
      { $set: { locked: false } }
    ),
    KeywordResearchHistory.updateMany(
      { workspaceId: { $in: wsIds }, createdOnPlan: 'paid', locked: true },
      { $set: { locked: false } }
    ),
    ...(trackerIds.length > 0 ? [
      AiTrackerPrompt.updateMany(
        { trackerId: { $in: trackerIds }, createdOnPlan: 'paid', locked: true },
        { $set: { locked: false } }
      ),
    ] : []),
  ]);
}

// ─── Main orchestrator ──────────────────────────────────────────

/**
 * Apply resource locks for an organization based on its current tier.
 *
 * Called on every subscription event (checkout, update, delete, reactivation).
 * Handles both upgrades (unlocks more) and downgrades (locks excess).
 *
 * @param {string} orgId - Organization ID
 */
async function applyLocksForOrg(orgId) {
  const { tier, config } = await tierService.getOrgTierConfig(orgId);
  if (!config) {
    console.warn(`[downgradeService] No tier config found for org ${orgId}, skipping lock`);
    return;
  }

  // Extra seats from active subscription
  const sub = await Subscription.findOne({
    organizationId: orgId,
    status: { $in: ['active', 'trialing'] },
  }).lean();
  const extraSeats = sub?.purchasedExtraSeats || 0;

  // Free tier: lock all paid-created resources; Paid tier: unlock them
  if (tier === 'free') {
    await lockPaidCreatedResources(orgId);
  } else {
    await unlockPaidCreatedResources(orgId);
  }

  await Promise.all([
    // Quota resources: unlock any previously locked articles (cleanup)
    // Skip for free tier — lockPaidCreatedResources already handled article locks
    ...(tier !== 'free' ? [unlockAllArticles(orgId)] : []),
    // Capacity resources: lock excess beyond new tier limits
    lockWorkspaces(orgId, config.maxWorkspaces),
    lockBrandVoiceConfigs(orgId, config.maxBrandVoices),
    lockAvatars(orgId, config.maxAvatars),
    lockMembers(orgId, config.maxSeats + extraSeats),
    // AI Tracker: clear platform selections that exceed new tier limit
    resetAiTrackerPlatforms(orgId, config.maxAiTrackerPlatforms),
  ]);

  // Lifetime UsageTracker counters are NOT reset on tier change.
  //
  // The lifetime counter only increments when the user is on a tier that
  // uses lifetime limits (e.g. Free). When on a paid tier (e.g. Standard),
  // requireQuota increments the monthly counter instead, leaving lifetime
  // untouched. This means the lifetime counter naturally preserves the
  // correct count across upgrade/downgrade cycles:
  //
  //   Free (create 2/3) → Standard (create 10) → Free: counter still 2, 1 left
  //   New free user: counter=0, can create 3

  console.log(`[downgradeService] Applied locks for org ${orgId} (tier: ${config.tier || config.displayName})`);
}

module.exports = {
  applyLocksForOrg,
};
