const User = require('../models/User');
const Session = require('../models/Session');
const { verifyGoogleToken } = require('../middleware/auth');

// ─── UPDATE PROFILE ────────────────────────────────────────────

const updateProfile = async (req, res) => {
  try {
    const { name, email, timezone, picture } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update profile fields
    user.profile = user.profile || {};
    if (name !== undefined) {
      user.profile.name = name;
    }
    if (picture !== undefined) {
      user.profile.picture = picture;
    }

    // Update timezone
    if (timezone !== undefined) {
      user.preferences = user.preferences || {};
      user.preferences.timezone = timezone;
    }

    // Handle email change (requires re-verification)
    if (email && email.toLowerCase() !== user.email) {
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'Email is already in use' });
      }
      user.email = email.toLowerCase();
      user.verified = false;
      // TODO: Send re-verification email
    }

    user.lastActive = new Date();
    await user.save();

    res.json({
      id: user._id,
      email: user.email,
      name: user.profile?.name,
      picture: user.profile?.picture,
      timezone: user.preferences?.timezone,
      verified: user.verified,
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

// ─── CHANGE PASSWORD ───────────────────────────────────────────

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // OAuth users without password
    if (!user.hasPassword()) {
      return res.status(400).json({ error: 'You signed up with OAuth. Set a password first.' });
    }

    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    user.password = newPassword; // hashed by pre-save hook
    await user.invalidateTokens();

    // End all sessions (user must re-authenticate with new password)
    await Session.updateMany(
      { userId: user._id, status: 'active' },
      { status: 'ended' }
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
};

// ─── GET SESSIONS ──────────────────────────────────────────────

const getSessions = async (req, res) => {
  try {
    const sessions = await Session.find({
      userId: req.user.userId,
      status: 'active',
    }).sort({ lastActivity: -1 });

    const currentSessionId = req.user.sessionId;

    res.json({
      sessions: sessions.map((s) => ({
        id: s._id,
        device: s.userAgent || 'Unknown device',
        lastActive: s.lastActivity || s.updatedAt,
        isCurrent: s._id.toString() === currentSessionId,
        createdAt: s.createdAt,
      })),
    });
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
};

// ─── REVOKE SESSION ────────────────────────────────────────────

const revokeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await Session.findOne({
      _id: sessionId,
      userId: req.user.userId,
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.status = 'ended';
    await session.save();

    res.json({ message: 'Session revoked' });
  } catch (error) {
    console.error('Revoke session error:', error);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
};

// ─── DISCONNECT OAUTH ACCOUNT ──────────────────────────────────

const disconnectAccount = async (req, res) => {
  try {
    const { provider } = req.params;

    if (provider !== 'google') {
      return res.status(400).json({ error: 'Unsupported provider' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Don't allow disconnect if user has no password (would lock them out)
    if (!user.hasPassword()) {
      return res.status(400).json({
        error: 'Cannot disconnect. Set a password first to keep access to your account.',
      });
    }

    user.socialAccounts[provider] = undefined;
    await user.save();

    res.json({ message: `${provider} account disconnected` });
  } catch (error) {
    console.error('Disconnect account error:', error);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
};

// ─── CONNECT OAUTH ACCOUNT ────────────────────────────────────

const connectAccount = async (req, res) => {
  try {
    const { provider } = req.params;
    const { credential } = req.body;

    if (provider !== 'google') {
      return res.status(400).json({ error: 'Unsupported provider' });
    }

    if (!credential) {
      return res.status(400).json({ error: 'Credential is required' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify the Google token
    const googleData = await verifyGoogleToken(credential);

    // Check if this Google account is linked to another user
    const existingUser = await User.findOne({
      'socialAccounts.google.id': googleData.googleId,
      _id: { $ne: user._id },
    });
    if (existingUser) {
      return res.status(409).json({ error: 'This Google account is already linked to another user' });
    }

    user.socialAccounts = user.socialAccounts || {};
    user.socialAccounts.google = {
      id: googleData.googleId,
      email: googleData.email,
      connected: new Date(),
      lastLogin: new Date(),
    };

    // Update profile picture from Google if user doesn't have one
    if (!user.profile?.picture && googleData.picture) {
      user.profile = user.profile || {};
      user.profile.picture = googleData.picture;
    }

    await user.save();

    res.json({
      message: 'Google account connected',
      connectedProviders: user.getConnectedProviders(),
    });
  } catch (error) {
    console.error('Connect account error:', error);
    res.status(500).json({ error: 'Failed to connect account' });
  }
};

module.exports = {
  updateProfile,
  changePassword,
  getSessions,
  revokeSession,
  disconnectAccount,
  connectAccount,
};
