/**
 * Downgrade locking service — static locking on tier changes.
 *
 * When an org's tier changes (up or down), this service re-evaluates all
 * lockable resources and locks excess beyond the new tier's limits.
 *
 * STATIC locking: once locked at tier-change time, resources stay locked
 * until the next tier change. Deleting unlocked resources frees creation
 * slots but does NOT unlock any locked resource.
 */

const Content = require('../models/Content');
const Workspace = require('../models/Workspace');
const Avatar = require('../models/Avatar');
const OrgMember = require('../models/OrgMember');
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

async function lockArticles(orgId, limit) {
  if (limit === null || limit === undefined) {
    // Unlimited — unlock all articles for this org
    const wsIds = await getOrgWorkspaceIds(orgId);
    if (wsIds.length > 0) {
      await Content.updateMany(
        { workspaceId: { $in: wsIds }, locked: true },
        { $set: { locked: false } }
      );
    }
    return;
  }

  const wsIds = await getOrgWorkspaceIds(orgId);
  if (wsIds.length === 0) return;

  // Sort oldest first — oldest N stay unlocked
  const articles = await Content.find({ workspaceId: { $in: wsIds } })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();

  await applyLocks(Content, articles.map((a) => a._id), limit);
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

async function lockBrandVoices(orgId, limit) {
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

  const avatars = await Avatar.find({ workspace: { $in: wsIds } })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();

  await applyLocks(Avatar, avatars.map((a) => a._id), limit);
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
  const { config } = await tierService.getOrgTierConfig(orgId);
  if (!config) {
    console.warn(`[downgradeService] No tier config found for org ${orgId}, skipping lock`);
    return;
  }

  await Promise.all([
    lockArticles(orgId, config.maxArticlesPerMonth),
    lockWorkspaces(orgId, config.maxWorkspaces),
    lockBrandVoices(orgId, config.maxBrandVoices),
    lockMembers(orgId, config.maxSeats),
  ]);

  console.log(`[downgradeService] Applied locks for org ${orgId} (tier: ${config.tier || config.displayName})`);
}

module.exports = {
  applyLocksForOrg,
};
