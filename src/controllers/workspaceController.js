const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const Organization = require('../models/Organization');
const User = require('../models/User');
const OrgMember = require('../models/OrgMember');
const tierService = require('../services/tierService');

// ─── GET WORKSPACE (resolve through active org — no ghost creation) ──
const getWorkspace = async (req, res) => {
  try {
    const userId = req.user.userId;

    // 1. Find user's organization (owned first, then membership)
    let orgId;
    const ownedOrg = await Organization.findOne({ ownerId: userId }).lean();
    if (ownedOrg) {
      orgId = ownedOrg._id;
    } else {
      const membership = await OrgMember.findOne({ userId }).lean();
      if (membership) orgId = membership.organizationId;
    }

    if (!orgId) {
      // No org at all — create one with a default workspace
      const org = await Organization.create({ name: 'My Organization', ownerId: userId });
      const workspaceNumber = await Workspace.getNextNumber();
      const workspace = await Workspace.create({
        workspaceNumber,
        userId,
        organizationId: org._id,
        isDefault: true,
      });
      return res.json({ workspace });
    }

    // 2. Find active workspace in that org, or default, or first
    const user = await User.findById(userId, 'activeWorkspaceId').lean();
    let workspace;
    if (user?.activeWorkspaceId) {
      workspace = await Workspace.findOne({ _id: user.activeWorkspaceId, organizationId: orgId }).lean();
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ organizationId: orgId, isDefault: true }).lean();
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ organizationId: orgId }).lean();
    }

    if (!workspace) {
      // Org exists but has no workspaces — create a default one
      const workspaceNumber = await Workspace.getNextNumber();
      workspace = await Workspace.create({
        workspaceNumber,
        userId,
        organizationId: orgId,
        isDefault: true,
      });
    }

    res.json({ workspace });
  } catch (err) {
    console.error('getWorkspace error:', err.message);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
};

// ─── ENSURE DEFAULT WORKSPACE ──────────────────────────────────
async function ensureDefaultWorkspace(userId) {
  const count = await Workspace.countDocuments({ userId });
  if (count === 0) {
    try {
      const workspaceNumber = await Workspace.getNextNumber();
      return await Workspace.create({
        workspaceNumber,
        name: 'My Workspace',
        userId,
        color: '#6366F1',
        isDefault: true,
      });
    } catch (error) {
      // Handle race condition: another request already created it
      if (error.code === 11000) return null;
      throw error;
    }
  }
  return null;
}

