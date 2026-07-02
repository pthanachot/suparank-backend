/**
 * Admin controller — handles admin-only operations for SupaRank.
 *
 * All routes gated by authenticateToken + validateAdmin middleware.
 */

const User = require('../models/User');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Subscription = require('../models/Subscription');
const Credit = require('../models/Credit');
const UserCredit = require('../models/UserCredit');
const CreditTransaction = require('../models/CreditTransaction');
const Workspace = require('../models/Workspace');
const Content = require('../models/Content');
const UsageTracker = require('../models/UsageTracker');
const UserUsageTracker = require('../models/UserUsageTracker');
const TierConfig = require('../models/TierConfig');
const AiTracker = require('../models/AiTracker');
const AiTrackerCompetitor = require('../models/AiTrackerCompetitor');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTrackerScan = require('../models/AiTrackerScan');
const AgentUsageLog = require('../models/AgentUsageLog');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const Site = require('../models/Site');
const Session = require('../models/Session');
const ResetToken = require('../models/ResetToken');
const BrandVoiceTestLog = require('../models/BrandVoiceTestLog');
const Avatar = require('../models/Avatar');
const BrandVoice = require('../models/BrandVoice');
const creditService = require('../services/creditService');
const Stripe = require('stripe');

// ─── User lookup (for frontend admin auth verification) ─────

const userLookup = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('userId email roles status');

    if (!user) {
      return res.status(404).json({ valid: false, error: 'User not found' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ valid: false, error: 'User account not active' });
    }

    // Check admin email list — union of env var and DB-managed settings list
    const { getSettings } = require('../services/systemSettingsService');
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase());
    const dbAdminEmails = (getSettings().adminEmails || []).map((e) => String(e).toLowerCase());
    const isAdmin =
      adminEmails.includes(user.email.toLowerCase()) || dbAdminEmails.includes(user.email.toLowerCase());

    // Also check roles array
    const hasAdminRole =
      user.roles?.includes('admin') ||
      user.roles?.includes('super_admin') ||
      user.roles?.includes('administrator');

    if (!isAdmin && !hasAdminRole) {
      return res.status(403).json({ valid: false, error: 'Admin access required' });
    }

    res.json({
      valid: true,
      user: {
        userId: user._id.toString(),
        email: user.email,
        roles: isAdmin ? [...(user.roles || []), 'admin'] : user.roles || [],
        status: user.status,
      },
    });
  } catch (error) {
    console.error('[admin] userLookup error:', error.message);
    res.status(500).json({ valid: false, error: 'Lookup failed' });
  }
};

// ─── Dashboard stats ────────────────────────────────────────

