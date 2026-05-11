const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Workspace = require('../models/Workspace');
const Avatar = require('../models/Avatar');
const UsageTracker = require('../models/UsageTracker');
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

    const [monthlyUsage, lifetimeUsage] = await Promise.all([
      UsageTracker.getUsage(orgId, monthPeriod),
      UsageTracker.getUsage(orgId, 'lifetime'),
    ]);

    // Total counts (seats, brand voices — counted from live documents)
    const wsIds = await Workspace.find({ organizationId: orgId }).distinct('_id');
    const [memberCount, avatarCount] = await Promise.all([
      OrgMember.countDocuments({ organizationId: orgId }),
      Avatar.countDocuments({ workspace: { $in: wsIds } }),
    ]);

    // Build usage response keyed by counter name
    function usageEntry(counterKey, limitKey, limitTypeKey) {
      const limit = config[limitKey];
      const limitType = config[limitTypeKey] || 'monthly';
      const source = limitType === 'lifetime' ? lifetimeUsage : monthlyUsage;
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
      seats: { used: memberCount + 1, limit: config.maxSeats }, // +1 for owner
      brandVoices: { used: avatarCount, limit: config.maxBrandVoices },
    };

    res.json({ tier, config, usage });
  } catch (err) {
    console.error('getTierInfo error:', err.message);
    res.status(500).json({ error: 'Failed to get tier info' });
  }
};

module.exports = { getTierInfo };