// ─── LIST WORKSPACES ─────────────────────────────────────────────
const listWorkspaces = async (req, res) => {
  try {
    await ensureDefaultWorkspace(req.user.userId);

    // Get org memberships (new RBAC system)
    const memberships = await OrgMember.find({
      userId: req.user.userId,
      status: 'active',
    }).lean();

    // Build role lookup: organizationId → role, ownerId → role
    const roleByOrg = {};
    const roleByOwner = {};
    const memberOrgIds = [];
    const memberOwnerIds = [];
    for (const m of memberships) {
      if (m.organizationId) {
        roleByOrg[m.organizationId.toString()] = m.role;
        memberOrgIds.push(m.organizationId);
      }
      roleByOwner[m.ownerId.toString()] = m.role;
      memberOwnerIds.push(m.ownerId);
    }

    // Orgs the user owns (for workspaces belonging to those orgs)
    const ownedOrgs = await Organization.find({ ownerId: req.user.userId }).select('_id').lean();
    const ownedOrgIds = ownedOrgs.map((o) => o._id);

    // Query workspaces: own + org-owned + org-member + owner-member + legacy
    const workspaces = await Workspace.find({
      $or: [
        { userId: req.user.userId },
        { organizationId: { $in: ownedOrgIds } },
        { organizationId: { $in: memberOrgIds } },
        { userId: { $in: memberOwnerIds } },
        { 'members.userId': req.user.userId }, // legacy fallback
      ],
    })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();

    // Deduplicate (a workspace might match multiple $or conditions)
    const seen = new Set();
    const deduped = workspaces.filter((ws) => {
      const key = ws._id.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Enrich with role
    const enriched = deduped.map((ws) => {
      // Org-based workspaces: org role takes priority over ws.userId (creator)
      // because ownership can be transferred, making the creator a non-owner.
      if (ws.organizationId) {
        // Org owner
        if (ownedOrgIds.some((id) => id.equals(ws.organizationId))) {
          return { ...ws, role: 'owner' };
        }
        // Org member
        const orgRole = roleByOrg[ws.organizationId.toString()];
        if (orgRole) return { ...ws, role: orgRole };
      }
      // Personal workspace (no org): creator is always owner
      if (ws.userId.equals(req.user.userId)) {
        return { ...ws, role: 'owner' };
      }
      // Owner-based member (pre-multi-org)
      const ownerRole = roleByOwner[ws.userId.toString()];
      if (ownerRole) return { ...ws, role: ownerRole };
      // Legacy fallback
      return { ...ws, role: 'editor' };
    });

    res.json({ workspaces: enriched });
  } catch (error) {
    console.error('List workspaces error:', error);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
};

// ─── CREATE WORKSPACE ────────────────────────────────────────────
const createWorkspace = async (req, res) => {
  try {
    const { name, color, organizationId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Workspace name is required' });
    }

    // If org specified, verify user is owner or admin
    let orgId = null;
    if (organizationId) {
      const org = await Organization.findById(organizationId).lean();
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      const isOrgOwner = org.ownerId.equals(req.user.userId);
      if (!isOrgOwner) {
        const mem = await OrgMember.findMembershipByOrg(org._id, req.user.userId);
        if (!mem || !['admin'].includes(mem.role)) {
          return res.status(403).json({ error: 'Only org owners or admins can create workspaces' });
        }
      }
      orgId = org._id;
    }

    // Enforce per-org workspace limit from tier config
    if (orgId) {
      const { config, tier } = await tierService.getOrgTierConfig(orgId);
      const maxWs = config?.maxWorkspaces;
      if (maxWs != null) {
        const wsCount = await Workspace.countDocuments({ organizationId: orgId, locked: { $ne: true } });
        if (wsCount >= maxWs) {
          return res.status(429).json({
            error: `Your ${config.displayName || tier} plan allows ${maxWs} workspace(s). Upgrade for more.`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: maxWs, used: wsCount, tier, limitKey: 'maxWorkspaces' },
          });
        }
      }
    }
    const workspaceNumber = await Workspace.getNextNumber();
    const workspace = await Workspace.create({
      workspaceNumber,
      name: name.trim(),
      userId: req.user.userId,
      organizationId: orgId,
      color: color || '#6366F1',
    });
    res.status(201).json({ workspace });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A workspace with this name already exists' });
    }
    console.error('Create workspace error:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
};

// ─── UPDATE WORKSPACE ────────────────────────────────────────────
const updateWorkspace = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { name, color } = req.body;
    const workspace = await Workspace.findOne({ _id: workspaceId, userId: req.user.userId });
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (name !== undefined) workspace.name = name.trim();
    if (color !== undefined) workspace.color = color;
    await workspace.save();
    res.json({ workspace });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A workspace with this name already exists' });
    }
    console.error('Update workspace error:', error);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
};

// ─── DELETE WORKSPACE ────────────────────────────────────────────
const deleteWorkspace = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    // Permission: org owner for org workspaces, creator for personal
    if (workspace.organizationId) {
      const org = await Organization.findById(workspace.organizationId).select('ownerId').lean();
      if (!org?.ownerId.equals(req.user.userId)) {
        return res.status(403).json({ error: 'Only the organization owner can delete workspaces' });
      }
    } else if (!workspace.userId.equals(req.user.userId)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    // Block deletion if workspace has content (articles)
    const Article = mongoose.models.Article;
    if (Article) {
      const articleCount = await Article.countDocuments({ workspaceId: workspaceId });
      if (articleCount > 0) {
        return res.status(400).json({ error: 'Cannot delete a workspace that has content. Move or delete its articles first.' });
      }
    }
    // If deleting the default workspace, promote the next oldest in the same org
    if (workspace.isDefault) {
      const filter = workspace.organizationId
        ? { organizationId: workspace.organizationId, _id: { $ne: workspace._id } }
        : { userId: workspace.userId, _id: { $ne: workspace._id } };
      await Workspace.findOneAndUpdate(filter, { $set: { isDefault: true } }, { sort: { createdAt: 1 } });
    }
    await workspace.deleteOne();
    await User.updateOne(
      { _id: req.user.userId, activeWorkspaceId: workspaceId },
      { $set: { activeWorkspaceId: null } }
    );
    res.json({ message: 'Workspace deleted' });
  } catch (error) {
    console.error('Delete workspace error:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
};

// ─── SET ACTIVE WORKSPACE ────────────────────────────────────────
const setActiveWorkspace = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Check access: org owner/member, personal workspace creator, or legacy member
    let hasAccess = false;
    if (workspace.organizationId) {
      const org = await Organization.findById(workspace.organizationId).select('ownerId').lean();
      if (org?.ownerId.equals(req.user.userId)) {
        hasAccess = true;
      } else {
        const membership = await OrgMember.findMembershipByOrg(workspace.organizationId, req.user.userId);
        if (membership) hasAccess = true;
      }
    }
    if (!hasAccess && !workspace.organizationId && workspace.userId.equals(req.user.userId)) {
      hasAccess = true; // personal workspace creator
    }
    if (!hasAccess && !workspace.organizationId) {
      // Legacy fallback (non-org workspaces only)
      const legacyMember = await OrgMember.findMembership(workspace.userId, req.user.userId);
      if (legacyMember) hasAccess = true;
      if (!hasAccess && workspace.members?.some((m) => m.userId.equals(req.user.userId))) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this workspace' });
    }

    await User.updateOne(
      { _id: req.user.userId },
      { $set: { activeWorkspaceId: workspaceId } }
    );
    res.json({ activeWorkspaceId: workspaceId });
  } catch (error) {
    console.error('Set active workspace error:', error);
    res.status(500).json({ error: 'Failed to set active workspace' });
  }
};