const getDashboardStats = async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      newUsersThisMonth,
      totalOrganizations,
      activeSubscriptions,
      totalWorkspaces,
      totalContent,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      Organization.countDocuments(),
      Subscription.countDocuments({ status: { $in: ['active', 'trialing'] } }),
      Workspace.countDocuments(),
      Content.countDocuments(),
    ]);

    // Revenue estimate from active subscriptions
    const subscriptions = await Subscription.find({
      status: { $in: ['active', 'trialing'] },
    })
      .select('planId')
      .lean();

    let monthlyRevenue = 0;
    for (const sub of subscriptions) {
      const plan = sub.planId || '';
      if (plan.includes('standard')) monthlyRevenue += 29;
      else if (plan.includes('professional')) monthlyRevenue += 79;
      else if (plan.includes('agency')) monthlyRevenue += 199;
    }

    // Credit stats
    const creditTxs = await CreditTransaction.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
    });

    res.json({
      totalUsers,
      newUsersThisMonth,
      totalOrganizations,
      activeSubscriptions,
      totalWorkspaces,
      totalContent,
      monthlyRevenue,
      creditTransactions: creditTxs,
    });
  } catch (error) {
    console.error('[admin] getDashboardStats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

// ─── Users list ─────────────────────────────────────────────

const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const status = req.query.status || 'all';
    const sortBy = req.query.sortBy || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    const filter = {};
    if (status !== 'all') filter.status = status;
    if (search) {
      filter.$or = [
        { email: { $regex: search, $options: 'i' } },
        { 'profile.name': { $regex: search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('userId email profile status verified roles lastLogin createdAt')
        .sort({ [sortBy]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    // Batch-enrich with all org memberships + owned orgs
    // Owner role is implicit (not stored in OrgMember), so query both sources
    const userIds = users.map((u) => u._id);
    const [allMemberships, ownedOrgs] = await Promise.all([
      OrgMember.find({ userId: { $in: userIds }, status: 'active' })
        .select('userId organizationId role')
        .lean(),
      Organization.find({ ownerId: { $in: userIds } })
        .select('ownerId name')
        .lean(),
    ]);

    // Collect all org IDs from both memberships and owned orgs
    const memberOrgIds = allMemberships.map((m) => m.organizationId.toString());
    const ownedOrgIds = ownedOrgs.map((o) => o._id.toString());
    const allOrgIds = [...new Set([...memberOrgIds, ...ownedOrgIds])];

    const [allOrgs, allSubs] = await Promise.all([
      Organization.find({ _id: { $in: allOrgIds } }).select('name').lean(),
      Subscription.find({ organizationId: { $in: allOrgIds } }).select('organizationId planId status').lean(),
    ]);

    const orgMap = Object.fromEntries(allOrgs.map((o) => [o._id.toString(), o]));
    const subMap = Object.fromEntries(allSubs.map((s) => [s.organizationId.toString(), s]));

    // Build a map of ownerId -> [orgIds] for fast lookup
    const ownerOrgMap = new Map();
    for (const o of ownedOrgs) {
      const ownerStr = o.ownerId.toString();
      if (!ownerOrgMap.has(ownerStr)) ownerOrgMap.set(ownerStr, []);
      ownerOrgMap.get(ownerStr).push(o._id.toString());
    }

    const enriched = users.map((user) => {
      const userIdStr = user._id.toString();

      // Start with owned orgs (role: 'owner')
      const seenOrgIds = new Set();
      const organizations = [];

      const userOwnedOrgIds = ownerOrgMap.get(userIdStr) || [];
      for (const orgIdStr of userOwnedOrgIds) {
        seenOrgIds.add(orgIdStr);
        const org = orgMap[orgIdStr];
        const sub = subMap[orgIdStr];
        organizations.push({
          id: orgIdStr,
          name: org?.name || 'Unknown',
          plan: sub?.planId?.split('-')[0] || 'free',
          role: 'owner',
        });
      }

      // Add member orgs (skip if already added as owner)
      const memberships = allMemberships.filter((m) => m.userId.toString() === userIdStr);
      for (const m of memberships) {
        const orgIdStr = m.organizationId.toString();
        if (seenOrgIds.has(orgIdStr)) continue;
        seenOrgIds.add(orgIdStr);
        const org = orgMap[orgIdStr];
        const sub = subMap[orgIdStr];
        organizations.push({
          id: m.organizationId,
          name: org?.name || 'Unknown',
          plan: sub?.planId?.split('-')[0] || 'free',
          role: m.role,
        });
      }

      return {
        id: user._id,
        userId: user.userId,
        email: user.email,
        nickname: user.profile?.name || 'N/A',
        status: user.status || 'active',
        verified: user.verified || false,
        roles: user.roles || [],
        organizations,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
      };
    });

    res.json({
      users: enriched,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('[admin] getUsers error:', error.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

// ─── Subscriptions list ─────────────────────────────────────

const getSubscriptions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status || 'all';
    const search = req.query.search || '';
    const plan = req.query.plan || 'all';
    const sortBy = req.query.sortBy || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    const filter = {};
    if (status !== 'all') filter.status = status;
    if (plan !== 'all') filter.planId = { $regex: `^${plan}`, $options: 'i' };

    // Build sort
    const sortField = ['createdAt', 'currentPeriodEnd', 'planId'].includes(sortBy) ? sortBy : 'createdAt';

    // If searching, find matching user/org IDs first
    let userIdFilter = null;
    let orgIdFilter = null;
    if (search) {
      const [matchingUsers, matchingOrgs] = await Promise.all([
        User.find({
          $or: [
            { email: { $regex: search, $options: 'i' } },
            { 'profile.name': { $regex: search, $options: 'i' } },
          ],
        }).select('_id').lean(),
        Organization.find({
          name: { $regex: search, $options: 'i' },
        }).select('_id').lean(),
      ]);
      userIdFilter = matchingUsers.map((u) => u._id);
      orgIdFilter = matchingOrgs.map((o) => o._id);

      filter.$or = [
        ...(userIdFilter.length ? [{ userId: { $in: userIdFilter } }] : []),
        ...(orgIdFilter.length ? [{ organizationId: { $in: orgIdFilter } }] : []),
      ];
      // If no matches at all, return empty
      if (!filter.$or.length) {
        return res.json({
          subscriptions: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
    }

    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter)
        .sort({ [sortField]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Subscription.countDocuments(filter),
    ]);

    // Enrich with user/org info
    const enriched = await Promise.all(
      subscriptions.map(async (sub) => {
        const user = await User.findById(sub.userId).select('email profile').lean();
        const org = await Organization.findById(sub.organizationId).select('name').lean();

        return {
          id: sub._id,
          subId: sub._id,
          userId: sub.userId,
          organizationId: sub.organizationId,
          user: {
            email: user?.email || 'Unknown',
            nickname: user?.profile?.name || 'N/A',
          },
          organization: org?.name || 'Unknown',
          planId: sub.planId,
          plan: sub.planId?.split('-')[0] || 'free',
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd || false,
          autoRenew: !sub.canceledAt,
          stripeSubscriptionId: sub.stripeSubscriptionId || null,
          createdAt: sub.createdAt,
        };
      })
    );

    res.json({
      subscriptions: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[admin] getSubscriptions error:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
};

// ─── Credit management ──────────────────────────────────────

const manageUserCredits = async (req, res) => {
  try {
    const { userId } = req.params;
    const { action, amount, reason } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const user = await User.findOne({ userId: parseInt(userId) });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get or create UserCredit
    const userCredit = await UserCredit.getOrCreateForUser(user._id);
    const previousBalance = userCredit.freeCredits;

    if (action === 'add') {
      userCredit.freeCredits += amount;
    } else if (action === 'subtract') {
      userCredit.freeCredits = Math.max(0, userCredit.freeCredits - amount);
    } else if (action === 'set') {
      userCredit.freeCredits = amount;
    } else {
      return res.status(400).json({ error: 'Invalid action. Use: add, subtract, set' });
    }

    await userCredit.save();

    // Log the transaction
    await CreditTransaction.logTransaction({
      orgId: null,
      userId: user._id,
      type: 'general_grant',
      amount: action === 'subtract' ? -amount : amount,
      pool: 'user_free',
      description: reason || `Admin ${action}: ${amount} credits`,
      balanceAfter: userCredit.freeCredits,
    });

    // Compute total balance including org credits
    const membership = await OrgMember.findOne({ userId: user._id, status: 'active' })
      .select('organizationId')
      .lean();
    let orgCredits = 0;
    if (membership) {
      const credit = await Credit.findOne({ organizationId: membership.organizationId }).lean();
      orgCredits = (credit?.subscriptionCredits || 0) + (credit?.generalCredits || 0);
    }

    res.json({
      previousBalance,
      newBalance: orgCredits + userCredit.freeCredits,
      newFreeBalance: userCredit.freeCredits,
      action,
      amount,
    });
  } catch (error) {
    console.error('[admin] manageUserCredits error:', error.message);
    res.status(500).json({ error: 'Failed to manage credits' });
  }
};

// ─── Organizations list ─────────────────────────────────────

const getOrganizations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ];
    }

    const [orgs, total] = await Promise.all([
      Organization.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Organization.countDocuments(filter),
    ]);

    const enriched = await Promise.all(
      orgs.map(async (org) => {
        const [memberCount, workspaceCount, sub, owner, credit] = await Promise.all([
          OrgMember.countDocuments({ organizationId: org._id, status: 'active' }),
          Workspace.countDocuments({ organizationId: org._id }),
          Subscription.findOne({
            organizationId: org._id,
            status: { $in: ['active', 'trialing'] },
          })
            .select('planId status')
            .lean(),
          User.findById(org.ownerId).select('email profile').lean(),
          Credit.findOne({ organizationId: org._id }).lean(),
        ]);

        return {
          id: org._id,
          name: org.name,
          slug: org.slug,
          owner: owner?.email || 'Unknown',
          memberCount,
          workspaceCount,
          plan: sub?.planId?.split('-')[0] || 'free',
          subscriptionStatus: sub?.status || 'none',
          isPersonal: org.isPersonal || false,
          credits: {
            subscription: credit?.subscriptionCredits || 0,
            general: credit?.generalCredits || 0,
            total: (credit?.subscriptionCredits || 0) + (credit?.generalCredits || 0),
          },
          createdAt: org.createdAt,
        };
      })
    );

    res.json({
      organizations: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[admin] getOrganizations error:', error.message);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
};

// ─── Organization detail ────────────────────────────────────

const getOrganizationDetail = async (req, res) => {
  try {
    const { orgId } = req.params;

    const org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Resolve tier from subscription (orgs have no free tier — free belongs to individual users)
    const activeSub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trialing'] },
    })
      .select('planId')
      .lean();
    const tierName = activeSub?.planId ? activeSub.planId.split('-')[0] : null;
    const normalized = tierName && tierName !== 'free'
      ? (tierName === 'pro' ? 'professional' : tierName)
      : null;

    const [owner, members, subscription, credit, workspaces, tierConfig] = await Promise.all([
      User.findById(org.ownerId).select('email profile userId status').lean(),
      OrgMember.find({ organizationId: orgId }).select('userId email role status locked').lean(),
      Subscription.findOne({ organizationId: orgId }).lean(),
      Credit.findOne({ organizationId: orgId }).lean(),
      Workspace.find({ organizationId: orgId }).select('name workspaceNumber locked members createdAt').lean(),
      normalized ? TierConfig.findOne({ tier: normalized }).lean() : Promise.resolve(null),
    ]);

    // Current period usage
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [monthlyUsage, lifetimeUsage] = await Promise.all([
      UsageTracker.findOne({ organizationId: orgId, period }).lean(),
      UsageTracker.findOne({ organizationId: orgId, period: 'lifetime' }).lean(),
    ]);

    // Enrich members with profile info
    const enrichedMembers = await Promise.all(
      members.map(async (m) => {
        const user = await User.findById(m.userId).select('profile status').lean();
        return { ...m, name: user?.profile?.name || 'N/A', userStatus: user?.status };
      })
    );

    // Recent credit transactions
    const recentTransactions = await CreditTransaction.find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.json({
      organization: {
        id: org._id,
        name: org.name,
        slug: org.slug,
        isPersonal: org.isPersonal,
        avatar: org.avatar,
        createdAt: org.createdAt,
      },
      owner: owner
        ? {
            id: owner._id,
            userId: owner.userId,
            email: owner.email,
            name: owner.profile?.name || 'N/A',
            status: owner.status,
          }
        : null,
      members: enrichedMembers,
      subscription: subscription
        ? {
            id: subscription._id,
            planId: subscription.planId,
            plan: subscription.planId?.split('-')[0] || 'free',
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            canceledAt: subscription.canceledAt,
            purchasedExtraSeats: subscription.purchasedExtraSeats,
            stripeCustomerId: subscription.stripeCustomerId,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            defaultPaymentMethod: subscription.defaultPaymentMethod,
          }
        : null,
      credits: {
        subscription: credit?.subscriptionCredits || 0,
        general: credit?.generalCredits || 0,
        total: (credit?.subscriptionCredits || 0) + (credit?.generalCredits || 0),
        expiresAt: credit?.subscriptionCreditsExpireAt || null,
        lastResetAt: credit?.lastResetAt || null,
      },
      usage: {
        monthly: monthlyUsage || {},
        lifetime: lifetimeUsage || {},
      },
      tierConfig: tierConfig || null,
      workspaces,
      recentTransactions,
    });
  } catch (error) {
    console.error('[admin] getOrganizationDetail error:', error.message);
    res.status(500).json({ error: 'Failed to fetch organization detail' });
  }
};

// ─── Update organization ────────────────────────────────────

const updateOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { name } = req.body;

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    if (name && name.trim() && name.trim() !== org.name) {
      org.name = name.trim();
      org.slug = await Organization.generateSlug(name.trim(), org.ownerId);
    }

    await org.save();
    res.json({ success: true, organization: { id: org._id, name: org.name, slug: org.slug } });
  } catch (error) {
    console.error('[admin] updateOrganization error:', error.message);
    res.status(500).json({ error: 'Failed to update organization' });
  }
};

// ─── Manage org credits ─────────────────────────────────────

const manageOrgCredits = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { action, amount, pool, reason } = req.body;

    if (!amount || isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }
    if (!['subscription', 'general'].includes(pool)) {
      return res.status(400).json({ error: 'Pool must be "subscription" or "general"' });
    }
    if (!['add', 'subtract', 'set'].includes(action)) {
      return res.status(400).json({ error: 'Action must be "add", "subtract", or "set"' });
    }

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const credit = await Credit.getOrCreateForOrg(orgId);
    const field = pool === 'subscription' ? 'subscriptionCredits' : 'generalCredits';
    const previousBalance = credit[field];

    if (action === 'add') {
      credit[field] += amount;
    } else if (action === 'subtract') {
      credit[field] = Math.max(0, credit[field] - amount);
    } else if (action === 'set') {
      credit[field] = amount;
    }

    if (action !== 'subtract') credit.lowBalanceNotifiedAt = null; // re-arm credits_low
    await credit.save();

    await CreditTransaction.logTransaction({
      orgId,
      userId: null,
      type: action === 'subtract' ? 'adjustment' : 'general_grant',
      amount: action === 'subtract' ? -amount : amount,
      pool,
      description: reason || `Admin ${action}: ${amount} ${pool} credits`,
      balanceAfter: credit[field],
    });

    res.json({
      previousBalance,
      newBalance: credit[field],
      totalOrgCredits: credit.subscriptionCredits + credit.generalCredits,
      pool,
      action,
      amount,
    });
  } catch (error) {
    console.error('[admin] manageOrgCredits error:', error.message);
    res.status(500).json({ error: 'Failed to manage org credits' });
  }
};

// ─── Update subscription (admin override) ───────────────────

const updateSubscription = async (req, res) => {
  try {
    const { subId } = req.params;
    const { action } = req.body;

    const sub = await Subscription.findById(subId);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const VALID_ACTIONS = ['cancel_at_period_end', 'reactivate', 'cancel_immediately'];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (sub.stripeSubscriptionId) {
      // Stripe is the source of truth: call it first, persist only on success.
      // Credits expiry, usage reset, and customer email are owned by the
      // webhook handlers (subscription.updated / subscription.deleted).
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      try {
        if (action === 'cancel_at_period_end') {
          await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: true,
          });
          sub.cancelAtPeriodEnd = true;
          // canceledAt is set by the subscription.updated webhook — the sub
          // is only scheduled to cancel, not canceled yet.
        } else if (action === 'reactivate') {
          if (sub.status === 'canceled') {
            return res.status(409).json({
              error:
                'Subscription is already terminated at Stripe and cannot be reactivated. Create a new subscription instead.',
            });
          }
          await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
          });
          sub.cancelAtPeriodEnd = false;
          sub.canceledAt = null;
        } else if (action === 'cancel_immediately') {
          await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
          sub.status = 'canceled';
          sub.canceledAt = new Date();
        }
      } catch (stripeError) {
        if (stripeError.code === 'resource_missing') {
          // Already gone at Stripe — reconcile the local record.
          sub.status = 'canceled';
          sub.canceledAt = sub.canceledAt || new Date();
          sub.cancelAtPeriodEnd = false;
          await sub.save();
          if (action === 'reactivate') {
            return res.status(409).json({
              error:
                'Subscription no longer exists at Stripe and cannot be reactivated. Create a new subscription instead.',
            });
          }
          // For cancel actions the desired end state is reached — respond normally.
          return res.json({
            success: true,
            subscription: {
              id: sub._id,
              status: sub.status,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              canceledAt: sub.canceledAt,
            },
          });
        }
        console.error('[admin] updateSubscription Stripe error:', stripeError.message);
        return res.status(502).json({ error: `Stripe error: ${stripeError.message}` });
      }
    } else {
      // Manual/legacy subscription with no Stripe record — DB-only override.
      console.log(`[admin] manual (non-Stripe) subscription override: sub=${subId} action=${action}`);
      if (action === 'cancel_at_period_end') {
        sub.cancelAtPeriodEnd = true;
        sub.canceledAt = new Date();
      } else if (action === 'reactivate') {
        sub.cancelAtPeriodEnd = false;
        sub.canceledAt = null;
        if (sub.status === 'canceled') sub.status = 'active';
      } else if (action === 'cancel_immediately') {
        sub.status = 'canceled';
        sub.canceledAt = new Date();
        await creditService.expireSubscriptionCredits(sub.organizationId);
      }
    }

    await sub.save();

    res.json({
      success: true,
      subscription: {
        id: sub._id,
        status: sub.status,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        canceledAt: sub.canceledAt,
      },
    });
  } catch (error) {
    console.error('[admin] updateSubscription error:', error.message);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
};

// ─── User detail ────────────────────────────────────────────

const getUserDetail = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findOne({ userId: parseInt(userId) })
      .select('userId email profile status verified roles lastLogin createdAt')
      .lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [userCredit, userUsage, freeTier, memberships, ownedOrgs] = await Promise.all([
      UserCredit.findOne({ userId: user._id }).lean(),
      UserUsageTracker.findOne({ userId: user._id }).lean(),
      TierConfig.findOne({ tier: 'free' }).lean(),
      OrgMember.find({ userId: user._id, status: 'active' }).select('organizationId role status locked').lean(),
      Organization.find({ ownerId: user._id }).select('_id name slug').lean(),
    ]);

    // Enrich owned orgs (owner role is implicit, not in OrgMember)
    const seenOrgIds = new Set();
    const enrichedOrgs = [];

    for (const ownedOrg of ownedOrgs) {
      const orgIdStr = ownedOrg._id.toString();
      seenOrgIds.add(orgIdStr);
      const sub = await Subscription.findOne({ organizationId: ownedOrg._id }).select('planId status').lean();
      enrichedOrgs.push({
        id: ownedOrg._id,
        name: ownedOrg.name,
        slug: ownedOrg.slug || '',
        plan: sub?.planId?.split('-')[0] || 'free',
        planStatus: sub?.status || 'none',
        role: 'owner',
        status: 'active',
        locked: false,
      });
    }

    // Enrich member orgs (skip if already added as owner)
    for (const m of memberships) {
      const orgIdStr = m.organizationId.toString();
      if (seenOrgIds.has(orgIdStr)) continue;
      seenOrgIds.add(orgIdStr);
      const [org, sub] = await Promise.all([
        Organization.findById(m.organizationId).select('name slug').lean(),
        Subscription.findOne({ organizationId: m.organizationId }).select('planId status').lean(),
      ]);
      enrichedOrgs.push({
        id: m.organizationId,
        name: org?.name || 'Unknown',
        slug: org?.slug || '',
        plan: sub?.planId?.split('-')[0] || 'free',
        planStatus: sub?.status || 'none',
        role: m.role,
        status: m.status,
        locked: m.locked || false,
      });
    }

    res.json({
      user: {
        id: user._id,
        userId: user.userId,
        email: user.email,
        nickname: user.profile?.name || 'N/A',
        status: user.status || 'active',
        verified: user.verified || false,
        roles: user.roles || [],
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
      },
      freeCredits: {
        balance: userCredit?.freeCredits || 0,
        grantedAt: userCredit?.grantedAt || null,
      },
      usage: userUsage || {},
      freeTierConfig: freeTier || null,
      organizations: enrichedOrgs,
    });
  } catch (error) {
    console.error('[admin] getUserDetail error:', error.message);
    res.status(500).json({ error: 'Failed to fetch user detail' });
  }
};

// ─── Manage user quota (UserUsageTracker) ───────────────────

const VALID_COUNTERS = ['articlesCreated', 'keywordSearches', 'auditsRun', 'aiTrackerPromptsCreated', 'creditsUsed'];

const manageUserQuota = async (req, res) => {
  try {
    const { userId } = req.params;
    const { counter, action, amount, reason } = req.body;

    if (!VALID_COUNTERS.includes(counter)) {
      return res.status(400).json({ error: `Invalid counter. Use: ${VALID_COUNTERS.join(', ')}` });
    }
    if (!['add', 'subtract'].includes(action)) {
      return res.status(400).json({ error: 'Action must be "add" or "subtract"' });
    }
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Valid positive amount required' });
    }

    const user = await User.findOne({ userId: parseInt(userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const inc = action === 'subtract' ? -amount : amount;

    // Get current value first to enforce minimum 0
    const current = await UserUsageTracker.getCount(user._id, counter);
    const newValue = Math.max(0, current + inc);
    const actualInc = newValue - current;

    if (actualInc !== 0) {
      await UserUsageTracker.increment(user._id, counter, actualInc);
    }

    res.json({
      counter,
      previousValue: current,
      newValue,
      action,
      amount,
      reason: reason || '',
    });
  } catch (error) {
    console.error('[admin] manageUserQuota error:', error.message);
    res.status(500).json({ error: 'Failed to manage user quota' });
  }
};

// ─── Manage org quota (UsageTracker) ────────────────────────

const manageOrgQuota = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { counter, period, action, amount, reason } = req.body;

    if (!VALID_COUNTERS.includes(counter)) {
      return res.status(400).json({ error: `Invalid counter. Use: ${VALID_COUNTERS.join(', ')}` });
    }
    if (!period || (!/^\d{4}-\d{2}$/.test(period) && period !== 'lifetime')) {
      return res.status(400).json({ error: 'Period must be "YYYY-MM" or "lifetime"' });
    }
    if (!['add', 'subtract'].includes(action)) {
      return res.status(400).json({ error: 'Action must be "add" or "subtract"' });
    }
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Valid positive amount required' });
    }

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const inc = action === 'subtract' ? -amount : amount;

    // Get current value to enforce minimum 0
    const current = await UsageTracker.getCount(orgId, counter, period);
    const newValue = Math.max(0, current + inc);
    const actualInc = newValue - current;

    if (actualInc !== 0) {
      await UsageTracker.increment(orgId, counter, period, actualInc);
    }

    res.json({
      counter,
      period,
      previousValue: current,
      newValue,
      action,
      amount,
      reason: reason || '',
    });
  } catch (error) {
    console.error('[admin] manageOrgQuota error:', error.message);
    res.status(500).json({ error: 'Failed to manage org quota' });
  }
};

// ─── Reset org to free plan (refund scenario) ───────────────

const resetOrgToFree = async (req, res) => {
  try {
    const { orgId } = req.params;

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const oldSub = await Subscription.findOne({ organizationId: orgId }).lean();
    const oldPlanId = oldSub?.planId || 'free';

    if (oldPlanId === 'free') {
      return res.status(400).json({ error: 'Organization is already on free plan' });
    }

    const summary = { oldPlanId, stripeCanceled: false, creditsExpired: 0, usageReset: false };

    // 1. Cancel Stripe subscription immediately
    if (oldSub?.stripeSubscriptionId) {
      try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(oldSub.stripeSubscriptionId);
        summary.stripeCanceled = true;
        console.log(`[admin] Stripe subscription ${oldSub.stripeSubscriptionId} canceled for org ${orgId} (reset to free)`);
      } catch (err) {
        console.warn(`[admin] Failed to cancel Stripe subscription ${oldSub.stripeSubscriptionId}: ${err.message}`);
      }
    }

    // 2. Expire all subscription credits
    const expireResult = await creditService.expireSubscriptionCredits(orgId);
    summary.creditsExpired = expireResult?.expired || 0;

    // 3. Reset monthly usage counters (org has no free tier, so stale counters
    //    would only block the user when they re-subscribe to a new paid plan)
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await UsageTracker.deleteMany({ organizationId: orgId, period: currentPeriod });
    summary.usageReset = true;

    // 4. Update subscription record to free
    //    Keep stripeSubscriptionId and period dates as audit trail — only change plan/status
    const sub = await Subscription.findOne({ organizationId: orgId });
    if (sub) {
      sub.planId = 'free';
      sub.status = 'canceled';
      sub.canceledAt = new Date();
      sub.cancelAtPeriodEnd = false;
      await sub.save();
    }

    // 5. Log the reset
    await CreditTransaction.logTransaction({
      orgId,
      userId: null,
      type: 'adjustment',
      amount: 0,
      pool: 'subscription',
      description: `Admin reset to free: ${oldPlanId} → free`,
      metadata: {
        adminEmail: req.user?.email,
        oldPlanId,
        stripeCanceled: summary.stripeCanceled,
        creditsExpired: summary.creditsExpired,
        usageReset: summary.usageReset,
      },
      balanceAfter: 0,
    });

    console.log(`[admin] Org ${orgId} reset to free from ${oldPlanId} by ${req.user?.email}`, summary);

    res.json({ success: true, summary });
  } catch (error) {
    console.error('[admin] resetOrgToFree error:', error.message);
    res.status(500).json({ error: 'Failed to reset org to free plan' });
  }
};

