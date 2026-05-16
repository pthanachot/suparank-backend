const User = require('../models/User');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const Role = require('../models/Role');
const FeatureFlag = require('../models/FeatureFlag');
const tierService = require('../services/tierService');
const { ORG_CONFIG } = require('../scripts/configOrganization');

// ─── Helper: resolve org + check caller is owner/admin ──────

async function resolveOrgWithAccess(req, res, requireOwnerOrAdmin = false) {
  const { orgId } = req.params;
  if (!orgId) {
    res.status(400).json({ error: 'Organization ID is required' });
    return null;
  }

  const org = await Organization.findById(orgId).lean();
  if (!org) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }

  const isOwner = org.ownerId.equals(req.user.userId);
  if (isOwner) return { org, callerRole: 'owner' };

  const membership = await OrgMember.findMembershipByOrg(org._id, req.user.userId);
  if (!membership) {
    res.status(403).json({ error: 'You do not have access to this organization' });
    return null;
  }

  if (requireOwnerOrAdmin && !['admin'].includes(membership.role)) {
    res.status(403).json({ error: 'Only organization owners or admins can perform this action' });
    return null;
  }

  return { org, callerRole: membership.role };
}

// ─── LIST MEMBERS ────────────────────────────────────────────────
// GET /api/organizations/:orgId/members
// Returns the org owner + all org members with roles.

const listMembers = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res);
    if (!result) return;
    const { org } = result;

    const members = await OrgMember.find({ organizationId: org._id })
      .sort({ createdAt: 1 })
      .lean();

    // ── Enforce seat-based locking based on current tier ──
    const { config } = await tierService.getOrgTierConfig(org._id);
    let effectiveMaxSeats = null;
    if (config?.maxSeats != null) {
      const sub = await Subscription.findOne({
        organizationId: org._id,
        status: { $in: ['active', 'trialing'] },
      }).lean();
      const extraSeats = sub?.purchasedExtraSeats || 0;
      effectiveMaxSeats = config.maxSeats + extraSeats;
    }
    // Owner takes 1 seat (implicit, not in OrgMember)
    const memberSlots = effectiveMaxSeats != null ? Math.max(0, effectiveMaxSeats - 1) : null;

    // Populate user info for each member
    const userIds = members.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select('email profile.name profile.picture')
      .lean();
    const userMap = {};
    for (const u of users) {
      userMap[u._id.toString()] = u;
    }

    // Persist lock state to DB if it differs from computed state
    if (memberSlots != null) {
      const toLock = [];
      const toUnlock = [];
      for (let i = 0; i < members.length; i++) {
        const shouldLock = i >= memberSlots;
        if (shouldLock && !members[i].locked) toLock.push(members[i]._id);
        if (!shouldLock && members[i].locked) toUnlock.push(members[i]._id);
      }
      if (toLock.length > 0) {
        await OrgMember.updateMany({ _id: { $in: toLock } }, { $set: { locked: true } });
      }
      if (toUnlock.length > 0) {
        await OrgMember.updateMany({ _id: { $in: toUnlock } }, { $set: { locked: false } });
      }
    }

    const enriched = members.map((m, idx) => {
      const u = userMap[m.userId.toString()];
      const locked = memberSlots != null ? idx >= memberSlots : false;
      return {
        _id: m._id,
        userId: m.userId,
        email: m.email,
        name: u?.profile?.name || '',
        picture: u?.profile?.picture || '',
        role: m.role,
        status: m.status,
        locked,
        invitedAt: m.invitedAt,
      };
    });

    // Get owner info
    const owner = await User.findById(org.ownerId)
      .select('email profile.name profile.picture')
      .lean();

    res.json({
      organization: { _id: org._id, name: org.name, slug: org.slug },
      owner: {
        userId: org.ownerId,
        email: owner?.email || '',
        name: owner?.profile?.name || '',
        picture: owner?.profile?.picture || '',
        role: 'owner',
      },
      members: enriched,
    });
  } catch (error) {
    console.error('List org members error:', error);
    res.status(500).json({ error: 'Failed to list members' });
  }
};

