const crypto = require('crypto');
const Stripe = require('stripe');
const STRIPE_API_VERSION = require('../config/stripeApiVersion');
const User = require('../models/User');
const Session = require('../models/Session');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const Workspace = require('../models/Workspace');
const { verifyGoogleToken } = require('../middleware/auth');
const { clearTierCache } = require('../services/tierService');
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

// Minimal HTML escape — guards against malformed user input being injected
// into outbound notification email bodies. We don't validate email format
// at the model level, so escape any user-provided string before interpolating.
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

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
      // Accept either null (removal), an https URL, or a base64 data URL up to ~2MB raw.
      // Frontend hint says "Max 2MB" — enforce it here so a malformed client can't
      // bypass the UI guard and bloat the User document or skirt the global 10mb body cap.
      if (picture === null || picture === '') {
        user.profile.picture = null;
      } else if (typeof picture !== 'string') {
        return res.status(400).json({ error: 'Picture must be a string URL or data URL' });
      } else if (picture.startsWith('data:image/')) {
        // base64 payload after the comma; 4 base64 chars = 3 raw bytes
        const commaIdx = picture.indexOf(',');
        const b64 = commaIdx >= 0 ? picture.slice(commaIdx + 1) : '';
        const approxBytes = Math.floor((b64.length * 3) / 4);
        if (approxBytes > 2 * 1024 * 1024) {
          return res.status(413).json({ error: 'Picture exceeds 2MB limit' });
        }
        user.profile.picture = picture;
      } else if (/^https:\/\//.test(picture)) {
        user.profile.picture = picture;
      } else {
        return res.status(400).json({ error: 'Picture must be an https URL or image data URL' });
      }
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
    let emailChanged = false;
    let previousEmail = null;
    if (email && email.toLowerCase() !== user.email) {
      // Phase 19B: an impersonation (support) session must never change the login
      // email — that would let a short-lived token seize the account permanently
      // via the public password-reset flow.
      if (req.user?.impersonatedBy) {
        return res.status(403).json({ error: 'Cannot change email while impersonating a user' });
      }
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'Email is already in use' });
      }
      previousEmail = user.email;
      user.email = email.toLowerCase();
      user.verified = false;
      // Issue a fresh verification token (consumed by POST /api/auth/verify-email)
      user.verificationToken = crypto.randomBytes(32).toString('hex');
      user.verificationExpires = Date.now() + 24 * 60 * 60 * 1000;
      emailChanged = true;
    }

    user.lastActive = new Date();
    await user.save();

    // Fire-and-forget email dispatch after save so a transient SMTP error
    // doesn't roll back the profile update.
    if (emailChanged) {
      // Invariant I1 (Phase 10): validated request host, phishing-safe
      const emailBase = await require('../services/domainService').resolveBaseUrlFromRequest(req);
      const verifyUrl = `${emailBase}/verify-email?token=${user.verificationToken}`;
      // Verification email to the NEW address — routed through the trigger
      // template, falling back to the hardcoded email if resolution fails.
      // orgId null: the user's active org isn't reliably the sender context yet.
      const emailOptions = {
        to: user.email,
        data: { userName: user.profile?.name || 'there', verifyUrl },
      };
      applyCustomTemplate('verify_email_link', emailOptions, null)
        .then(() =>
          emailOptions.subject
            ? sendEmail(emailOptions)
            : sendEmail({
                to: user.email,
                subject: 'Verify your new email — SupaRank',
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
                    <h2 style="color: #111; margin-bottom: 16px;">Verify your new email</h2>
                    <p style="color: #555; margin-bottom: 24px;">You changed your SupaRank email to this address. Click the button below to confirm:</p>
                    <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; background-color: #2B5BE8; color: white; text-decoration: none; border-radius: 12px; font-weight: bold; font-size: 14px;">Verify email</a>
                    <p style="color: #888; font-size: 14px; margin-top: 24px;">This link expires in 24 hours. If you didn't change your email, contact support@suparank.ai immediately.</p>
                  </div>
                `,
              })
        )
        .catch((err) => console.error('Failed to send verify-email to new address:', err.message));

      // Notification to the OLD address so a legit owner can react to unauthorized change
      if (previousEmail) {
        sendEmail({
          to: previousEmail,
          subject: 'Your SupaRank email was changed',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
              <h2 style="color: #111; margin-bottom: 16px;">Email address changed</h2>
              <p style="color: #555;">The email on your SupaRank account was just changed to <strong>${escapeHtml(user.email)}</strong>.</p>
              <p style="color: #555; margin-top: 16px;">If this wasn't you, contact <a href="mailto:support@suparank.ai">support@suparank.ai</a> right away.</p>
            </div>
          `,
        }).catch((err) => console.error('Failed to notify old email of change:', err.message));
      }
    }

    res.json({
      id: user._id,
      email: user.email,
      name: user.profile?.name,
      picture: user.profile?.picture,
      timezone: user.preferences?.timezone,
      emailNotifications: user.preferences?.emailNotifications ?? true,
      verified: user.verified,
      emailChanged,
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

    // Wave 1 (§4b): answers become durable segmentation properties (rollups
    // outlive the 90d raw TTL); skip is its own event so "skipped but still
    // activated" is measurable.
    const { recordObservation } = require('./observeController');
    if (skip) {
      recordObservation('onboarding_skipped', {}, req.user.userId, req.user.impersonatedBy);
    } else {
      recordObservation('onboarding_completed', {
        answers: { businessType, teamSize, role, interests, referralSources },
      }, req.user.userId, req.user.impersonatedBy);
    }

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