// ─── Arbitrary plan override (DB only, no billing effect) ────

const VALID_PLAN_IDS = [
  'free',
  'standard-monthly', 'standard-yearly',
  'professional-monthly', 'professional-yearly',
  'agency-monthly', 'agency-yearly',
];

const overrideOrgPlan = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { planId } = req.body;

    if (!VALID_PLAN_IDS.includes(planId)) {
      return res.status(400).json({ error: `Invalid planId. Use: ${VALID_PLAN_IDS.join(', ')}` });
    }

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Only change planId in subscription record — nothing else is touched.
    // Stripe, credits, usage, billing period all stay exactly as they are.
    let sub = await Subscription.findOne({ organizationId: orgId });
    const oldPlanId = sub?.planId || 'free';

    if (sub) {
      sub.planId = planId;
      if (planId === 'free') {
        // Orgs have no free tier — mark as canceled so it doesn't appear active.
        sub.status = 'canceled';
        sub.canceledAt = new Date();
        sub.cancelAtPeriodEnd = false;
      } else {
        // Ensure the subscription is active so the paid plan is actually usable.
        sub.status = 'active';
      }
      await sub.save();
    } else {
      sub = await Subscription.create({
        organizationId: orgId,
        userId: org.ownerId,
        planId,
        status: planId === 'free' ? 'canceled' : 'active',
      });
    }

    console.log(`[admin] Arbitrary plan override for org ${orgId}: ${oldPlanId} → ${planId} by ${req.user?.email}`);

    res.json({
      success: true,
      oldPlanId,
      newPlanId: planId,
      subscription: {
        id: sub._id,
        planId: sub.planId,
        plan: sub.planId?.split('-')[0] || 'free',
        status: sub.status,
      },
    });
  } catch (error) {
    console.error('[admin] overrideOrgPlan error:', error.message);
    res.status(500).json({ error: 'Failed to override org plan' });
  }
};