// ─── INVITE MEMBER ───────────────────────────────────────────────
// POST /api/organizations/:orgId/members
// Body: { email, role }

const inviteMember = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org } = result;

    const { email, role } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    // Check seat limit from TierConfig (base + purchased extra seats)
    const { config, tier } = await tierService.getOrgTierConfig(org._id);
    if (config?.maxSeats != null) {
      const sub = await Subscription.findOne({
        organizationId: org._id,
        status: { $in: ['active', 'trialing'] },
      }).lean();
      const extraSeats = sub?.purchasedExtraSeats || 0;
      const effectiveMaxSeats = config.maxSeats + extraSeats;

      const memberCount = await OrgMember.countDocuments({ organizationId: org._id, locked: { $ne: true } });
      // +1 because the org owner is not in OrgMember but counts as a seat
      const totalSeats = memberCount + 1;
      if (totalSeats >= effectiveMaxSeats) {
        return res.status(429).json({
          error: `Your ${config.displayName || tier} plan allows ${effectiveMaxSeats} seat(s).${extraSeats > 0 ? '' : ' Upgrade or purchase extra seats for more.'}`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: effectiveMaxSeats, used: totalSeats, tier, limitKey: 'maxSeats' },
        });
      }
    }

    const targetUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (!targetUser) {
      return res.status(404).json({ error: 'No user found with that email' });
    }
    if (targetUser._id.equals(org.ownerId)) {
      return res.status(400).json({ error: 'Cannot invite the organization owner' });
    }

    // Check if already a member of this org
    const existing = await OrgMember.findOne({
      organizationId: org._id,
      userId: targetUser._id,
    });
    if (existing) {
      return res.status(409).json({ error: 'This user is already a member' });
    }

    const member = await OrgMember.create({
      organizationId: org._id,
      ownerId: org.ownerId,
      userId: targetUser._id,
      email: targetUser.email,
      role,
      status: 'active',
      invitedAt: new Date(),
    });

    res.status(201).json({
      member: {
        _id: member._id,
        userId: targetUser._id,
        email: targetUser.email,
        name: targetUser.profile?.name || '',
        picture: targetUser.profile?.picture || '',
        role: member.role,
        status: member.status,
        invitedAt: member.invitedAt,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'This user is already a member' });
    }
    console.error('Invite org member error:', error);
    res.status(500).json({ error: 'Failed to invite member' });
  }
};

// ─── CHANGE ROLE ─────────────────────────────────────────────────
// PUT /api/organizations/:orgId/members/:memberId/role
// Body: { role }

const changeRole = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org } = result;

    const { memberId } = req.params;
    const { role } = req.body;

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    const member = await OrgMember.findOne({
      _id: memberId,
      organizationId: org._id,
    });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    member.role = role;
    await member.save();

    res.json({ member: { _id: member._id, userId: member.userId, role: member.role } });
  } catch (error) {
    console.error('Change role error:', error);
    res.status(500).json({ error: 'Failed to change role' });
  }
};

// ─── REMOVE MEMBER ───────────────────────────────────────────────
// DELETE /api/organizations/:orgId/members/:memberId

const removeMember = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org } = result;

    const { memberId } = req.params;

    const member = await OrgMember.findOneAndDelete({
      _id: memberId,
      organizationId: org._id,
    });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove org member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

// ─── LIST ROLES ──────────────────────────────────────────────────
// GET /api/org/roles — returns available roles for assignment

const listRoles = async (req, res) => {
  try {
    const roles = await Role.find({ isSystem: true })
      .sort({ level: 1 })
      .select('name displayName description level')
      .lean();
    // Exclude 'owner' — it's implicit, not assignable
    res.json({ roles: roles.filter((r) => r.name !== 'owner') });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ error: 'Failed to list roles' });
  }
};

