const User = require('../models/User');

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

    // End all sessions except current
    await Session.updateMany(
      { userId: user._id, _id: { $ne: req.user.sessionId }, status: 'active' },
      { status: 'ended' }
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
};

module.exports = {
  updateProfile,
  changePassword,
};