// ─── Subscription stats ─────────────────────────────────────

const PLAN_MONTHLY_PRICES = {
  standard: 29,
  professional: 79,
  pro: 79, // legacy alias
  agency: 199,
};

const getSubscriptionStats = async (req, res) => {
  try {
    const subscriptions = await Subscription.find().select('planId status').lean();

    let activeCount = 0;
    let pastDueCount = 0;
    let canceledCount = 0;
    let trialingCount = 0;
    let monthlyRevenue = 0;
    const planDistribution = {};

    for (const sub of subscriptions) {
      if (sub.status === 'active') activeCount++;
      else if (sub.status === 'past_due') pastDueCount++;
      else if (sub.status === 'canceled') canceledCount++;
      else if (sub.status === 'trialing') trialingCount++;

      // Plan distribution (only non-free)
      if (sub.planId && sub.planId !== 'free') {
        planDistribution[sub.planId] = (planDistribution[sub.planId] || 0) + 1;
      }

      // MRR from active/trialing subs
      if (sub.status === 'active' || sub.status === 'trialing') {
        const tier = sub.planId?.split('-')[0];
        const billing = sub.planId?.split('-')[1];
        const base = PLAN_MONTHLY_PRICES[tier] || 0;
        // Yearly plans: annual price = monthly×10, so MRR = annual/12
        monthlyRevenue += billing === 'yearly' ? Math.round((base * 10) / 12) : base;
      }
    }

    res.json({
      activeCount,
      pastDueCount,
      canceledCount,
      trialingCount,
      monthlyRevenue,
      planDistribution,
    });
  } catch (error) {
    console.error('[admin] getSubscriptionStats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscription stats' });
  }
};

