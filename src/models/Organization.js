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

    // ─── Stripe Connect (Phase 16) ──────────────────────────────────
    // Track this org's Stripe Connect *Standard* onboarding state. The agency
    // owns its own Stripe account (disputes, tax, payouts); these flags are
    // synced from `account.updated` Connect webhooks. All default to null/false
    // (org has not connected yet).
    stripeConnectAccountId: {
      type: String,
      default: null,
      // Connected account id (acct_…). sparse index below — most orgs have none.
    },
    // The org's Stripe customer on the PLATFORM account (for platform billing +
    // one-time credit-pack purchases). Persisted so repeat purchases reuse one
    // customer instead of minting a duplicate each time.
    stripeCustomerId: { type: String, default: null },
    connectChargesEnabled: { type: Boolean, default: false },
    connectPayoutsEnabled: { type: Boolean, default: false },
    connectDetailsSubmitted: { type: Boolean, default: false },
    connectOnboardedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

organizationSchema.index({ ownerId: 1, name: 1 }, { unique: true });
// Sparse: only orgs that have connected a Stripe account are indexed.
organizationSchema.index({ stripeConnectAccountId: 1 }, { sparse: true });

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


module.exports = mongoose.model('Organization', organizationSchema);
