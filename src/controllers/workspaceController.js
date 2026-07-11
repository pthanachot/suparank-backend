const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const Organization = require('../models/Organization');
const User = require('../models/User');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
const { resolveWorkspaceRole } = require('../middleware/permissions');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');
const auditService = require('../services/auditService');

/** Audit shorthand for workspace lifecycle events (fire-and-forget). */
function auditWorkspace(req, organizationId, workspace, action, extraMeta = {}) {
  auditService.record({
    organizationId,
    workspaceId: workspace._id,
    userId: req.user.userId,
    actorEmail: req.user.email,
    impersonatedBy: req.user?.impersonatedBy || null,
    action,
    resourceId: workspace._id,
    meta: { name: workspace.name, ...extraMeta },
    ip: req.ip,
  });
}

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
      // Grant free-tier credits as general (non-expiring) credits
      try {
        const { config } = await tierService.getOrgTierConfig(org._id);
        if (config?.creditsPerMonth) {
          await creditService.grantGeneralCredits(org._id, config.creditsPerMonth, 'Free-tier initial credits');
        }
      } catch (err) {
        console.error(`[credits] Failed to grant free-tier credits for org=${org._id}:`, err.message);
      }
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

// ─── LIST WORKSPACES ─────────────────────────────────────────────
const listWorkspaces = async (req, res) => {
  try {
    // Get org memberships (new RBAC system)
    const memberships = await OrgMember.find({
      userId: req.user.userId,
      status: 'active',
    }).lean();

    // Build role lookup: organizationId → role, ownerId → role.
    // accessScope 'assigned' members do NOT get org-wide visibility —
    // their workspaces come exclusively from WorkspaceMember grants.
    const roleByOrg = {};
    const roleByOwner = {};
    const memberOrgIds = []; // 'all'-scope org memberships only
    const memberOwnerIds = [];
    const assignedOrgIds = [];
    for (const m of memberships) {
      if (m.accessScope === 'assigned') {
        if (m.organizationId) assignedOrgIds.push(m.organizationId);
        continue;
      }
      if (m.organizationId) {
        roleByOrg[m.organizationId.toString()] = m.role;
        memberOrgIds.push(m.organizationId);
      }
      roleByOwner[m.ownerId.toString()] = m.role;
      memberOwnerIds.push(m.ownerId);
    }

    // Per-workspace grants for 'assigned'-scope memberships
    const grants = assignedOrgIds.length
      ? await WorkspaceMember.find({
          organizationId: { $in: assignedOrgIds },
          userId: req.user.userId,
          status: 'active',
          locked: { $ne: true },
        })
          .select('workspaceId role')
          .lean()
      : [];
    const roleByWorkspaceId = {};
    const grantedWorkspaceIds = grants.map((g) => {
      roleByWorkspaceId[g.workspaceId.toString()] = g.role;
      return g.workspaceId;
    });

    // Orgs the user owns (for workspaces belonging to those orgs)
    const ownedOrgs = await Organization.find({ ownerId: req.user.userId }).select('_id').lean();
    const ownedOrgIds = ownedOrgs.map((o) => o._id);

    // Query workspaces: own + org-owned + org-member (all-scope) +
    // granted (assigned-scope) + owner-member + legacy
    const workspaces = await Workspace.find({
      $or: [
        { userId: req.user.userId },
        { organizationId: { $in: ownedOrgIds } },
        { organizationId: { $in: memberOrgIds } },
        { _id: { $in: grantedWorkspaceIds } },
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
        // Assigned-scope member: role from the per-workspace grant
        const grantRole = roleByWorkspaceId[ws._id.toString()];
        if (grantRole) return { ...ws, role: grantRole };
        // Org member ('all' scope)
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
    auditWorkspace(req, orgId, workspace, 'workspace.create');
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
    // Guard the type before .trim(): a `{name:null}` (or non-string) body
    // previously passed the `!== undefined` check and threw on null.trim() → 500.
    // Validate to a clean 400 instead. (name is required, so empty is rejected.)
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name must be a non-empty string' });
      }
      workspace.name = name.trim();
    }
    if (color !== undefined) workspace.color = color;
    await workspace.save();
    auditWorkspace(req, workspace.organizationId, workspace, 'workspace.update');
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
    // Cascade-delete all workspace content
    const trackerIds = [];
    const AiTracker = mongoose.models.AiTracker;
    if (AiTracker) {
      const trackers = await AiTracker.find({ workspaceId }, '_id').lean();
      trackerIds.push(...trackers.map(t => t._id));
    }
    if (trackerIds.length > 0) {
      const AiTrackerPrompt = mongoose.models.AiTrackerPrompt;
      const AiTrackerCompetitor = mongoose.models.AiTrackerCompetitor;
      const AiTrackerScan = mongoose.models.AiTrackerScan;
      if (AiTrackerPrompt) await AiTrackerPrompt.deleteMany({ trackerId: { $in: trackerIds } });
      if (AiTrackerCompetitor) await AiTrackerCompetitor.deleteMany({ trackerId: { $in: trackerIds } });
      if (AiTrackerScan) await AiTrackerScan.deleteMany({ trackerId: { $in: trackerIds } });
      await AiTracker.deleteMany({ workspaceId });
    }
    const cascadeModels = [
      { model: 'Content',                filter: { workspaceId } },
      { model: 'KeywordResearchHistory', filter: { workspaceId } },
      { model: 'BrandVoice',             filter: { workspace: workspaceId } },
      { model: 'Avatar',                 filter: { workspace: workspaceId } },
      { model: 'Site',                   filter: { workspaceId } },
    ];
    for (const { model: name, filter } of cascadeModels) {
      const Model = mongoose.models[name];
      if (Model) await Model.deleteMany(filter);
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
    auditWorkspace(req, workspace.organizationId, workspace, 'workspace.delete');
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
    const workspace = await Workspace.findById(workspaceId);
    // F1/B1: gate on the modern OrgMember-based role resolution (the same core
    // the rwr middleware uses) instead of the legacy `members[] OR userId`
    // re-query, which locked out every org-scoped teammate. This route is keyed
    // by _id (not workspaceNumber), so it can't use rwr directly — it shares
    // rwr's logic via the extracted helper. 404 (not 403) on no-access
    // preserves the prior contract (the old $or filter yielded "not found").
    if (!workspace || !(await resolveWorkspaceRole(workspace, req.user.userId))) {
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

    // No-op if the workspace is already in the target org.
    if (workspace.organizationId && workspace.organizationId.equals(targetOrg._id)) {
      return res.json({ workspace });
    }

    // Enforce target org's tier maxWorkspaces — moving in shouldn't push
    // the destination over its quota.
    const { config, tier } = await tierService.getOrgTierConfig(targetOrg._id);
    const maxWs = config?.maxWorkspaces;
    if (maxWs != null) {
      const wsCount = await Workspace.countDocuments({
        organizationId: targetOrg._id,
        locked: { $ne: true },
      });
      if (wsCount >= maxWs) {
        return res.status(429).json({
          error: `Your ${config.displayName || tier} plan allows ${maxWs} workspace(s) in the target organization. Upgrade or remove a workspace first.`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: maxWs, used: wsCount, tier, limitKey: 'maxWorkspaces' },
        });
      }
    }

    // Record the departure in the SOURCE org's log before overwriting —
    // its admins need to see that the workspace left, not just the
    // destination org seeing it arrive.
    const sourceOrgId = workspace.organizationId;
    workspace.organizationId = targetOrg._id;
    await workspace.save();

    auditWorkspace(req, sourceOrgId, workspace, 'workspace.move_out', {
      targetOrgId: String(targetOrg._id),
    });
    auditWorkspace(req, targetOrg._id, workspace, 'workspace.move_in', {
      sourceOrgId: sourceOrgId ? String(sourceOrgId) : null,
    });
    res.json({ workspace });
  } catch (error) {
    console.error('Move workspace error:', error);
    res.status(500).json({ error: 'Failed to move workspace' });
  }
};

// ─── CONTENT SUMMARY (counts for delete confirmation) ───────────────
const getContentSummary = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    // Access control: without this, any authenticated user could read another
    // tenant's content counts by _id (cross-tenant IDOR). Share the SAME
    // resolution as rwr / getMembers via the extracted helper (F1/B1). The
    // hand-rolled mirror here previously OMITTED the OrgMember-by-ownerId
    // fallback, 404'ing a class of pre-multi-org teammates that every rwr
    // route grants. 404 (not 403) on no-access preserves the IDOR contract.
    if (!(await resolveWorkspaceRole(workspace, req.user.userId))) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const counts = {};
    const items = [
      { model: 'Content',              filter: { workspaceId },            key: 'articles' },
      { model: 'AiTracker',            filter: { workspaceId },            key: 'monitors' },
      { model: 'KeywordResearchHistory', filter: { workspaceId },          key: 'keywordSearches' },
      { model: 'BrandVoice',           filter: { workspace: workspaceId }, key: 'brandVoices' },
      { model: 'Avatar',               filter: { workspace: workspaceId }, key: 'avatars' },
      { model: 'Site',                 filter: { workspaceId },            key: 'sites' },
    ];
    for (const { model: name, filter, key } of items) {
      const Model = mongoose.models[name];
      counts[key] = Model ? await Model.countDocuments(filter) : 0;
    }
    res.json(counts);
  } catch (error) {
    console.error('Content summary error:', error);
    res.status(500).json({ error: 'Failed to fetch content summary' });
  }
};

module.exports = { getWorkspace, listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, setActiveWorkspace, getMembers, addMember, removeMember, moveWorkspace, getContentSummary };