// ─── Credit stats & listings ────────────────────────────────

const getCreditStats = async (req, res) => {
  try {
    // Account-level stats (UserCredit)
    const userCredits = await UserCredit.find({ freeCredits: { $gt: 0 } }).lean();
    const totalFreeCredits = userCredits.reduce((sum, uc) => sum + uc.freeCredits, 0);
    const usersWithCredits = userCredits.length;
    const avgCreditsPerUser = usersWithCredits ? Math.round(totalFreeCredits / usersWithCredits) : 0;

    // Org-level stats (Credit)
    const orgCredits = await Credit.find().lean();
    let totalSubscriptionCredits = 0;
    let totalGeneralCredits = 0;
    let orgsWithCredits = 0;
    for (const c of orgCredits) {
      totalSubscriptionCredits += c.subscriptionCredits || 0;
      totalGeneralCredits += c.generalCredits || 0;
      if ((c.subscriptionCredits || 0) + (c.generalCredits || 0) > 0) orgsWithCredits++;
    }
    const totalOrgCredits = totalSubscriptionCredits + totalGeneralCredits;
    const avgCreditsPerOrg = orgsWithCredits ? Math.round(totalOrgCredits / orgsWithCredits) : 0;

    // Recent transactions (last 10)
    const recentTxs = await CreditTransaction.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const enrichedTxs = await Promise.all(
      recentTxs.map(async (tx) => {
        const org = tx.organizationId
          ? await Organization.findById(tx.organizationId).select('name').lean()
          : null;
        const user = tx.userId
          ? await User.findById(tx.userId).select('email').lean()
          : null;
        return {
          id: tx._id,
          type: tx.type,
          amount: tx.amount,
          pool: tx.pool,
          description: tx.description,
          balanceAfter: tx.balanceAfter,
          status: tx.status,
          organizationName: org?.name || null,
          userEmail: user?.email || null,
          createdAt: tx.createdAt,
        };
      })
    );

    res.json({
      account: { totalFreeCredits, usersWithCredits, avgCreditsPerUser },
      organization: {
        totalSubscriptionCredits,
        totalGeneralCredits,
        totalCredits: totalOrgCredits,
        orgsWithCredits,
        avgCreditsPerOrg,
      },
      recentTransactions: enrichedTxs,
    });
  } catch (error) {
    console.error('[admin] getCreditStats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch credit stats' });
  }
};

