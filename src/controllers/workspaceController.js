const Workspace = require('../models/Workspace');

// GET /api/workspace — get or create user's workspace
const getWorkspace = async (req, res) => {
  try {
    const workspace = await Workspace.findOrCreateForUser(req.user.userId);
    res.json({ workspace });
  } catch (err) {
    console.error('getWorkspace error:', err.message);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
};

module.exports = { getWorkspace };
