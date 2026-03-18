const User = require('../models/User');
const Session = require('../models/Session');
const Counter = require('../models/Counter');
const VerificationCode = require('../models/VerificationCode');
const crypto = require('crypto');
const { generateTokens } = require('../utils/jwt');
const { sendEmail, sendVerificationCodeEmail } = require('../utils/emailService');

// Auto-increment userId
async function getNextUserId() {
  const counter = await Counter.findByIdAndUpdate(
    'userId',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq + 1000000000;
}

// Generate 6-digit code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── EMAIL SIGNUP ───────────────────────────────────────────────

const emailSignup = async (req, res) => {
  try {
    const { name, email, password, verificationCode } = req.body;

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

    // Create user
    const userId = await getNextUserId();
    const user = new User({
      userId,
      email: email.toLowerCase(),
      password,
      profile: { name: name || email.split('@')[0] },
      verified: !!verificationCode, // verified if code was provided
    });

    // If no verification code was provided, generate a verification token and send email
    if (!verificationCode) {
      const token = crypto.randomBytes(32).toString('hex');
      user.verificationToken = token;
      user.verificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h
    }

    await user.save();

    // Send verification email if not already verified
    if (!user.verified) {
      const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${user.verificationToken}`;
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
        verified: user.verified,
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
        verified: user.verified,
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

    // Rate limit: 1 resend per 60s per email
    const recentCode = await VerificationCode.findOne({
      email: email.toLowerCase(),
      type: 'email_verification',
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

    // Generate new token
    const token = crypto.randomBytes(32).toString('hex');
    user.verificationToken = token;
    user.verificationExpires = Date.now() + 24 * 60 * 60 * 1000;
    await user.save();

    const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
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

    await sendVerificationCodeEmail(email, code);

    res.json({ message: 'Verification code sent' });
  } catch (error) {
    console.error('Send verification code error:', error);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
};

module.exports = {
  emailSignup,
  emailLogin,
  verifyEmail,
  resendVerification,
  sendVerificationCode,
};