const getCreditAccounts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'freeCredits';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    // Find users (optionally filtered by search)
    const userFilter = {};
    if (search) {
      userFilter.$or = [
        { email: { $regex: search, $options: 'i' } },
        { 'profile.name': { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(userFilter)
      .select('userId email profile status createdAt')
      .lean();

    // Bulk fetch user credits
    const userIds = users.map((u) => u._id);
    const credits = await UserCredit.find({ userId: { $in: userIds } }).lean();
    const creditMap = {};
    for (const c of credits) creditMap[c.userId.toString()] = c;

    // Merge and sort
    let merged = users.map((u) => {
      const uc = creditMap[u._id.toString()];
      return {
        userId: u.userId,
        objId: u._id,
        email: u.email,
        nickname: u.profile?.name || 'N/A',
        status: u.status,
        freeCredits: uc?.freeCredits || 0,
        grantedAt: uc?.grantedAt || null,
        createdAt: u.createdAt,
      };
    });

    // Sort
    const sortKey = ['freeCredits', 'email', 'createdAt'].includes(sortBy) ? sortBy : 'freeCredits';
    merged.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return sortOrder * av.localeCompare(bv);
      return sortOrder * (av - bv);
    });

    const total = merged.length;
    merged = merged.slice((page - 1) * limit, page * limit);

    res.json({
      users: merged,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[admin] getCreditAccounts error:', error.message);
    res.status(500).json({ error: 'Failed to fetch credit accounts' });
  }
};

const getCreditOrganizations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'total';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    const orgFilter = {};
    if (search) {
      orgFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ];
    }

    const orgs = await Organization.find(orgFilter)
      .select('name slug ownerId createdAt')
      .lean();

    const orgIds = orgs.map((o) => o._id);
    const ownerIds = [...new Set(orgs.map((o) => o.ownerId?.toString()).filter(Boolean))];

    const [credits, subs, owners] = await Promise.all([
      Credit.find({ organizationId: { $in: orgIds } }).lean(),
      Subscription.find({
        organizationId: { $in: orgIds },
        status: { $in: ['active', 'trialing'] },
      }).select('organizationId planId').lean(),
      User.find({ _id: { $in: ownerIds } }).select('email').lean(),
    ]);

    const creditMap = {};
    for (const c of credits) creditMap[c.organizationId.toString()] = c;
    const subMap = {};
    for (const s of subs) subMap[s.organizationId.toString()] = s;
    const ownerMap = {};
    for (const o of owners) ownerMap[o._id.toString()] = o;

    let merged = orgs.map((org) => {
      const c = creditMap[org._id.toString()];
      const s = subMap[org._id.toString()];
      const owner = org.ownerId ? ownerMap[org.ownerId.toString()] : null;
      const subCredits = c?.subscriptionCredits || 0;
      const genCredits = c?.generalCredits || 0;
      return {
        orgId: org._id,
        name: org.name,
        slug: org.slug,
        plan: s?.planId?.split('-')[0] || 'none',
        planId: s?.planId || null,
        owner: owner?.email || 'Unknown',
        subscriptionCredits: subCredits,
        generalCredits: genCredits,
        total: subCredits + genCredits,
        subscriptionCreditsExpireAt: c?.subscriptionCreditsExpireAt || null,
        lastResetAt: c?.lastResetAt || null,
        createdAt: org.createdAt,
      };
    });

    // Sort
    const sortKey = ['total', 'subscriptionCredits', 'generalCredits', 'name', 'createdAt'].includes(sortBy)
      ? sortBy
      : 'total';
    merged.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return sortOrder * av.localeCompare(bv);
      return sortOrder * (av - bv);
    });

    const total = merged.length;
    merged = merged.slice((page - 1) * limit, page * limit);

    res.json({
      organizations: merged,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[admin] getCreditOrganizations error:', error.message);
    res.status(500).json({ error: 'Failed to fetch credit organizations' });
  }
};

