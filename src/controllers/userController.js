const Stripe = require('stripe');
const User = require('../models/User');
const Session = require('../models/Session');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const Workspace = require('../models/Workspace');
const { verifyGoogleToken } = require('../middleware/auth');
const { clearTierCache } = require('../services/tierService');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── UPDATE PROFILE ────────────────────────────────────────────

const updateProfile = async (req, res) => {
  try {
    const { name, email, timezone, picture, emailNotifications } = req.body;
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
      user.markModified('preferences');
    }

    // Update email notifications preference
    if (emailNotifications !== undefined) {
      user.preferences = user.preferences || {};
      user.preferences.emailNotifications = !!emailNotifications;
      user.markModified('preferences');
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
      emailNotifications: user.preferences?.emailNotifications ?? true,
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

// ─── SAVE ONBOARDING ──────────────────────────────────────────

const saveOnboarding = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { skip, businessType, teamSize, role, interests, referralSources } = req.body;

    user.onboarding = user.onboarding || {};

    if (skip) {
      user.onboarding.skippedAt = new Date();
    } else {
      if (businessType) user.onboarding.businessType = businessType;
      if (teamSize) user.onboarding.teamSize = teamSize;
      if (role) user.onboarding.role = role;
      if (interests) user.onboarding.interests = interests;
      if (referralSources) user.onboarding.referralSources = referralSources;
      user.onboarding.completed = true;
      user.onboarding.completedAt = new Date();
    }

    await user.save();

    res.json({ success: true });
  } catch (error) {
    console.error('Save onboarding error:', error);
    res.status(500).json({ error: 'Failed to save onboarding' });
  }
};

// ─── DELETE ACCOUNT ───────────────────────────────────────────

const deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Guard: cannot delete if owning non-personal organizations
    const ownedOrgs = await Organization.find({
      ownerId: user._id,
      isPersonal: { $ne: true },
    }).select('_id name').lean();

    if (ownedOrgs.length > 0) {
      return res.status(409).json({
        error: 'You must transfer ownership or delete your organizations before deleting your account.',
        code: 'OWNS_ORGANIZATIONS',
        orgs: ownedOrgs.map((o) => ({ id: o._id, name: o.name })),
      });
    }

    // Find personal org for subscription check
    const personalOrg = await Organization.findOne({
      ownerId: user._id,
      isPersonal: true,
    }).lean();

    // Check if user has an active paid subscription
    if (personalOrg) {
      const sub = await Subscription.findOne({
        organizationId: personalOrg._id,
        status: { $in: ['active', 'trialing'] },
        stripeSubscriptionId: { $exists: true, $ne: null },
      });

      if (sub) {
        // Paid user: schedule deletion (will complete when subscription ends via webhook)
        user.status = 'pending_deletion';
        await user.save();
        console.log(`[account] Scheduled deletion for paid user="${user.email}"`);
        return res.json({ status: 'pending_deletion' });
      }
    }

    // Free user or no active subscription: immediate soft-delete
    const originalEmail = user.email;
    user.status = 'deleted';
    user.email = `deleted_${Date.now()}_${originalEmail}`;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Clean up sessions
    await Session.deleteMany({ userId: user._id });

    // Remove from all org memberships
    await OrgMember.deleteMany({ userId: user._id });

    // Cascade-delete personal org and its workspaces
    if (personalOrg) {
      await Workspace.deleteMany({ organizationId: personalOrg._id });
      await Organization.deleteOne({ _id: personalOrg._id });
    }

    console.log(`[account] Immediately deleted user="${originalEmail}"`);
    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
};

// ─── CANCEL DELETION ─────────────────────────────────────────

const cancelDeletion = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'pending_deletion') {
      return res.status(400).json({ error: 'Account is not scheduled for deletion' });
    }

    // Revert status
    user.status = 'active';
    await user.save();

    // Try to reactivate subscription
    let subscriptionReactivated = false;
    try {
      const personalOrg = await Organization.findOne({
        ownerId: user._id,
        isPersonal: true,
      }).lean();

      if (personalOrg) {
        const sub = await Subscription.findOne({ organizationId: personalOrg._id });
        if (sub && sub.cancelAtPeriodEnd && sub.stripeSubscriptionId) {
          await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
          });
          sub.cancelAtPeriodEnd = false;
          sub.canceledAt = undefined;
          await sub.save();
          clearTierCache();
          subscriptionReactivated = true;
        }
      }
    } catch (err) {
      console.error('[account] Failed to reactivate subscription:', err.message);
    }

    console.log(`[account] Cancelled deletion for user="${user.email}" subscriptionReactivated=${subscriptionReactivated}`);
    res.json({ status: 'active', subscriptionReactivated });
  } catch (error) {
    console.error('Cancel deletion error:', error);
    res.status(500).json({ error: 'Failed to cancel deletion' });
  }
};

module.exports = {
  updateProfile,
  changePassword,
  getSessions,
  revokeSession,
  disconnectAccount,
  connectAccount,
  saveOnboarding,
  deleteAccount,
  cancelDeletion,
};
