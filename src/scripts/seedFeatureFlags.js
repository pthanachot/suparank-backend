const FeatureFlag = require('../models/FeatureFlag');

const FLAGS = [
  // ── Implemented features (different conditions per feature) ──
  {
    key: 'workspace',
    displayName: 'Workspaces',
    description: 'Create and manage workspaces.',
    enabled: true,
    implemented: true,
    conditions: {},
  },
  {
    key: 'content',
    displayName: 'Content Editor',
    description: 'Create, edit, and manage content articles.',
    enabled: true,
    implemented: true,
    conditions: {},
  },
  {
    key: 'analysis',
    displayName: 'SEO Analysis',
    description: 'Run SEO analysis, audits, and view benchmark results.',
    enabled: true,
    implemented: true,
    conditions: { minimumPlan: null },
  },
  {
    key: 'aiChat',
    displayName: 'AI Writing Agent',
    description: 'AI-powered chat, agent writing, and image generation.',
    enabled: true,
    implemented: true,
    conditions: { minimumPlan: null, maxUsagePerDay: null },
  },
  {
    key: 'brandVoice',
    displayName: 'Brand Voice',
    description: 'Configure brand voice settings and avatars.',
    enabled: true,
    implemented: true,
    conditions: {},
  },
  {
    key: 'billing',
    displayName: 'Billing',
    description: 'Subscription management, checkout, and invoice history.',
    enabled: true,
    implemented: true,
    conditions: { allowedRoles: ['owner'] },
  },
  {
    key: 'aiTracker',
    displayName: 'AI Tracker',
    description: 'Monitor AI search engine visibility and competitor mentions.',
    enabled: true,
    implemented: true,
    conditions: { minimumPlan: null, custom: { maxMonitors: 1 } },
  },
  {
    key: 'keywords',
    displayName: 'Keyword Research',
    description: 'Search keywords, view SERP details, and manage research history.',
    enabled: true,
    implemented: true,
    conditions: { minimumPlan: null, custom: { maxSearchesPerDay: 10 } },
  },
  {
    key: 'members',
    displayName: 'Organization Members',
    description: 'Invite and manage organization members with role-based access.',
    enabled: true,
    implemented: true,
    conditions: { custom: { maxMembers: 3 } },
  },

  // ── Not implemented yet — placeholder flags ──
  // Uncomment when feature is ready to develop.
  //
  // {
  //   key: 'auditLog',
  //   displayName: 'Audit Log',
  //   description: 'Track member actions and changes.',
  //   enabled: false,
  //   implemented: false,
  //   conditions: {},
  // },
  // {
  //   key: 'teamPages',
  //   displayName: 'Team Pages',
  //   description: 'Create and manage team groupings within the organization.',
  //   enabled: false,
  //   implemented: false,
  //   conditions: {},
  // },
  // {
  //   key: 'apiAccess',
  //   displayName: 'API Access',
  //   description: 'Programmatic access to SupaRank features.',
  //   enabled: false,
  //   implemented: false,
  //   conditions: { minimumPlan: 'enterprise' },
  // },
  // {
  //   key: 'whiteLabel',
  //   displayName: 'White Label',
  //   description: 'Custom branding for the platform.',
  //   enabled: false,
  //   implemented: false,
  //   conditions: { minimumPlan: 'enterprise' },
  // },
  // {
  //   key: 'bulkExport',
  //   displayName: 'Bulk Export',
  //   description: 'Export multiple articles at once.',
  //   enabled: false,
  //   implemented: false,
  //   conditions: { minimumPlan: 'pro' },
  // },
];

async function seedFeatureFlags() {
  let created = 0;
  let skipped = 0;

  for (const flag of FLAGS) {
    const result = await FeatureFlag.updateOne(
      { key: flag.key },
      { $setOnInsert: flag },
      { upsert: true }
    );
    if (result.upsertedCount > 0) created++;
    else skipped++;
  }

  console.log(`[seedFeatureFlags] ${created} created, ${skipped} already existed`);
}

module.exports = { seedFeatureFlags, FLAGS };