const bulkManageCredits = async (req, res) => {
  try {
    const { targetType, targets, operation, amount, pool, reason } = req.body;

    if (!['user', 'organization'].includes(targetType)) {
      return res.status(400).json({ error: 'targetType must be "user" or "organization"' });
    }
    if (!Array.isArray(targets) || !targets.length) {
      return res.status(400).json({ error: 'targets must be a non-empty array' });
    }
    if (targets.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 targets per bulk operation' });
    }
    if (!['add', 'subtract', 'set'].includes(operation)) {
      return res.status(400).json({ error: 'operation must be "add", "subtract", or "set"' });
    }
    if (amount == null || isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }
    if (targetType === 'organization' && !['subscription', 'general'].includes(pool)) {
      return res.status(400).json({ error: 'pool must be "subscription" or "general" for organizations' });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const targetId of targets) {
      try {
        if (targetType === 'user') {
          // Find user by numeric userId
          const user = await User.findOne({ userId: parseInt(targetId) });
          if (!user) { results.push({ targetId, success: false, error: 'User not found' }); failed++; continue; }
          const uc = await UserCredit.getOrCreateForUser(user._id);
          const prev = uc.freeCredits;
          if (operation === 'add') uc.freeCredits += amount;
          else if (operation === 'subtract') uc.freeCredits = Math.max(0, uc.freeCredits - amount);
          else if (operation === 'set') uc.freeCredits = amount;
          await uc.save();
          await CreditTransaction.logTransaction({
            orgId: null, userId: user._id,
            type: operation === 'subtract' ? 'adjustment' : 'general_grant',
            amount: operation === 'subtract' ? -amount : amount,
            pool: 'user_free',
            description: reason || `Bulk ${operation}: ${amount} credits`,
            balanceAfter: uc.freeCredits,
            metadata: { adminEmail: req.user?.email, bulk: true },
          });
          results.push({ targetId, success: true, previousBalance: prev, newBalance: uc.freeCredits });
          succeeded++;
        } else {
          // Organization
          const org = await Organization.findById(targetId);
          if (!org) { results.push({ targetId, success: false, error: 'Organization not found' }); failed++; continue; }
          const credit = await Credit.getOrCreateForOrg(targetId);
          const field = pool === 'subscription' ? 'subscriptionCredits' : 'generalCredits';
          const prev = credit[field];
          if (operation === 'add') credit[field] += amount;
          else if (operation === 'subtract') credit[field] = Math.max(0, credit[field] - amount);
          else if (operation === 'set') credit[field] = amount;
          if (operation !== 'subtract') credit.lowBalanceNotifiedAt = null; // re-arm credits_low
          await credit.save();
          await CreditTransaction.logTransaction({
            orgId: targetId, userId: null,
            type: operation === 'subtract' ? 'adjustment' : 'general_grant',
            amount: operation === 'subtract' ? -amount : amount,
            pool,
            description: reason || `Bulk ${operation}: ${amount} ${pool} credits`,
            balanceAfter: credit[field],
            metadata: { adminEmail: req.user?.email, bulk: true },
          });
          results.push({ targetId, success: true, previousBalance: prev, newBalance: credit[field] });
          succeeded++;
        }
      } catch (err) {
        results.push({ targetId, success: false, error: err.message });
        failed++;
      }
    }

    res.json({ processed: targets.length, succeeded, failed, results });
  } catch (error) {
    console.error('[admin] bulkManageCredits error:', error.message);
    res.status(500).json({ error: 'Failed to process bulk credits' });
  }
};

