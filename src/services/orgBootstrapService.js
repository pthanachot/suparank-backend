/**
 * orgBootstrapService
 *
 * Single source of truth for giving a user a default organization + workspace.
 *
 *  - bootstrapNewUser(userId, displayName): atomically (in a transaction) create
 *    a default org + workspace and set it active. Retries on transient
 *    transaction errors and duplicate-key collisions. Throws if it cannot
 *    complete — callers decide whether to surface or swallow.
 *
 *  - ensureUserHasOrg(user): idempotent self-heal. No-op if the user already
 *    owns or belongs to an org; otherwise bootstraps one. Never throws.
 *
 * Both are safe to call repeatedly: the unique indexes on Organization
 * ({ownerId,name} + slug) and Workspace ({userId,name} + workspaceNumber)
 * guarantee at most one default org/workspace per user even under concurrency.
 */

const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const OrgMember = require('../models/OrgMember');
const tierService = require('./tierService');
const creditService = require('./creditService');
const { FREE_SAMPLE_POOL_CREDITS } = require('../config/creditRules');

const BOOTSTRAP_MAX_RETRIES = 3;

// Best-effort, idempotent free-credit grant for a freshly created org.
// Non-critical: kept OUTSIDE the org/workspace transaction so a credit
// hiccup can never roll back (or block) account provisioning.
//
// Phase 7 / Option B: a new Free org is seeded the ONE-TIME 200-credit lifetime
// sample pool (user_free) so it can try in-editor AI. This is a FIXED amount
// (creditRules.FREE_SAMPLE_POOL_CREDITS), NOT config.creditsPerMonth — Free's
// creditsPerMonth is 0. Paid tiers receive their monthly allocation via the
// subscription webhook, never here (and new orgs are always Free at bootstrap).
// grantFreeCreditsIfNew is idempotent per user (lifetime — nothing renews).
async function grantOrgFreeCredits(userId, orgId) {
  try {
    const { tier } = await tierService.getOrgTierConfig(orgId);
    if (!tier || tier === 'free') {
      await creditService.grantFreeCreditsIfNew(userId, FREE_SAMPLE_POOL_CREDITS);
    }
  } catch (err) {
    console.error(`[orgBootstrap] credit grant failed user=${userId} org=${orgId}:`, err.message);
  }
}

/**
 * Atomically create a default organization + workspace for a user and mark it
 * active. If the user already has orphan workspaces (organizationId: null,
 * legacy pre-org accounts), those are adopted into the new org instead of
 * creating a duplicate "My Workspace" (which would collide on {userId,name}).
 *
 * @returns {Promise<{org, workspace}>}
 * @throws if it cannot complete after BOOTSTRAP_MAX_RETRIES.
 */
async function bootstrapNewUser(userId, displayName) {
  const orgName = displayName ? `${displayName}'s Organization` : 'My Organization';

  let result = null;
  let lastErr = null;

  for (let attempt = 0; attempt < BOOTSTRAP_MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const slug = await Organization.generateSlug(orgName, userId);
      // isPersonal: true — this is the user's home org. It is non-deletable
      // (see deleteOrganization guard) and is the org resolved by the
      // `findOne({ownerId, isPersonal:true})` lookups across the codebase
      // (credits, tier, permissions, webhooks). Exactly one per user.
      const [org] = await Organization.create(
        [{ name: orgName, slug, ownerId: userId, isPersonal: true }],
        { session }
      );

      // Adopt any orphan workspaces (legacy users) rather than duplicating.
      const adopt = await Workspace.updateMany(
        { userId, organizationId: null },
        { $set: { organizationId: org._id } },
        { session }
      );

      let workspace;
      if (adopt.modifiedCount > 0) {
        // Prefer a default workspace, else the oldest, as the active one.
        workspace = await Workspace.findOne({ userId, organizationId: org._id })
          .sort({ isDefault: -1, createdAt: 1 })
          .session(session);
      } else {
        const workspaceNumber = await Workspace.getNextNumber(session);
        [workspace] = await Workspace.create(
          [{
            workspaceNumber,
            name: 'My Workspace',
            userId,
            organizationId: org._id,
            isDefault: true,
          }],
          { session }
        );
      }

      await User.findByIdAndUpdate(
        userId,
        { activeWorkspaceId: workspace._id },
        { session }
      );

      await session.commitTransaction();
      session.endSession();
      result = { org, workspace };
      break;
    } catch (err) {
      lastErr = err;
      try {
        await session.abortTransaction();
      } catch {
        /* transaction may already be aborted */
      }
      session.endSession();

      // Retry on: transient tx errors, unknown commit result (network blip on
      // commit — re-running is safe because the {ownerId,name} unique index
      // prevents a duplicate org), and workspaceNumber/slug collisions (11000).
      const hasLabel = (l) => typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel(l);
      const retriable =
        hasLabel('TransientTransactionError') ||
        hasLabel('UnknownTransactionCommitResult') ||
        err?.code === 11000;
      if (retriable && attempt < BOOTSTRAP_MAX_RETRIES - 1) continue;
      throw err;
    }
  }

  if (!result) throw lastErr || new Error('bootstrapNewUser: failed to provision org/workspace');

  await grantOrgFreeCredits(userId, result.org._id);

  return result;
}

/**
 * Idempotent self-heal. Guarantees the user has at least one organization.
 * No-op (returns null) if they already own or are an active member of one.
 * Never throws — logs and returns null on failure so callers in hot paths
 * (login, org list) are never broken by a provisioning hiccup.
 *
 * @param {{_id: any, profile?: {name?: string}}} user
 * @returns {Promise<{org, workspace}|null>} the healed result, or null.
 */
async function ensureUserHasOrg(user) {
  if (!user?._id) return null;
  const userId = user._id;

  try {
    if (await Organization.exists({ ownerId: userId })) return null;
    if (await OrgMember.exists({ userId, status: 'active' })) return null;
    return await bootstrapNewUser(userId, user.profile?.name);
  } catch (err) {
    console.error(`[orgBootstrap] ensureUserHasOrg failed user=${userId}:`, err.message);
    return null;
  }
}

module.exports = { bootstrapNewUser, ensureUserHasOrg, grantOrgFreeCredits };
