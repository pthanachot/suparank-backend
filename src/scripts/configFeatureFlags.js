const FeatureFlag = require('../models/FeatureFlag');

// SOURCE OF TRUTH — synced to database on every server startup.
const FLAGS = [
  // ════════════════════════════════════════════════════════════════
  // IMPLEMENTED FEATURES
  // Each flag has conditions with tierLimitKey referencing TierConfig fields.
  // ════════════════════════════════════════════════════════════════

  {
    key: 'workspace',
    displayName: 'Workspaces',
    description: 'Create and manage workspaces.',
    enabled: true,
    implemented: true,
    conditions: {
      // Tier limit: free=1, standard=2, pro=5, agency=10.
      custom: { tierLimitKey: 'maxWorkspaces' },
    },
  },
  {
    key: 'content',
    displayName: 'Content Editor',
    description: 'Create, edit, and manage content articles.',
    enabled: true,
    implemented: true,
    conditions: {
      // Tier limit: free=3 lifetime, standard=20/mo, pro=50/mo, agency=unlimited.
      custom: { tierLimitKey: 'maxArticlesPerMonth' },
    },
  },
  {
    key: 'analysis',
    displayName: 'SEO Analysis',
    description: 'Run SEO analysis, audits, and view benchmark results.',
    enabled: true,
    implemented: true,
    conditions: {
      minimumPlan: null,
      // Tier limit: free=5 lifetime, standard=50/mo, pro=200/mo, agency=1000/mo.
      custom: { tierLimitKey: 'maxAuditsPerMonth' },
    },
  },
  {
    key: 'aiChat',
    displayName: 'AI Writing Agent',
    description: 'AI-powered chat, agent writing, and image generation.',
    enabled: true,
    implemented: true,
    conditions: {
      minimumPlan: null,
      maxUsagePerDay: null,
      // Consumes credits. 1 credit per 50 words generated.
      custom: {
        tierLimitKey: 'creditsPerMonth',
        creditsPerUnit: 1,
        unitDescription: '50 words',
      },
    },
  },
  {
    key: 'brandVoice',
    displayName: 'Brand Voice',
    description: 'Configure brand voice settings and avatars.',
    enabled: true,
    implemented: true,
    conditions: {
      // Tier limit: free=1, standard=1, pro=5, agency=unlimited.
      // Limit counts across ALL workspaces in the organization.
      custom: { tierLimitKey: 'maxBrandVoices' },
    },
  },
  {
    key: 'billing',
    displayName: 'Billing',
    description: 'Subscription management, checkout, and invoice history.',
    enabled: true,
    implemented: true,
    conditions: {
      allowedRoles: ['owner'],
      // No tier gating — all plans can access billing page.
    },
  },
  {
    key: 'aiTracker',
    displayName: 'AI Tracker',
    description: 'Monitor AI search engine visibility and competitor mentions.',
    enabled: true,
    implemented: true,
    conditions: {
      minimumPlan: null,
      // Tier limits: prompts, platforms, refresh interval.
      custom: {
        tierLimitKey: 'maxAiTrackerPromptsPerMonth',
        // Additional limits checked from TierConfig:
        //   maxAiTrackerPlatforms — number of LLM platforms per monitor
        //   aiTrackerRefreshInterval — 'weekly' or 'daily'
      },
    },
  },
  {
    key: 'keywords',
    displayName: 'Keyword Research',
    description: 'Search keywords, view SERP details, and manage research history.',
    enabled: true,
    implemented: true,
    conditions: {
      minimumPlan: null,
      // Tier limit: free=50 lifetime, standard=1000/mo, pro=5000/mo, agency=25000/mo.
      custom: { tierLimitKey: 'maxKeywordLookupsPerMonth' },
    },
  },
  {
    key: 'members',
    displayName: 'Organization Members',
    description: 'Invite and manage organization members with role-based access.',
    enabled: true,
    implemented: true,
    conditions: {
      // Tier limit: free=1 seat, standard=2, pro=5 (+$10/seat), agency=15 (+$15/seat).
      custom: { tierLimitKey: 'maxSeats' },
    },
  },

  // ════════════════════════════════════════════════════════════════
  // NOT YET IMPLEMENTED — placeholder flags
  //
  // enabled: true so the flag is returned to the frontend.
  // implemented: false so middleware returns "Feature coming soon"
  // and frontend can show "Coming Soon" badge.
  // ════════════════════════════════════════════════════════════════

  {
    key: 'sites',
    displayName: 'Sites / GSC',
    description: 'Connect sites to Google Search Console for performance data.',
    enabled: true,
    implemented: true,
    conditions: {
      // Tier limit: free=1, standard=3, pro=10, agency=unlimited.
      custom: { tierLimitKey: 'maxSites' },
    },
  },
  {
    key: 'sitemap',
    displayName: 'Sitemap Crawler',
    description: 'Crawl your website to discover pages and generate sitemap.xml.',
    enabled: true,
    implemented: true,
    conditions: {
      custom: { tierLimitKey: 'maxSitemaps' },
    },
  },
  {
    key: 'statFormulaBreakdown',
    displayName: 'Stat Formula Breakdown',
    description: 'Show calculation formulas and breakdowns when clicking stat card info icons.',
    enabled: true,
    implemented: true,
    conditions: {
      custom: {},
    },
  },
  {
    key: 'performanceCards',
    displayName: 'Performance Cards',
    description: 'View and export content performance reports.',
    enabled: true,
    implemented: false,
    conditions: {
      custom: {},
    },
  },
  {
    key: 'credits',
    displayName: 'Credits',
    description: 'Credit system for AI generation. 1 credit = 50 words.',
    enabled: true,
    implemented: false,
    conditions: {
      // Tier limit: free=300 lifetime, standard=3000/mo, pro=8000/mo, agency=25000/mo.
      custom: { tierLimitKey: 'creditsPerMonth' },
    },
  },
  {
    key: 'auditLog',
    displayName: 'Audit Log',
    description: 'Track member actions and changes within the organization.',
    enabled: true,
    implemented: false,
    conditions: {
      minimumPlan: 'professional',
      custom: {},
    },
  },
  {
    key: 'teamPages',
    displayName: 'Team Pages',
    description: 'Create and manage team groupings within the organization.',
    enabled: true,
    implemented: false,
    conditions: {
      minimumPlan: 'professional',
      custom: {},
    },
  },
  {
    key: 'apiAccess',
    displayName: 'API Access',
    description: 'Programmatic access to SupaRank features via REST API.',
    enabled: true,
    implemented: false,
    conditions: {
      minimumPlan: 'agency',
      custom: {},
    },
  },
  {
    key: 'whiteLabel',
    displayName: 'White Label',
    description: 'Custom branding for reports and the platform.',
    enabled: true,
    implemented: false,
    conditions: {
      minimumPlan: 'agency',
      custom: {},
    },
  },
  {
    key: 'bulkExport',
    displayName: 'Bulk Export',
    description: 'Export multiple articles at once in various formats.',
    enabled: true,
    implemented: false,
    conditions: {
      minimumPlan: 'professional',
      custom: {},
    },
  },
  {
    // White-label tenant domains (Phases 8-10). Fully built; ships dark.
    //
    // LAUNCH ORDER (matters): 1) deploy the FRONTEND with
    // NEXT_PUBLIC_TENANT_DOMAINS_ENABLED=true (build-time env — needs a
    // redeploy, harmless while no domains are active), verify it, THEN
    // 2) flip `implemented: true` here and deploy the backend. Backend-first
    // would let domains activate while tenant hosts still serve the
    // un-tenanted platform UI.
    //
    // KILL: edit this file (implemented: false) and redeploy — a restart
    // clears all flag caches. Editing the FeatureFlag document directly in
    // Mongo also works but propagates in ≤5 minutes (two per-process TTL
    // caches) and is overwritten by the next deploy's config sync.
    //
    // While off: domain APIs return 404 'coming soon', host→org resolution
    // returns null (tenant hosts get the platform brand), and
    // resolveBaseUrl always uses FRONTEND_URL.
    key: 'customDomains',
    displayName: 'Custom Domains',
    description: 'Serve the app on your own domain with your branding (white-label).',
    enabled: true,
    implemented: false,
    conditions: {
      custom: {},
    },
  },
  {
    // White-label email (Phases 11-12). Ships dark like customDomains.
    // While off: email-domain + tenant-template APIs 404 'coming soon',
    // sender identity always resolves to the platform default, and tenant
    // template overrides are ignored (global/default chain still applies).
    key: 'whiteLabelEmail',
    displayName: 'White-label Email',
    description: 'Send client emails from your own domain with your templates.',
    enabled: true,
    implemented: false,
    conditions: {
      custom: {},
    },
  },
  {
    // SaaS mode (Phase 16 — Stripe Connect). Ships dark like customDomains.
    //
    // LAUNCH ORDER (matters): 1) deploy the FRONTEND with
    // NEXT_PUBLIC_SAAS_MODE_ENABLED=true (build-time env — needs a redeploy,
    // harmless while no agency has connected an account), verify it, THEN
    // 2) flip `implemented: true` here and deploy the backend. Backend-first
    // would expose rebilling endpoints while the tenant UI still lacks the
    // Connect onboarding + client-billing surfaces.
    //
    // KILL: edit this file (implemented: false) and redeploy — a restart
    // clears all flag caches. Editing the FeatureFlag document directly in
    // Mongo also works but propagates in ≤5 minutes (two per-process TTL
    // caches) and is overwritten by the next deploy's config sync.
    //
    // While off: Stripe Connect onboarding + client-rebilling APIs return
    // 404 'coming soon', and no agency-managed subscriptions are created.
    key: 'saasMode',
    displayName: 'SaaS Mode',
    description: 'SaaS mode — agencies rebill their own clients via Stripe Connect.',
    enabled: true,
    implemented: true,
    conditions: {
      custom: {},
    },
  },
  {
    key: 'advancedAnalytics',
    displayName: 'Advanced Analytics',
    description: 'Advanced analytics dashboard with custom reporting.',
    enabled: true,
    implemented: false,
    conditions: {
      minimumPlan: 'professional',
      custom: {},
    },
  },
  {
    key: 'contentVersionHistory',
    displayName: 'Content Version History',
    description: 'View and restore previous versions of content articles.',
    enabled: true,
    implemented: false,
    conditions: {
      // Tier limit: free=7 days, standard=30 days, pro=90 days, agency=180 days.
      custom: { tierLimitKey: 'contentVersionHistoryDays' },
    },
  },
];

async function syncFeatureFlags() {
  let upserted = 0;
  let updated = 0;

  const configKeys = FLAGS.map((f) => f.key);

  for (const flag of FLAGS) {
    const result = await FeatureFlag.updateOne(
      { key: flag.key },
      { $set: flag },
      { upsert: true }
    );
    if (result.upsertedCount > 0) upserted++;
    else if (result.modifiedCount > 0) updated++;
  }

  // Remove flags no longer in config
  const removed = await FeatureFlag.deleteMany({ key: { $nin: configKeys } });

  console.log(`[syncFeatureFlags] ${upserted} created, ${updated} updated, ${removed.deletedCount} removed`);
}

module.exports = { syncFeatureFlags, FLAGS };