const exportCreditTransactions = async (req, res) => {
  try {
    const { startDate, endDate, type, pool } = req.query;

    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate + 'T23:59:59.999Z');
    }
    if (type && type !== 'all') filter.type = type;
    if (pool && pool !== 'all') filter.pool = pool;

    const transactions = await CreditTransaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();

    // Enrich with org/user names
    const orgIds = [...new Set(transactions.map((t) => t.organizationId?.toString()).filter(Boolean))];
    const userIds = [...new Set(transactions.map((t) => t.userId?.toString()).filter(Boolean))];
    const [orgs, users] = await Promise.all([
      Organization.find({ _id: { $in: orgIds } }).select('name').lean(),
      User.find({ _id: { $in: userIds } }).select('email').lean(),
    ]);
    const orgMap = {};
    for (const o of orgs) orgMap[o._id.toString()] = o.name;
    const userMap = {};
    for (const u of users) userMap[u._id.toString()] = u.email;

    // Build CSV
    const header = 'Date,Transaction ID,Organization,User,Type,Amount,Pool,Balance After,Description,Status';
    const escCsv = (val) => {
      const s = String(val ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = transactions.map((tx) =>
      [
        tx.createdAt ? new Date(tx.createdAt).toISOString() : '',
        tx._id,
        escCsv(orgMap[tx.organizationId?.toString()] || ''),
        escCsv(userMap[tx.userId?.toString()] || ''),
        tx.type,
        tx.amount,
        tx.pool,
        tx.balanceAfter ?? '',
        escCsv(tx.description),
        tx.status,
      ].join(',')
    );

    const csv = [header, ...rows].join('\n');
    const filename = `credit-transactions-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (error) {
    console.error('[admin] exportCreditTransactions error:', error.message);
    res.status(500).json({ error: 'Failed to export transactions' });
  }
};

// ─── Cascade delete helpers ─────────────────────────────────

/**
 * Delete all workspace-dependent data for the given workspace IDs,
 * then delete the workspaces themselves.
 */
async function cascadeDeleteWorkspaces(workspaceIds) {
  if (!workspaceIds.length) return { workspaces: 0 };

  // Find all AI trackers in these workspaces
  const trackers = await AiTracker.find({ workspaceId: { $in: workspaceIds } }).select('_id').lean();
  const trackerIds = trackers.map((t) => t._id);

  // Delete tracker sub-documents
  if (trackerIds.length) {
    await Promise.all([
      AiTrackerCompetitor.deleteMany({ trackerId: { $in: trackerIds } }),
      AiTrackerPrompt.deleteMany({ trackerId: { $in: trackerIds } }),
      AiTrackerScan.deleteMany({ trackerId: { $in: trackerIds } }),
    ]);
  }

  // Delete workspace-level data
  await Promise.all([
    AiTracker.deleteMany({ workspaceId: { $in: workspaceIds } }),
    Content.deleteMany({ workspaceId: { $in: workspaceIds } }),
    AgentUsageLog.deleteMany({ workspaceId: { $in: workspaceIds } }),
    KeywordResearchHistory.deleteMany({ workspaceId: { $in: workspaceIds } }),
    Site.deleteMany({ workspaceId: { $in: workspaceIds } }),
  ]);

  const wsResult = await Workspace.deleteMany({ _id: { $in: workspaceIds } });
  return { workspaces: wsResult.deletedCount };
}

/**
 * Cascade-delete an organization and all its data.
 * Cancels Stripe subscription immediately if one exists.
 * Returns deletion counts.
 */
async function cascadeDeleteOrganization(orgId) {
  const counts = { stripeSubscriptionCanceled: false, workspaces: 0, members: 0 };

  // Cancel Stripe subscription immediately
  const sub = await Subscription.findOne({ organizationId: orgId }).lean();
  if (sub?.stripeSubscriptionId) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      counts.stripeSubscriptionCanceled = true;
      console.log(`[admin] Stripe subscription ${sub.stripeSubscriptionId} canceled for org ${orgId}`);
    } catch (err) {
      console.warn(`[admin] Failed to cancel Stripe subscription ${sub.stripeSubscriptionId}: ${err.message}`);
    }
  }

  // Cascade-delete workspaces
  const workspaces = await Workspace.find({ organizationId: orgId }).select('_id').lean();
  const wsIds = workspaces.map((w) => w._id);
  const wsResult = await cascadeDeleteWorkspaces(wsIds);
  counts.workspaces = wsResult.workspaces;

  // Delete org-level data
  const [membersResult] = await Promise.all([
    OrgMember.deleteMany({ organizationId: orgId }),
    Subscription.deleteMany({ organizationId: orgId }),
    Credit.deleteMany({ organizationId: orgId }),
    CreditTransaction.deleteMany({ organizationId: orgId }),
    UsageTracker.deleteMany({ organizationId: orgId }),
    Site.deleteMany({ organizationId: orgId }),
  ]);
  counts.members = membersResult.deletedCount;

  await Organization.deleteOne({ _id: orgId });
  return counts;
}

// ─── Admin delete organization ──────────────────────────────

const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    const user = await User.findOne({ userId: parseInt(userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const VALID_STATUSES = ['active', 'suspended', 'deleted'];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    if (status) user.status = status;

    await user.save();
    console.log(`[admin] Updated user "${user.email}" (userId=${userId}) status=${status} by admin ${req.user.email}`);

    res.json({ success: true, user: { userId: user.userId, email: user.email, status: user.status } });
  } catch (error) {
    console.error('[admin] updateUser error:', error.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

const adminDeleteOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    console.log(`[admin] Deleting organization "${org.name}" (${orgId}) by admin ${req.user.email}`);
    const deleted = await cascadeDeleteOrganization(orgId);

    res.json({ success: true, deleted });
  } catch (error) {
    console.error('[admin] adminDeleteOrganization error:', error.message);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
};

// ─── Admin delete user ──────────────────────────────────────

const adminDeleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findOne({ userId: parseInt(userId) }).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    console.log(`[admin] Deleting user "${user.email}" (userId=${userId}) by admin ${req.user.email}`);

    const deleted = { ownedOrgs: 0, memberships: 0, workspaces: 0, stripeCanceled: 0 };

    // 1. Cascade-delete all organizations the user OWNS
    const ownedOrgs = await Organization.find({ ownerId: user._id }).select('_id').lean();
    for (const org of ownedOrgs) {
      const orgCounts = await cascadeDeleteOrganization(org._id);
      deleted.ownedOrgs++;
      deleted.workspaces += orgCounts.workspaces;
      if (orgCounts.stripeSubscriptionCanceled) deleted.stripeCanceled++;
    }

    // 2. Remove memberships from non-owned orgs
    const membershipResult = await OrgMember.deleteMany({ userId: user._id });
    deleted.memberships = membershipResult.deletedCount;

    // 3. Delete orphan workspaces (owned by user, no org — shouldn't normally exist)
    const orphanWs = await Workspace.find({ userId: user._id }).select('_id').lean();
    if (orphanWs.length) {
      const wsResult = await cascadeDeleteWorkspaces(orphanWs.map((w) => w._id));
      deleted.workspaces += wsResult.workspaces;
    }

    // 4. Delete remaining user-owned content
    await Content.deleteMany({ userId: user._id });

    // 5. Delete user-level data
    await Promise.all([
      UserCredit.deleteMany({ userId: user._id }),
      UserUsageTracker.deleteMany({ userId: user._id }),
      Session.deleteMany({ userId: user._id }),
      ResetToken.deleteMany({ userId: user._id }),
      BrandVoiceTestLog.deleteMany({ userId: user._id }),
      Avatar.deleteMany({ createdBy: user._id }),
      BrandVoice.deleteMany({ createdBy: user._id }),
    ]);

    // 6. Delete the user document
    await User.deleteOne({ _id: user._id });

    res.json({ success: true, deleted });
  } catch (error) {
    console.error('[admin] adminDeleteUser error:', error.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

module.exports = {
  userLookup,
  getDashboardStats,
  getUsers,
  getSubscriptions,
  getSubscriptionStats,
  manageUserCredits,
  getOrganizations,
  getOrganizationDetail,
  updateOrganization,
  manageOrgCredits,
  updateSubscription,
  getUserDetail,
  manageUserQuota,
  manageOrgQuota,
  resetOrgToFree,
  overrideOrgPlan,
  updateUser,
  adminDeleteOrganization,
  adminDeleteUser,
  getCreditStats,
  getCreditAccounts,
  getCreditOrganizations,
  bulkManageCredits,
  exportCreditTransactions,
};
