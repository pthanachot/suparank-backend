const User = require('../models/User');
const Session = require('../models/Session');
const Counter = require('../models/Counter');
const VerificationCode = require('../models/VerificationCode');
const Organization = require('../models/Organization');
const Workspace = require('../models/Workspace');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { generateTokens, generateAccessToken, generateRefreshToken } = require('../utils/jwt');
const ResetToken = require('../models/ResetToken');
const { sendEmail, sendVerificationCodeEmail, sendPasswordResetCodeEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');
const { getSettings } = require('../services/systemSettingsService');
const { verifyGoogleToken } = require('../middleware/auth');
const creditService = require('../services/creditService');
const tierService = require('../services/tierService');
const { bootstrapNewUser, ensureUserHasOrg } = require('../services/orgBootstrapService');
const inviteService = require('../services/inviteService');

// Helper: is onboarding considered done (completed, skipped, or pre-existing user)?
// Mongoose applies defaults for inline subdocs, so user.onboarding always exists in memory.
// Use createdAt cutoff to grandfather users created before the onboarding feature.
const ONBOARDING_LAUNCH = new Date('2026-05-15T00:00:00Z');

function isOnboardingDone(user) {
  if (user.onboarding?.completed || user.onboarding?.skippedAt) return true;
  // Users created before onboarding feature — grandfather them in
  if (user.createdAt < ONBOARDING_LAUNCH) return true;
  return false;
}

// Auto-increment userId
async function getNextUserId() {
  const counter = await Counter.findByIdAndUpdate(
    'userId',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq + 1000000000;
}

// Generate cryptographically secure 6-digit code (100000–999999).
// Math.random() is a PRNG and not suitable for security-sensitive codes;
// crypto.randomInt is uniformly random and seeded from the OS entropy pool.
function generateCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Default org + workspace provisioning lives in orgBootstrapService:
//   bootstrapNewUser  — atomic create on signup
//   ensureUserHasOrg  — idempotent self-heal on login / org list

// ─── Welcome email ──────────────────────────────────────────────
// Sent once when an account becomes verified (signup with code, email
// verification, or Google auth). Fire-and-forget — never blocks the flow.
const sendWelcomeEmail = async (user) => {
  try {
    if (getSettings().emailNotificationsEnabled === false) return;
    if (user.preferences?.emailNotifications === false) return;
    const emailOptions = {
      to: user.email,
      data: {
        userName: user.profile?.name || 'there',
        // Welcome links to the platform login: sendWelcomeEmail has no
        // request context, and the whole template becomes tenant-scoped in
        // Phase 12 (per-tenant email templates) — solve it there.
        loginUrl: `${process.env.FRONTEND_URL || 'https://app.suparank.ai'}/login`,
      },
    };
    await applyCustomTemplate('welcome', emailOptions);
    if (!emailOptions.subject) return;
    await sendEmail(emailOptions);
    console.log(`[email] Welcome email sent to ${user.email}`);
  } catch (err) {
    console.error(`[email] Failed to send welcome email to ${user.email}:`, err.message);
  }
};

/**
 * Resolve + accept an invite during signup/login. Returns the acceptance
 * result, or null when the token is absent/invalid/for another email —
 * callers fall back to the normal bootstrap path in that case.
 */
const tryAcceptInviteForUser = async (inviteToken, user) => {
  if (!inviteToken) return null;
  try {
    const invite = await inviteService.findValidInvite(inviteToken);
    if (!invite || invite.email !== user.email) return null;
    return await inviteService.acceptInvite(invite, user);
  } catch (err) {
    console.error(`[auth] Invite acceptance failed for user=${user._id}:`, err.message);
    return null;
  }
};

// ─── EMAIL SIGNUP ───────────────────────────────────────────────

const emailSignup = async (req, res) => {
  try {
    const { name, email, password, verificationCode, inviteToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ error: 'Email is already registered' });
    }

    // If verification code provided, validate it
    if (verificationCode) {
      const codeRecord = await VerificationCode.findOne({
        email: email.toLowerCase(),
        type: 'signup',
        expiresAt: { $gt: Date.now() },
      });

      if (!codeRecord || codeRecord.code !== verificationCode) {
        return res.status(400).json({ error: 'Invalid or expired verification code' });
      }

      // Delete used code
      await VerificationCode.deleteOne({ _id: codeRecord._id });
    }

    // Invite-based signup: a valid invite token whose email matches proves
    // inbox ownership (the token only ever existed in that email), so the
    // account starts verified and org bootstrap is replaced by acceptance.
    let invite = null;
    if (inviteToken) {
      const candidate = await inviteService.findValidInvite(inviteToken);
      if (candidate && candidate.email === email.toLowerCase()) invite = candidate;
    }

    // Create user
    const userId = await getNextUserId();
    const user = new User({
      userId,
      email: email.toLowerCase(),
      password,
      profile: { name: name || email.split('@')[0] },
      verified: !!verificationCode || !!invite, // code or invite link proves the email
    });

    // If neither a verification code nor an invite proved the email,
    // generate a verification token and send the email
    if (!verificationCode && !invite) {
      const token = crypto.randomBytes(32).toString('hex');
      user.verificationToken = token;
      user.verificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h
    }

    await user.save();

    // Grant free credits to the new user
    try {
      const freeTierConfig = await tierService.getTierConfig('free');
      if (freeTierConfig?.creditsPerMonth) {
        await creditService.grantFreeCredits(user._id, freeTierConfig.creditsPerMonth);
      }
    } catch (err) {
      console.error(`[auth] Failed to grant free credits for user=${user._id}:`, err.message);
    }

    // Invited users join the inviting org instead of getting their own —
    // no personal org, no stray free workspace (white-label Phase 3).
    let bootstrapResult = null;
    let inviteResult = null;
    if (invite) {
      inviteResult = await tryAcceptInviteForUser(inviteToken, user);
    }
    if (!inviteResult) {
      // Auto-create default organization + workspace for the new user
      try {
        bootstrapResult = await bootstrapNewUser(user._id, user.profile.name);
      } catch (err) {
        console.error(`[auth] Failed to bootstrap org/workspace for user=${user._id}:`, err.message);
      }
    }

    // Verified at creation (signed up with a code) — send welcome now
    if (user.verified) sendWelcomeEmail(user);

    // Send verification email if not already verified
    if (!user.verified) {
      // Invariant I1 (Phase 10): signup that arrived on a VERIFIED tenant
      // domain keeps its links there; the header is only trusted after a
      // DB match, so it can't inject a phishing host.
      const signupBase = await require('../services/domainService').resolveBaseUrlFromRequest(req);
      const verifyUrl = `${signupBase}/verify-email?token=${user.verificationToken}`;
      // Route through the admin-editable trigger template; fall back to the
      // hardcoded email if template resolution fails. Signup has no org
      // context yet → platform-scoped (null).
      const emailOptions = {
        to: user.email,
        data: { userName: user.profile?.name || 'there', verifyUrl },
      };
      await applyCustomTemplate('verify_email_link', emailOptions, null);
      if (emailOptions.subject) {
        await sendEmail(emailOptions);
      } else {
        await sendEmail({
          to: user.email,
          subject: 'Verify your SupaRank account',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
              <h2 style="color: #111; margin-bottom: 16px;">Welcome to SupaRank!</h2>
              <p style="color: #555; margin-bottom: 24px;">Click the button below to verify your email address:</p>
              <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; background: #4F46E5; color: white; text-decoration: none; border-radius: 12px; font-weight: bold; font-size: 14px;">Verify Email</a>
              <p style="color: #888; font-size: 14px; margin-top: 24px;">This link expires in 24 hours.</p>
              <p style="color: #888; font-size: 14px;">If you didn't create an account, you can safely ignore this email.</p>
            </div>
          `,
        });
      }
    }

    // Create session
    const session = await Session.create({
      userId: user._id,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    const tokens = generateTokens(user, session._id);

    res.status(201).json({
      user: {
        id: user._id,
        userId: user.userId,
        email: user.email,
        name: user.profile.name,
        picture: user.profile?.picture,
        verified: user.verified,
        connectedProviders: user.getConnectedProviders(),
        activeWorkspaceId:
          inviteResult?.workspace?._id || bootstrapResult?.workspace?._id || user.activeWorkspaceId || null,
        onboardingCompleted: isOnboardingDone(user),
      },
      ...tokens,
      isNewUser: true,
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message || 'Signup failed' });
  }
};

// ─── EMAIL LOGIN ────────────────────────────────────────────────

const emailLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.isLocked()) {
      return res.status(423).json({ error: 'Account is locked. Try again later.' });
    }

    const isValid = await user.comparePassword(password);
    if (!isValid) {
      await user.registerLoginAttempt(false);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in' });
    }

    await user.registerLoginAttempt(true);

    // Self-heal: guarantee the user has an org (covers legacy / failed-bootstrap
    // accounts). No-op when they already have one.
    const healed = await ensureUserHasOrg(user);

    const session = await Session.create({
      userId: user._id,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    const tokens = generateTokens(user, session._id);

    res.json({
      user: {
        id: user._id,
        userId: user.userId,
        email: user.email,
        name: user.profile?.name,
        picture: user.profile?.picture,
        timezone: user.preferences?.timezone,
        emailNotifications: user.preferences?.emailNotifications ?? true,
        verified: user.verified,
        connectedProviders: user.getConnectedProviders(),
        activeWorkspaceId: healed?.workspace?._id || user.activeWorkspaceId || null,
        onboardingCompleted: isOnboardingDone(user),
      },
      ...tokens,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

// ─── VERIFY EMAIL (token-based) ────────────────────────────────

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const user = await User.findOne({
      verificationToken: token,
      verificationExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    user.verified = true;
    user.verificationToken = undefined;
    user.verificationExpires = undefined;
    await user.save();

    sendWelcomeEmail(user);

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
};

// ─── RESEND VERIFICATION EMAIL ─────────────────────────────────

const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user || user.verified) {
      // Return success even if user not found (security)
      return res.json({ message: 'If the email exists and is unverified, a new link has been sent' });
    }

    // Rate limit: 1 resend per 60s per email. Previously this queried a
    // VerificationCode row with type 'email_verification' — a type that is not
    // in the model enum and is never written anywhere, so the query always
    // returned null and the throttle NEVER fired (resend was unthrottled →
    // email-abuse/token-churn risk). Derive last-sent from the token expiry
    // already stored on the user doc (verificationExpires = issuedAt + 24h at
    // every issuance site: email signup, this resend, and the userController
    // email-change flow — keep those TTLs in sync with TOKEN_TTL_MS). No new
    // rows, no schema change.
    const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
    if (user.verificationExpires) {
      const sinceLast = Date.now() - (new Date(user.verificationExpires).getTime() - TOKEN_TTL_MS);
      if (sinceLast < 60 * 1000) {
        const retryAfter = Math.max(60 - Math.floor(sinceLast / 1000), 1);
        return res.status(429).json({
          error: `Please wait ${retryAfter} seconds before requesting a new code`,
          code: 'rate_limited',
          retryAfter,
        });
      }
    }

    // Generate new token
    const token = crypto.randomBytes(32).toString('hex');
    user.verificationToken = token;
    user.verificationExpires = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();

    // Invariant I1 (Phase 10): validated request host (see emailSignup)
    const resendBase = await require('../services/domainService').resolveBaseUrlFromRequest(req);
    const verifyUrl = `${resendBase}/verify-email?token=${token}`;
    // Route through the admin-editable trigger template; fall back to the
    // hardcoded email if template resolution fails. No org context → null.
    const emailOptions = {
      to: user.email,
      data: { userName: user.profile?.name || 'there', verifyUrl },
    };
    await applyCustomTemplate('verify_email_link', emailOptions, null);
    if (emailOptions.subject) {
      await sendEmail(emailOptions);
    } else {
      await sendEmail({
        to: user.email,
        subject: 'Verify your SupaRank account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
            <h2 style="color: #111; margin-bottom: 16px;">Verify your email</h2>
            <p style="color: #555; margin-bottom: 24px;">Click the button below to verify your email address:</p>
            <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; background: #4F46E5; color: white; text-decoration: none; border-radius: 12px; font-weight: bold; font-size: 14px;">Verify Email</a>
            <p style="color: #888; font-size: 14px; margin-top: 24px;">This link expires in 24 hours.</p>
          </div>
        `,
      });
    }

    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification' });
  }
};

// ─── SEND VERIFICATION CODE ────────────────────────────────────

const sendVerificationCode = async (req, res) => {
  try {
    const { email, purpose } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check rate limit: 1 code per 60s per email
    const recentCode = await VerificationCode.findOne({
      email: email.toLowerCase(),
      type: purpose || 'signup',
      lastSentAt: { $gt: new Date(Date.now() - 60 * 1000) },
    });

    if (recentCode) {
      const elapsed = Math.floor((Date.now() - recentCode.lastSentAt.getTime()) / 1000);
      const retryAfter = Math.max(60 - elapsed, 1);
      return res.status(429).json({
        error: `Please wait ${retryAfter} seconds before requesting a new code`,
        code: 'rate_limited',
        retryAfter,
      });
    }

    const code = generateCode();

    await VerificationCode.findOneAndUpdate(
      { email: email.toLowerCase(), type: purpose || 'signup' },
      {
        email: email.toLowerCase(),
        code,
        type: purpose || 'signup',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        lastSentAt: new Date(),
        attempts: 0,
      },
      { upsert: true, new: true }
    );

    // Route through the admin-editable trigger template; fall back to the
    // hardcoded email if template resolution fails.
    const emailOptions = { to: email, data: { code, expiresIn: '15 minutes' } };
    await applyCustomTemplate('verify_email', emailOptions);
    if (emailOptions.subject) {
      await sendEmail(emailOptions);
    } else {
      await sendVerificationCodeEmail(email, code);
    }

    res.json({ message: 'Verification code sent' });
  } catch (error) {
    console.error('Send verification code error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
};

// ─── FORGOT PASSWORD ───────────────────────────────────────────

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const lcEmail = email.toLowerCase();

    // Rate limit applied uniformly per email, BEFORE the user-existence check,
    // so an attacker can't probe account existence via differential responses.
    // VerificationCode entries are created even for non-existent emails — they
    // expire in 15 minutes via the model's TTL index.
    const recentCode = await VerificationCode.findOne({
      email: lcEmail,
      type: 'password_reset',
      lastSentAt: { $gt: new Date(Date.now() - 60 * 1000) },
    });

    if (recentCode) {
      const elapsed = Math.floor((Date.now() - recentCode.lastSentAt.getTime()) / 1000);
      const retryAfter = Math.max(60 - elapsed, 1);
      return res.status(429).json({
        error: `Please wait ${retryAfter} seconds before requesting a new code`,
        code: 'rate_limited',
        retryAfter,
      });
    }

    // Always upsert a VC row so subsequent probes hit the rate-limit equally
    // whether or not a user with this email exists.
    const code = generateCode();
    await VerificationCode.findOneAndUpdate(
      { email: lcEmail, type: 'password_reset' },
      {
        email: lcEmail,
        code,
        type: 'password_reset',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        lastSentAt: new Date(),
        attempts: 0,
      },
      { upsert: true, new: true }
    );

    // Send the email only if the user exists. Errors swallowed so timing
    // doesn't leak — the response is identical regardless.
    const user = await User.findOne({ email: lcEmail });
    if (user) {
      const emailOptions = { to: email, data: { code, expiresIn: '15 minutes' } };
      applyCustomTemplate('password_reset', emailOptions)
        .then(() => (emailOptions.subject ? sendEmail(emailOptions) : sendPasswordResetCodeEmail(email, code)))
        .catch((err) => console.error('Failed to send reset email:', err.message));
    }

    res.json({ message: 'If an account exists, a reset code has been sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
};

// ─── VERIFY RESET CODE → returns a reset token ────────────────

const verifyResetCode = async (req, res) => {
  try {
    const { email, code } = req.body;

    const record = await VerificationCode.findOne({
      email: email?.toLowerCase(),
      type: 'password_reset',
      expiresAt: { $gt: Date.now() },
    });

    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    if (record.attempts >= 5) {
      await VerificationCode.deleteOne({ _id: record._id });
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }

    if (record.code !== code) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ error: 'Invalid code' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Generate reset token
    const resetToken = await user.generatePasswordResetToken();

    // Delete used verification code
    await VerificationCode.deleteOne({ _id: record._id });

    res.json({ resetToken });
  } catch (error) {
    console.error('Verify reset code error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
};

// ─── VALIDATE RESET TOKEN ──────────────────────────────────────

const validateResetToken = async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.json({ valid: false });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const resetTokenDoc = await ResetToken.findOne({
      hashedToken,
      expiresAt: { $gt: Date.now() },
    });

    res.json({ valid: !!resetTokenDoc });
  } catch (error) {
    res.json({ valid: false });
  }
};

// ─── RESET PASSWORD ────────────────────────────────────────────

const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = await User.findByResetToken(token);
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    user.password = password; // hashed by pre-save hook
    await user.invalidateTokens();

    // End all sessions
    await Session.updateMany(
      { userId: user._id, status: 'active' },
      { status: 'ended' }
    );

    // Clean up reset token
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    await ResetToken.deleteOne({ hashedToken });

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
};

// ─── GOOGLE OAUTH ──────────────────────────────────────────────

const googleAuth = async (req, res) => {
  try {
    const { credential, inviteToken } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    const googleUser = await verifyGoogleToken(credential);
    const { email, name, picture, googleId } = googleUser;

    let user = await User.findOne({
      $or: [
        { 'socialAccounts.google.email': email },
        { email: email.toLowerCase() },
      ],
    });

    let isNewUser = false;
    let bootstrapResult = null;
    let healedResult = null;
    let inviteResult = null;

    if (user) {
      // Update Google account info
      user.socialAccounts = user.socialAccounts || {};
      user.socialAccounts.google = {
        id: googleId,
        email,
        connected: new Date(),
        lastLogin: new Date(),
      };
      if (!user.profile?.name) {
        user.profile = user.profile || {};
        user.profile.name = name;
      }
      if (picture) {
        user.profile = user.profile || {};
        user.profile.picture = picture;
      }
      const wasUnverified = !user.verified;
      user.verified = true;
      await user.save();

      // Welcome on first verification (guarded — this runs on every Google login)
      if (wasUnverified) sendWelcomeEmail(user);

      // Existing user clicking an invite link — accept before the org
      // self-heal so the membership (not a fresh personal org) wins.
      inviteResult = await tryAcceptInviteForUser(inviteToken, user);

      // Self-heal: guarantee an existing Google user has an org (legacy /
      // failed-bootstrap accounts). No-op when they already have one.
      healedResult = await ensureUserHasOrg(user);
    } else {
      // Create new user
      isNewUser = true;
      const userId = await getNextUserId();
      user = await User.create({
        userId,
        email: email.toLowerCase(),
        profile: { name: name || email.split('@')[0], picture },
        socialAccounts: {
          google: { id: googleId, email, connected: new Date() },
        },
        verified: true,
      });

      // New Google accounts are verified at creation — welcome them
      sendWelcomeEmail(user);

      // Grant free credits to the new user
      try {
        const freeTierConfig = await tierService.getTierConfig('free');
        if (freeTierConfig?.creditsPerMonth) {
          await creditService.grantFreeCredits(user._id, freeTierConfig.creditsPerMonth);
        }
      } catch (err) {
        console.error(`[auth] Failed to grant free credits for user=${user._id}:`, err.message);
      }

      // Invited signup joins the inviting org instead of getting a
      // personal org (white-label Phase 3)
      inviteResult = await tryAcceptInviteForUser(inviteToken, user);
      if (!inviteResult) {
        // Auto-create default organization + workspace for the new user
        try {
          bootstrapResult = await bootstrapNewUser(user._id, user.profile.name);
        } catch (err) {
          console.error(`[auth] Failed to bootstrap org/workspace for user=${user._id}:`, err.message);
        }
      }
    }

    const session = await Session.create({
      userId: user._id,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    const tokens = generateTokens(user, session._id);

    res.json({
      user: {
        id: user._id,
        userId: user.userId,
        email: user.email,
        name: user.profile?.name,
        picture: user.profile?.picture,
        timezone: user.preferences?.timezone,
        emailNotifications: user.preferences?.emailNotifications ?? true,
        verified: user.verified,
        connectedProviders: user.getConnectedProviders(),
        activeWorkspaceId:
          inviteResult?.workspace?._id ||
          bootstrapResult?.workspace?._id ||
          healedResult?.workspace?._id ||
          user.activeWorkspaceId ||
          null,
        onboardingCompleted: isOnboardingDone(user),
      },
      ...tokens,
      isNewUser,
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
};

// ─── REFRESH TOKEN ─────────────────────────────────────────────

const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    // Pin algorithm and validate audience/issuer claims (set by generateRefreshToken)
    // to mitigate algorithm-confusion and cross-system token reuse.
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET, {
      algorithms: ['HS256'],
      audience: process.env.JWT_AUDIENCE || 'SupaRank',
      issuer: process.env.JWT_ISSUER || 'SupaRank',
    });

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    const session = await Session.findById(decoded.sessionId);
    if (!session || session.status === 'ended') {
      return res.status(401).json({ error: 'Session has been revoked' });
    }

    session.lastActivity = new Date();
    await session.save();

    // Sliding-expiry refresh: issue a fresh refresh token alongside the access
    // token so the refresh-token lifetime renews on every use. (Not full
    // rotation-with-reuse-detection — the old token remains valid until JWT
    // expiry; tracking issued-token nonces in DB would be required for that.)
    const accessToken = generateAccessToken(user, decoded.sessionId);
    const newRefreshToken = generateRefreshToken(user, decoded.sessionId);

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user._id,
        userId: user.userId,
        email: user.email,
        name: user.profile?.name,
        picture: user.profile?.picture,
        timezone: user.preferences?.timezone,
        emailNotifications: user.preferences?.emailNotifications ?? true,
        verified: user.verified,
        connectedProviders: user.getConnectedProviders(),
        socialAccounts: {
          google: user.socialAccounts?.google
            ? { email: user.socialAccounts.google.email, connected: !!user.socialAccounts.google.id }
            : null,
        },
        activeWorkspaceId: user.activeWorkspaceId || null,
        onboardingCompleted: isOnboardingDone(user),
      },
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
};

// ─── LOGOUT ────────────────────────────────────────────────────

const logout = async (req, res) => {
  try {
    if (req.user?.sessionId) {
      await Session.findByIdAndUpdate(req.user.sessionId, {
        status: 'ended',
      });
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
};

// ─── GET PROFILE ───────────────────────────────────────────────

const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user._id,
      userId: user.userId,
      email: user.email,
      name: user.profile?.name,
      picture: user.profile?.picture,
      timezone: user.preferences?.timezone,
      emailNotifications: user.preferences?.emailNotifications ?? true,
      verified: user.verified,
      connectedProviders: user.getConnectedProviders(),
      socialAccounts: {
        google: user.socialAccounts?.google
          ? { email: user.socialAccounts.google.email, connected: !!user.socialAccounts.google.id }
          : null,
      },
      status: user.status,
      activeWorkspaceId: user.activeWorkspaceId || null,
      onboardingCompleted: isOnboardingDone(user),
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
};

// ─── VERIFY TOKEN ──────────────────────────────────────────────

const verify = async (req, res) => {
  try {
    const session = await Session.findById(req.user.sessionId);
    if (!session || session.status === 'ended') {
      return res.status(401).json({ error: 'Session has been revoked' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      valid: true,
      user: {
        id: user._id,
        userId: user.userId,
        email: user.email,
        name: user.profile?.name,
        picture: user.profile?.picture,
        timezone: user.preferences?.timezone,
        emailNotifications: user.preferences?.emailNotifications ?? true,
        verified: user.verified,
        connectedProviders: user.getConnectedProviders(),
        socialAccounts: {
          google: user.socialAccounts?.google
            ? { email: user.socialAccounts.google.email, connected: !!user.socialAccounts.google.id }
            : null,
        },
        activeWorkspaceId: user.activeWorkspaceId || null,
        onboardingCompleted: isOnboardingDone(user),
      },
    });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
};

module.exports = {
  emailSignup,
  emailLogin,
  verifyEmail,
  resendVerification,
  sendVerificationCode,
  forgotPassword,
  verifyResetCode,
  validateResetToken,
  resetPassword,
  googleAuth,
  refreshToken,
  logout,
  getProfile,
  verify,
};
