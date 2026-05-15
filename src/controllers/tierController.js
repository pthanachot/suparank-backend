const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const Workspace = require('../models/Workspace');
const Avatar = require('../models/Avatar');
const BrandVoice = require('../models/BrandVoice');
const UsageTracker = require('../models/UsageTracker');
const Credit = require('../models/Credit');
const UserCredit = require('../models/UserCredit');
const UserUsageTracker = require('../models/UserUsageTracker');
const tierService = require('../services/tierService');

/**
 * GET /api/org/tier-info?orgId=...
 *
 * Returns the organisation's tier, full TierConfig, and current usage.
 * If orgId is not provided, resolves from the authenticated user's
 * personal org or first owned org.
 */
const getTierInfo = async (req, res) => {
  try {
    let orgId = req.query.orgId;

    // If no orgId supplied, try personal org
    if (!orgId) {
      const personalOrg = await Organization.findOne({
        ownerId: req.user.userId,
        isPersonal: true,
      })
        .select('_id')
        .lean();
      orgId = personalOrg?._id;
    }

    // Still nothing? Try first org the user owns
    if (!orgId) {
      const anyOrg = await Organization.findOne({ ownerId: req.user.userId })
        .select('_id')
        .lean();
      orgId = anyOrg?._id;
    }

    if (!orgId) {
      return res.json({ tier: 'free', config: null, usage: {} });
    }

    // Verify access: user must be owner or member
    const org = await Organization.findById(orgId).lean();
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const isOwner = org.ownerId.equals(req.user.userId);
    if (!isOwner) {
      const membership = await OrgMember.findOne({
        organizationId: orgId,
        userId: req.user.userId,
      }).lean();
      if (!membership) {
        return res.status(403).json({ error: 'Not a member of this organization' });
      }
    }

    const { tier, config } = await tierService.getOrgTierConfig(orgId);

    if (!config) {
      return res.json({ tier, config: null, usage: {} });
    }

    // ── Gather usage data ──

    const now = new Date();
    const monthPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [monthlyUsage, userLifetimeUsage] = await Promise.all([
      UsageTracker.getUsage(orgId, monthPeriod),
      UserUsageTracker.getUsage(req.user.userId),
    ]);

    // Extra seats from active subscription
    const sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
    }).lean();
    const extraSeats = sub?.purchasedExtraSeats || 0;

    // Total counts (live from documents, unlocked only for consistency with creation checks)
    const wsIds = await Workspace.find({ organizationId: orgId }).distinct('_id');
    const [memberCount, avatarCount, brandVoiceCount, wsCount] = await Promise.all([
      OrgMember.countDocuments({ organizationId: orgId, locked: { $ne: true } }),
      Avatar.countDocuments({ workspace: { $in: wsIds }, locked: { $ne: true } }),
      BrandVoice.countDocuments({ workspace: { $in: wsIds }, locked: { $ne: true } }),
      Workspace.countDocuments({ organizationId: orgId, locked: { $ne: true } }),
    ]);

    // Build usage response keyed by counter name
    // Lifetime quotas are now user-level, so read from userLifetimeUsage.
    function usageEntry(counterKey, limitKey, limitTypeKey) {
      const limit = config[limitKey];
      const limitType = config[limitTypeKey] || 'monthly';
      const source = limitType === 'lifetime' ? userLifetimeUsage : monthlyUsage;
      const used = source?.[counterKey] ?? 0;
      return {
        used,
        limit,
        limitType,
        period: limitType === 'lifetime' ? 'lifetime' : monthPeriod,
      };
    }

    const usage = {
      articlesCreated: usageEntry('articlesCreated', 'maxArticlesPerMonth', 'articleLimitType'),
      keywordSearches: usageEntry('keywordSearches', 'maxKeywordLookupsPerMonth', 'keywordLimitType'),
      auditsRun: usageEntry('auditsRun', 'maxAuditsPerMonth', 'auditLimitType'),
      aiTrackerPromptsCreated: usageEntry('aiTrackerPromptsCreated', 'maxAiTrackerPromptsPerMonth', 'aiTrackerPromptLimitType'),
      creditsUsed: usageEntry('creditsUsed', 'creditsPerMonth', 'creditLimitType'),
      // Total counts (not periodic)
      seats: { used: memberCount + 1, limit: config.maxSeats + extraSeats, baseLimit: config.maxSeats, extraSeats }, // +1 for owner
      brandVoices: { used: brandVoiceCount, limit: config.maxBrandVoices },
      avatars: { used: avatarCount, limit: config.maxAvatars },
      workspaces: { used: wsCount, limit: config.maxWorkspaces },
    };

    // ── Credit balance (org + user free) ──
    const [creditDoc, userCreditDoc] = await Promise.all([
      Credit.findOne({ organizationId: orgId }).lean(),
      UserCredit.findOne({ userId: req.user.userId }).lean(),
    ]);
    const userFree = userCreditDoc?.freeCredits || 0;
    const creditBalance = {
      subscription: creditDoc?.subscriptionCredits || 0,
      general: creditDoc?.generalCredits || 0,
      userFree,
      total: (creditDoc?.subscriptionCredits || 0) + userFree + (creditDoc?.generalCredits || 0),
      expiresAt: creditDoc?.subscriptionCreditsExpireAt || null,
    };

    // Always include free-tier lifetime usage so paid users can see
    // remaining free slots for the quota source selector.
    // Reuse userLifetimeUsage (already fetched above) for user-level counters.
    const freeTierConfig = await tierService.getTierConfig('free');
    const freeQuotaSlots = freeTierConfig ? {
      articlesCreated: {
        used: userLifetimeUsage?.articlesCreated ?? 0,
        limit: freeTierConfig.maxArticlesPerMonth ?? 3,
      },
      keywordSearches: {
        used: userLifetimeUsage?.keywordSearches ?? 0,
        limit: freeTierConfig.maxKeywordLookupsPerMonth ?? 50,
      },
      aiTrackerPromptsCreated: {
        used: userLifetimeUsage?.aiTrackerPromptsCreated ?? 0,
        limit: freeTierConfig.maxAiTrackerPromptsPerMonth ?? 5,
      },
      auditsRun: {
        used: userLifetimeUsage?.auditsRun ?? 0,
        limit: freeTierConfig.maxAuditsPerMonth ?? 5,
      },
    } : null;

    res.json({ tier, config, usage, creditBalance, freeQuotaSlots });
  } catch (err) {
    console.error('getTierInfo error:', err.message);
    res.status(500).json({ error: 'Failed to get tier info' });
  }
};

module.exports = { getTierInfo };
