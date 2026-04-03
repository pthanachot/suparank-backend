const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const User = require('../models/User');

// ─── GET WORKSPACE (find or create for user) ────────────────────
const getWorkspace = async (req, res) => {
  try {
    const workspace = await Workspace.findOrCreateForUser(req.user.userId);
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
    const workspaces = await Workspace.find({
      $or: [
        { userId: req.user.userId },
        { 'members.userId': req.user.userId },
      ],
    })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    const enriched = workspaces.map((ws) => ({
      ...ws,
      role: ws.userId.equals(req.user.userId) ? 'owner' : 'member',
    }));
    res.json({ workspaces: enriched });
  } catch (error) {
    console.error('List workspaces error:', error);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
};

// ─── CREATE WORKSPACE ────────────────────────────────────────────
const createWorkspace = async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Workspace name is required' });
    }
    const count = await Workspace.countDocuments({ userId: req.user.userId });
    if (count >= 10) {
      return res.status(400).json({ error: 'Maximum 10 workspaces allowed' });
    }
    const workspaceNumber = await Workspace.getNextNumber();
    const workspace = await Workspace.create({
      workspaceNumber,
      name: name.trim(),
      userId: req.user.userId,
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
    const workspace = await Workspace.findOne({ _id: workspaceId, userId: req.user.userId });
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (workspace.isDefault) {
      return res.status(400).json({ error: 'Cannot delete the default workspace' });
    }
    // Block deletion if workspace has content (articles)
    const Article = mongoose.models.Article;
    if (Article) {
      const articleCount = await Article.countDocuments({ workspaceId: workspaceId });
      if (articleCount > 0) {
        return res.status(400).json({ error: 'Cannot delete a workspace that has content. Move or delete its articles first.' });
      }
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
    const owner = await User.findById(workspace.userId).select('email profile.name profile.picture').lean();
    res.json({
      owner: {
        userId: workspace.userId,
        email: owner?.email || '',
        name: owner?.profile?.name || '',
        picture: owner?.profile?.picture || '',
      },
      members: (workspace.members || []).map((m) => ({
        userId: m.userId,
        email: m.email,
        addedAt: m.addedAt,
      })),
      isOwner: workspace.userId.equals(req.user.userId),
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

module.exports = { getWorkspace, listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, setActiveWorkspace, getMembers, addMember, removeMember };
