const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Workspace = require('../models/Workspace');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');
const { ensureUserHasOrg } = require('../services/orgBootstrapService');
const { ORG_CONFIG } = require('../scripts/configOrganization');

// ─── LIST ORGANIZATIONS ──────────────────────────────────────
// Returns orgs the user owns + orgs the user is a member of.

const listOrganizations = async (req, res) => {
  try {
    // Orgs user owns
    let ownedOrgs = await Organization.find({ ownerId: req.user.userId }).lean();

    // Orgs user is a member of
    const memberships = await OrgMember.find({
      userId: req.user.userId,
      status: 'active',
    }).lean();

    // Self-heal: this list drives the frontend's "needs org" guard. If the user
    // has none (legacy account, or a signup whose bootstrap failed), provision a
    // default org now so they never hit the org-creation dead-end. Idempotent.
    if (ownedOrgs.length === 0 && memberships.length === 0) {
      const userDoc = await User.findById(req.user.userId).select('profile').lean();
      await ensureUserHasOrg({ _id: req.user.userId, profile: userDoc?.profile });
      ownedOrgs = await Organization.find({ ownerId: req.user.userId }).lean();
    }
    const memberOrgIds = memberships.map((m) => m.organizationId);
    const memberOrgs = memberOrgIds.length
      ? await Organization.find({ _id: { $in: memberOrgIds } }).lean()
      : [];

    // Build role map and locked map
    const roleMap = {};
    const lockedMap = {};
    for (const m of memberships) {
      const key = m.organizationId.toString();
      roleMap[key] = m.role;
      lockedMap[key] = m.locked || false;
    }

    const orgs = [
      ...ownedOrgs.map((o) => ({ ...o, role: 'owner', locked: false })),
      ...memberOrgs
        .filter((o) => !o.ownerId.equals(req.user.userId)) // exclude owned (avoid dupes)
        .map((o) => ({ ...o, role: roleMap[o._id.toString()] || 'viewer', locked: lockedMap[o._id.toString()] || false })),
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

    const changed = [];
    if (name && name.trim() && name.trim() !== org.name) {
      org.name = name.trim();
      org.slug = await Organization.generateSlug(name.trim(), req.user.userId);
      changed.push('name');
    }
    if (avatar !== undefined && avatar !== org.avatar) {
      org.avatar = avatar;
      changed.push('avatar');
    }

    await org.save();
    if (changed.length > 0) {
      require('../services/auditService').record({
        organizationId: org._id,
        userId: req.user.userId,
        actorEmail: req.user.email,
        action: 'org.update',
        resourceId: org._id,
        meta: { name: org.name, changed },
        ip: req.ip,
      });
    }
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

    // Personal orgs are auto-created (legacy migration) and are referenced by
    // multiple middleware paths (tierEnforcement, permissions, creditGate) via
    // `findOne({ ownerId, isPersonal: true })`. Allowing them to be deleted
    // would silently break those paths for the user.
    if (org.isPersonal) {
      return res.status(400).json({
        error: 'Cannot delete your personal organization.',
        code: 'PERSONAL_ORG',
      });
    }

    // Active subscriptions tied to this org would be orphaned (continued
    // Stripe billing with no UI to manage). Force the owner to cancel first.
    const activeSub = await Subscription.findOne({
      organizationId: org._id,
      status: { $in: ['active', 'trialing', 'past_due'] },
      stripeSubscriptionId: { $exists: true, $ne: null },
    }).select('_id planId').lean();
    if (activeSub) {
      return res.status(400).json({
        error: 'Cancel your subscription before deleting this organization.',
        code: 'ACTIVE_SUBSCRIPTION',
        planId: activeSub.planId,
      });
    }

    // Check for workspaces
    const wsCount = await Workspace.countDocuments({ organizationId: org._id });
    if (wsCount > 0) {
      return res.status(400).json({
        error: `Cannot delete organization with ${wsCount} workspace(s). Move or delete them first.`,
      });
    }

    // Cascade: members + non-active subscription rows (canceled history)
    await OrgMember.deleteMany({ organizationId: org._id });
    await Subscription.deleteMany({ organizationId: org._id });
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
