const User = require('../models/User');
const OrgMember = require('../models/OrgMember');
const Role = require('../models/Role');
const FeatureFlag = require('../models/FeatureFlag');

// ─── LIST MEMBERS ────────────────────────────────────────────────
// Returns the org owner + all org members with roles.

const listMembers = async (req, res) => {
  try {
    const members = await OrgMember.find({
      ownerId: req.user.userId,
    })
      .sort({ createdAt: 1 })
      .lean();

    // Populate user info for each member
    const userIds = members.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select('email profile.name profile.picture')
      .lean();
    const userMap = {};
    for (const u of users) {
      userMap[u._id.toString()] = u;
    }

    const enriched = members.map((m) => {
      const u = userMap[m.userId.toString()];
      return {
        _id: m._id,
        userId: m.userId,
        email: m.email,
        name: u?.profile?.name || '',
        picture: u?.profile?.picture || '',
        role: m.role,
        status: m.status,
        invitedAt: m.invitedAt,
      };
    });

    // Get owner info
    const owner = await User.findById(req.user.userId)
      .select('email profile.name profile.picture')
      .lean();

    res.json({
      owner: {
        userId: req.user.userId,
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
// Body: { email, role }

const inviteMember = async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    // Check member limit from feature flag
    const flag = await FeatureFlag.findOne({ key: 'members' }).lean();
    if (flag?.conditions?.custom?.maxMembers) {
      const currentCount = await OrgMember.countDocuments({ ownerId: req.user.userId });
      if (currentCount >= flag.conditions.custom.maxMembers) {
        return res.status(400).json({
          error: `Maximum ${flag.conditions.custom.maxMembers} members allowed`,
        });
      }
    }

    const targetUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (!targetUser) {
      return res.status(404).json({ error: 'No user found with that email' });
    }
    if (targetUser._id.equals(req.user.userId)) {
      return res.status(400).json({ error: 'You cannot invite yourself' });
    }

    // Check if already a member
    const existing = await OrgMember.findOne({
      ownerId: req.user.userId,
      userId: targetUser._id,
    });
    if (existing) {
      return res.status(409).json({ error: 'This user is already a member' });
    }

    const member = await OrgMember.create({
      ownerId: req.user.userId,
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
// PUT /api/org/members/:memberId/role
// Body: { role }

const changeRole = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { role } = req.body;

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    const member = await OrgMember.findOne({
      _id: memberId,
      ownerId: req.user.userId,
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
// DELETE /api/org/members/:memberId

const removeMember = async (req, res) => {
  try {
    const { memberId } = req.params;

    const member = await OrgMember.findOneAndDelete({
      _id: memberId,
      ownerId: req.user.userId,
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
// GET /api/feature-flags — returns enabled flags for frontend

const listFeatureFlags = async (req, res) => {
  try {
    const flags = await FeatureFlag.find({ enabled: true, implemented: true })
      .select('key displayName conditions')
      .lean();
    res.json({ flags });
  } catch (error) {
    console.error('List feature flags error:', error);
    res.status(500).json({ error: 'Failed to list feature flags' });
  }
};

module.exports = { listMembers, inviteMember, changeRole, removeMember, listRoles, listFeatureFlags };
