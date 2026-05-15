const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');
const { ORG_CONFIG } = require('../scripts/configOrganization');

// ─── LIST ORGANIZATIONS ──────────────────────────────────────
// Returns orgs the user owns + orgs the user is a member of.

const listOrganizations = async (req, res) => {
  try {
    // Orgs user owns
    const ownedOrgs = await Organization.find({ ownerId: req.user.userId }).lean();

    // Orgs user is a member of
    const memberships = await OrgMember.find({
      userId: req.user.userId,
      status: 'active',
    }).lean();
    const memberOrgIds = memberships.map((m) => m.organizationId);
    const memberOrgs = memberOrgIds.length
      ? await Organization.find({ _id: { $in: memberOrgIds } }).lean()
      : [];

    // Build role map
    const roleMap = {};
    for (const m of memberships) {
      roleMap[m.organizationId.toString()] = m.role;
    }

    const orgs = [
      ...ownedOrgs.map((o) => ({ ...o, role: 'owner' })),
      ...memberOrgs
        .filter((o) => !o.ownerId.equals(req.user.userId)) // exclude owned (avoid dupes)
        .map((o) => ({ ...o, role: roleMap[o._id.toString()] || 'viewer' })),
    ];

    res.json({ organizations: orgs, maxOrganizationsPerUser: ORG_CONFIG.maxOrganizationsPerUser });
  } catch (error) {
    console.error('List organizations error:', error);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
};

// ─── CREATE ORGANIZATION ─────────────────────────────────────

const createOrganization = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Organization name is required' });
    }

    // ── Block users with pending account deletion ──
    const callingUser = await User.findById(req.user.userId).select('status').lean();
    if (callingUser?.status === 'pending_deletion') {
      return res.status(403).json({ error: 'Cannot create organizations while account deletion is pending' });
    }

    // ── Enforce maxOrganizationsPerUser (global limit from configOrganization.js) ──
    const maxOrgs = ORG_CONFIG.maxOrganizationsPerUser;
    if (maxOrgs != null) {
      const ownedCount = await Organization.countDocuments({ ownerId: req.user.userId });
      if (ownedCount >= maxOrgs) {
        return res.status(429).json({
          error: `You can own up to ${maxOrgs} organization(s).`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: maxOrgs, used: ownedCount, limitKey: 'maxOrganizationsPerUser' },
        });
      }
    }

    const slug = await Organization.generateSlug(name.trim(), req.user.userId);

    const org = await Organization.create({
      name: name.trim(),
      slug,
      ownerId: req.user.userId,
      isPersonal: false,
    });

    // Auto-adopt orphan workspaces (created before org system)
    const adoptResult = await Workspace.updateMany(
      { userId: req.user.userId, organizationId: null },
      { $set: { organizationId: org._id } }
    );
    const adoptedWorkspaces = adoptResult.modifiedCount || 0;

    // If no workspaces were adopted, create a default one
    if (adoptedWorkspaces === 0) {
      const workspaceNumber = await Workspace.getNextNumber();
      await Workspace.create({
        workspaceNumber,
        name: 'My Workspace',
        userId: req.user.userId,
        organizationId: org._id,
        isDefault: true,
      });
    }

    // Ensure user has free credits (idempotent — no-op if already granted on signup)
    try {
      const { config } = await tierService.getOrgTierConfig(org._id);
      if (config?.creditsPerMonth) {
        await creditService.grantFreeCreditsIfNew(req.user.userId, config.creditsPerMonth);
      }
    } catch (err) {
      console.error(`[credits] Failed to ensure free credits for user=${req.user.userId}:`, err.message);
    }

    res.status(201).json({
      organization: { ...org.toObject(), role: 'owner' },
      adoptedWorkspaces,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'You already have an organization with that name' });
    }
    console.error('Create organization error:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
};

// ─── GET ORGANIZATION ────────────────────────────────────────

const getOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await Organization.findById(orgId).lean();
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Check access
    const isOwner = org.ownerId.equals(req.user.userId);
    if (!isOwner) {
      const membership = await OrgMember.findMembershipByOrg(org._id, req.user.userId);
      if (!membership) {
        return res.status(403).json({ error: 'You do not have access to this organization' });
      }
      return res.json({ organization: { ...org, role: membership.role } });
    }

    res.json({ organization: { ...org, role: 'owner' } });
  } catch (error) {
    console.error('Get organization error:', error);
    res.status(500).json({ error: 'Failed to get organization' });
  }
};

// ─── UPDATE ORGANIZATION ─────────────────────────────────────

const updateOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { name, avatar } = req.body;

    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    if (!org.ownerId.equals(req.user.userId)) {
      return res.status(403).json({ error: 'Only the organization owner can update it' });
    }

    if (name && name.trim()) {
      org.name = name.trim();
      org.slug = await Organization.generateSlug(name.trim(), req.user.userId);
    }
    if (avatar !== undefined) {
      org.avatar = avatar;
    }

    await org.save();
    res.json({ organization: org.toObject() });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'You already have an organization with that name' });
    }
    console.error('Update organization error:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
};

// ─── DELETE ORGANIZATION ─────────────────────────────────────

const deleteOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    if (!org.ownerId.equals(req.user.userId)) {
      return res.status(403).json({ error: 'Only the organization owner can delete it' });
    }
    // Check for workspaces
    const wsCount = await Workspace.countDocuments({ organizationId: org._id });
    if (wsCount > 0) {
      return res.status(400).json({
        error: `Cannot delete organization with ${wsCount} workspace(s). Move or delete them first.`,
      });
    }

    // Remove all members
    await OrgMember.deleteMany({ organizationId: org._id });
    await org.deleteOne();

    res.json({ message: 'Organization deleted' });
  } catch (error) {
    console.error('Delete organization error:', error);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
};

module.exports = {
  listOrganizations,
  createOrganization,
  getOrganization,
  updateOrganization,
  deleteOrganization,
};
