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

    // ─── Tenant lifecycle (Phase 18) ────────────────────────────────
    // Agency offboarding state machine (see services/lifecycleService.js). An org
    // only ever leaves 'active' when saasMode is LIVE and the agency loses its
    // white-label/SaaS entitlement while holding live client assets. With the
    // flag dark this stays 'active' for every org, so all lifecycle gates are
    // inert and behaviour is byte-identical to pre-Phase-18.
    //   active        → normal.
    //   winding_down  → entitlement lost; 30-day grace. New client signups
    //                   blocked; agency can still recover by re-subscribing.
    //   suspended     → grace expired; domains torn down, brand reverted, client
    //                   workspaces locked, client subs cancelled. Data retained
    //                   (90 days) for export/restore, then purge-eligible (Ph 18C).
    //   suspending    → transient claim held while teardown runs (recover cannot
    //                   touch it, so a re-subscribe can't strand torn-down infra);
    //                   re-driven by the cron if a crash interrupts teardown.
    //   restoring     → transient claim held while a suspended tenant is brought
    //                   back (Phase 18D). Re-run restore to re-drive a crashed one
    //                   (an hourly sweep resumes stale ones).
    //   purging       → transient claim held while the retention purge deletes a
    //                   suspended org's client workspaces (Phase 18C). Claimed
    //                   BEFORE any delete so a concurrent restore (which claims
    //                   'suspended') can't win mid-purge; restore/purge claims
    //                   exclude each other's transient state → fully serialised.
    lifecycleStatus: {
      type: String,
      enum: ['active', 'winding_down', 'suspending', 'suspended', 'restoring', 'purging'],
      default: 'active',
      index: true,
    },
    lifecycleReason: { type: String, default: null },
    windDownStartedAt: { type: Date, default: null },
    suspendAt: { type: Date, default: null },   // grace deadline (windDownStartedAt + GRACE_DAYS)
    suspendedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },     // retention deadline (suspendedAt + RETENTION_DAYS); Phase 18C
    purgedAt: { type: Date, default: null },    // when the suspended org's client workspaces were purged (Phase 18C)
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