// ─── GET MEMBERS ──────────────────────────────────────────────
const getMembers = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const workspace = await Workspace.findOne({
      _id: workspaceId,
      $or: [
        { userId: req.user.userId },
        { 'members.userId': req.user.userId },
      ],
    });
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    // For org workspaces, the real owner is Organization.ownerId (not workspace.userId which is the creator)
    let ownerId = workspace.userId;
    if (workspace.organizationId) {
      const org = await Organization.findById(workspace.organizationId).select('ownerId').lean();
      if (org) ownerId = org.ownerId;
    }
    const owner = await User.findById(ownerId).select('email profile.name profile.picture').lean();
    res.json({
      owner: {
        userId: ownerId,
        email: owner?.email || '',
        name: owner?.profile?.name || '',
        picture: owner?.profile?.picture || '',
      },
      members: (workspace.members || []).map((m) => ({
        userId: m.userId,
        email: m.email,
        addedAt: m.addedAt,
      })),
      isOwner: ownerId.equals(req.user.userId),
    });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
};

// ─── ADD MEMBER ───────────────────────────────────────────────
const addMember = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { email } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    // Only owner can add members
    const workspace = await Workspace.findOne({ _id: workspaceId, userId: req.user.userId });
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found or you are not the owner' });
    }
    if ((workspace.members || []).length >= 3) {
      return res.status(400).json({ error: 'Maximum 3 members allowed per workspace' });
    }
    const targetUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (!targetUser) {
      return res.status(404).json({ error: 'No user found with that email' });
    }
    if (targetUser._id.equals(req.user.userId)) {
      return res.status(400).json({ error: 'You are already the owner of this workspace' });
    }
    const alreadyMember = (workspace.members || []).some((m) => m.userId.equals(targetUser._id));
    if (alreadyMember) {
      return res.status(409).json({ error: 'This user is already a member' });
    }
    workspace.members.push({
      userId: targetUser._id,
      email: targetUser.email,
      addedAt: new Date(),
    });
    await workspace.save();
    res.status(201).json({
      member: {
        userId: targetUser._id,
        email: targetUser.email,
        addedAt: new Date(),
      },
    });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
};

// ─── REMOVE MEMBER ────────────────────────────────────────────
const removeMember = async (req, res) => {
  try {
    const { workspaceId, memberId } = req.params;
    // Only owner can remove members
    const workspace = await Workspace.findOne({ _id: workspaceId, userId: req.user.userId });
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found or you are not the owner' });
    }
    const memberIndex = (workspace.members || []).findIndex(
      (m) => m.userId.toString() === memberId
    );
    if (memberIndex === -1) {
      return res.status(404).json({ error: 'Member not found' });
    }
    workspace.members.splice(memberIndex, 1);
    await workspace.save();
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

// ─── MOVE WORKSPACE TO ANOTHER ORG ──────────────────────────
const moveWorkspace = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { targetOrgId } = req.body;
    if (!targetOrgId) {
      return res.status(400).json({ error: 'targetOrgId is required' });
    }

    const workspace = await Workspace.findOne({ _id: workspaceId, userId: req.user.userId });
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found or you are not the owner' });
    }

    const targetOrg = await Organization.findById(targetOrgId).lean();
    if (!targetOrg) {
      return res.status(404).json({ error: 'Target organization not found' });
    }
    if (!targetOrg.ownerId.equals(req.user.userId)) {
      return res.status(403).json({ error: 'You must own the target organization' });
    }

    workspace.organizationId = targetOrg._id;
    await workspace.save();

    res.json({ workspace });
  } catch (error) {
    console.error('Move workspace error:', error);
    res.status(500).json({ error: 'Failed to move workspace' });
  }
};

module.exports = { getWorkspace, listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, setActiveWorkspace, getMembers, addMember, removeMember, moveWorkspace };