// ─── LIST FEATURE FLAGS ─────────────────────────────────────────
// GET /api/org/feature-flags — returns enabled flags for frontend

const listFeatureFlags = async (req, res) => {
  try {
    const flags = await FeatureFlag.find({ enabled: true })
      .select('key displayName description implemented conditions')
      .lean();
    res.json({ flags });
  } catch (error) {
    console.error('List feature flags error:', error);
    res.status(500).json({ error: 'Failed to list feature flags' });
  }
};

// ─── TRANSFER OWNERSHIP ─────────────────────────────────────────
// POST /api/organizations/:orgId/transfer-ownership
// Body: { newOwnerMemberId, selfRole }
// Only the current owner can transfer ownership.

const transferOwnership = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { newOwnerMemberId, selfRole } = req.body;

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Only current owner can transfer
    if (!org.ownerId.equals(req.user.userId)) {
      return res.status(403).json({ error: 'Only the owner can transfer ownership' });
    }

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(selfRole)) {
      return res.status(400).json({ error: `selfRole must be one of: ${validRoles.join(', ')}` });
    }

    // Find the successor member
    const successor = await OrgMember.findOne({ _id: newOwnerMemberId, organizationId: org._id });
    if (!successor) return res.status(404).json({ error: 'Successor member not found' });

    const successorUserId = successor.userId;
    const oldOwnerId = org.ownerId;

    // ── Block transfer to users with pending account deletion ──
    const successorUser = await User.findById(successorUserId).select('status').lean();
    if (successorUser?.status === 'pending_deletion') {
      return res.status(400).json({ error: 'Cannot transfer ownership to a user with pending account deletion' });
    }

    // ── Check if successor can own another org (global limit from configOrganization.js) ──
    const maxOrgs = ORG_CONFIG.maxOrganizationsPerUser;
    if (maxOrgs != null) {
      const successorOwnedCount = await Organization.countDocuments({ ownerId: successorUserId });
      if (successorOwnedCount >= maxOrgs) {
        return res.status(429).json({
          error: `The new owner already owns ${successorOwnedCount} organization(s). The limit is ${maxOrgs}.`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: maxOrgs, used: successorOwnedCount, limitKey: 'maxOrganizationsPerUser' },
        });
      }
    }

    // 1. Update org owner to successor
    org.ownerId = successorUserId;
    await org.save();

    // 2. Remove successor's OrgMember record (owner is implicit, not in OrgMember)
    await OrgMember.findByIdAndDelete(successor._id);

    // 3. Create OrgMember record for the old owner with their chosen role
    const oldOwnerUser = await User.findById(oldOwnerId).select('email').lean();
    await OrgMember.create({
      organizationId: org._id,
      ownerId: successorUserId,
      userId: oldOwnerId,
      email: oldOwnerUser?.email || '',
      role: selfRole,
      status: 'active',
      invitedAt: new Date(),
    });

    res.json({ message: 'Ownership transferred successfully' });
  } catch (error) {
    console.error('Transfer ownership error:', error);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  }
};

// ─── LEAVE ORGANIZATION ─────────────────────────────────────
const leaveOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await Organization.findById(orgId).lean();
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Owner cannot leave — must transfer ownership first
    if (org.ownerId.equals(req.user.userId)) {
      return res.status(400).json({
        error: 'As the owner, you must transfer ownership before leaving the organization.',
      });
    }

    const membership = await OrgMember.findOne({
      organizationId: org._id,
      userId: req.user.userId,
    });
    if (!membership) {
      return res.status(404).json({ error: 'You are not a member of this organization' });
    }

    await OrgMember.findByIdAndDelete(membership._id);
    res.json({ message: 'You have left the organization' });
  } catch (error) {
    console.error('Leave organization error:', error);
    res.status(500).json({ error: 'Failed to leave organization' });
  }
};

module.exports = { listMembers, inviteMember, changeRole, removeMember, listRoles, listFeatureFlags, transferOwnership, leaveOrganization };
