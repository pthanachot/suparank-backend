const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const Credit = require('../models/Credit');
const CreditTransaction = require('../models/CreditTransaction');

/**
 * Resolve orgId from query param or authenticated user's personal org.
 */
async function _resolveAndAuthorize(req, res) {
  let orgId = req.query.orgId;

  if (!orgId) {
    const personalOrg = await Organization.findOne({
      ownerId: req.user.userId,
      isPersonal: true,
    })
      .select('_id')
      .lean();
    orgId = personalOrg?._id;
  }

  if (!orgId) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }

  // Verify access: owner or member
  const org = await Organization.findById(orgId).lean();
  if (!org) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }

  const isOwner = org.ownerId.equals(req.user.userId);
  if (!isOwner) {
    const membership = await OrgMember.findOne({
      organizationId: orgId,
      userId: req.user.userId,
    }).lean();
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this organization' });
      return null;
    }
  }

  return orgId;
}

/**
 * GET /api/org/credits?orgId=...
 * Returns credit balance + last 20 transactions.
 */
const getCredits = async (req, res) => {
  try {
    const orgId = await _resolveAndAuthorize(req, res);
    if (!orgId) return;

    const creditDoc = await Credit.findOne({ organizationId: orgId }).lean();

    const balance = {
      subscription: creditDoc?.subscriptionCredits || 0,
      general: creditDoc?.generalCredits || 0,
      total: (creditDoc?.subscriptionCredits || 0) + (creditDoc?.generalCredits || 0),
      expiresAt: creditDoc?.subscriptionCreditsExpireAt || null,
    };

    const recentTransactions = await CreditTransaction.find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.json({ balance, transactions: recentTransactions });
  } catch (err) {
    console.error('getCredits error:', err.message);
    res.status(500).json({ error: 'Failed to get credits' });
  }
};

/**
 * GET /api/org/credits/history?orgId=...&page=1&limit=20
 * Returns paginated credit transactions.
 */
const getCreditHistory = async (req, res) => {
  try {
    const orgId = await _resolveAndAuthorize(req, res);
    if (!orgId) return;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      CreditTransaction.find({ organizationId: orgId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CreditTransaction.countDocuments({ organizationId: orgId }),
    ]);

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('getCreditHistory error:', err.message);
    res.status(500).json({ error: 'Failed to get credit history' });
  }
};

module.exports = { getCredits, getCreditHistory };
