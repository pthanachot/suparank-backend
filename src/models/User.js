const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const ResetToken = require('./ResetToken');

const socialAccountSchema = new mongoose.Schema(
  {
    id: String,
    email: String,
    connected: { type: Date, default: Date.now },
    lastLogin: Date,
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    userId: { type: Number, required: true, unique: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: String,
    verified: { type: Boolean, default: false },
    verificationToken: String,
    verificationExpires: Date,
    status: {
      type: String,
      enum: ['active', 'suspended', 'deleted'],
      default: 'active',
    },
    roles: { type: [String], default: ['member'] },
    tokenVersion: { type: Number, default: 0 },

    profile: {
      name: String,
      picture: String,
    },

    preferences: {
      timezone: String,
      emailNotifications: { type: Boolean, default: true },
    },

    socialAccounts: {
      google: socialAccountSchema,
    },

    stripeCustomerId: String,
    activeWorkspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },

    lastLogin: Date,
    lastActive: Date,
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: Date,
  },
  { timestamps: true }
);

// Indexes
userSchema.index({ 'socialAccounts.google.email': 1 });
userSchema.index({ stripeCustomerId: 1 }, { sparse: true });

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Check if account is locked
userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

// Track login attempts
userSchema.methods.registerLoginAttempt = async function (success) {
  if (success) {
    this.failedLoginAttempts = 0;
    this.lockUntil = undefined;
    this.lastLogin = new Date();
  } else {
    this.failedLoginAttempts = (this.failedLoginAttempts || 0) + 1;
    if (this.failedLoginAttempts >= 5) {
      this.lockUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min lock
    }
  }
  await this.save();
};

// Check if user has a password set
userSchema.methods.hasPassword = function () {
  return !!this.password;
};

// Get connected OAuth providers
userSchema.methods.getConnectedProviders = function () {
  const providers = [];
  if (this.socialAccounts?.google?.id) providers.push('google');
  if (this.hasPassword()) providers.push('email');
  return providers;
};

// Generate password reset token
userSchema.methods.generatePasswordResetToken = async function () {
  const resetToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

  await ResetToken.create({
    userId: this._id,
    hashedToken,
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
  });

  return resetToken;
};

// Find user by reset token
userSchema.statics.findByResetToken = async function (token) {
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  const resetTokenDoc = await ResetToken.findOne({
    hashedToken,
    expiresAt: { $gt: Date.now() },
  });
  if (!resetTokenDoc) return null;
  return this.findById(resetTokenDoc.userId);
};

// Invalidate all tokens
userSchema.methods.invalidateTokens = async function () {
  this.tokenVersion = (this.tokenVersion || 0) + 1;
  return this.save();
};

// Update last active
userSchema.methods.updateLastActive = function () {
  this.lastActive = new Date();
  return this.save();
};

module.exports = mongoose.model('User', userSchema);
