const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // Auto-generated from name on create; used in URLs
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    avatar: {
      type: String,
      default: null,
      // Optional URL for org avatar/logo
    },
    isPersonal: {
      type: Boolean,
      default: false,
      // true = auto-created personal org (one per user, cannot be deleted)
    },
  },
  { timestamps: true }
);

organizationSchema.index({ ownerId: 1, name: 1 }, { unique: true });

// Generate a URL-safe slug from the org name
organizationSchema.statics.generateSlug = async function (name, ownerId) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  // Try the base slug first, then append incrementing numbers
  let slug = base || 'org';
  let counter = 0;
  while (true) {
    const candidate = counter === 0 ? slug : `${slug}-${counter}`;
    const existing = await this.findOne({ slug: candidate });
    if (!existing) return candidate;
    counter++;
    if (counter > 100) {
      // Fallback: append random suffix
      return `${slug}-${Date.now().toString(36)}`;
    }
  }
};

// Find or create the personal org for a user
organizationSchema.statics.findOrCreatePersonal = async function (userId, userName, userEmail) {
  let org = await this.findOne({ ownerId: userId, isPersonal: true });
  if (!org) {
    const displayName = userName || userEmail?.split('@')[0] || 'My Organization';
    const slug = await this.generateSlug(displayName, userId);
    org = await this.create({
      name: displayName,
      slug,
      ownerId: userId,
      isPersonal: true,
    });
  }
  return org;
};

module.exports = mongoose.model('Organization', organizationSchema);
