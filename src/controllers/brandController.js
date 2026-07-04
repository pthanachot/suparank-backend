/**
 * White-label brand endpoints (Phase 5).
 *
 *   GET  /api/org/organizations/:orgId/brand        any org member (display)
 *   PUT  /api/org/organizations/:orgId/brand        owner/admin + entitlement
 *   GET  /api/tenant/brand?host=                    public (pre-auth branding)
 *   GET  /api/admin/brand-configs                   platform admin
 *   PUT  /api/admin/brand-configs/:orgId            platform admin override
 */

const BrandConfig = require('../models/BrandConfig');
const Organization = require('../models/Organization');
const brandService = require('../services/brandService');
const auditService = require('../services/auditService');
const { resolveOrgWithAccess } = require('./orgMemberController');

// ─── GET ORG BRAND ───────────────────────────────────────────────

const getOrgBrand = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res);
    if (!result) return;
    const { org, callerRole } = result;

    const { brand, entitled, hasConfig, config } = await brandService.getBrandForOrg(org._id);

    const payload = { brand, entitled };
    // Raw override values (for the settings form) are management data
    if (callerRole === 'owner' || callerRole === 'admin') {
      payload.hasConfig = hasConfig;
      payload.config = config;
    }
    res.json(payload);
  } catch (error) {
    console.error('Get org brand error:', error);
    res.status(500).json({ error: 'Failed to load brand settings' });
  }
};

// ─── UPDATE ORG BRAND ────────────────────────────────────────────

const updateOrgBrand = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole, accessScope } = result;

    // Scoped admins manage their assigned workspaces, not org identity
    if (accessScope === 'assigned' && callerRole !== 'owner') {
      return res.status(403).json({ error: 'You do not have access to brand settings' });
    }

    if (!(await brandService.isWhiteLabelEntitled(org._id))) {
      return res.status(403).json({
        error: 'White-label branding requires the Agency plan',
        code: 'UPGRADE_REQUIRED',
      });
    }

    const validated = brandService.validateBrandPatch(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    // Phase 10 legal invariant, enforced at the WRITE site: while any
    // domain is live (active/pending_ssl), the org cannot clear its legal
    // URLs — a tenant login page must always link the agency's own pages.
    if (validated.patch.termsUrl === '' || validated.patch.privacyUrl === '') {
      const Domain = require('../models/Domain');
      const liveDomain = await Domain.exists({
        organizationId: org._id,
        status: { $in: ['active', 'pending_ssl'] },
      });
      if (liveDomain) {
        return res.status(400).json({
          error:
            'Terms of Service and Privacy Policy URLs are required while a custom domain is connected. Remove the domain first.',
        });
      }
    }

    const doc = await brandService.updateBrand(org._id, validated.patch);
    const { brand } = await brandService.getBrandForOrg(org._id);

    auditService.record({
      organizationId: org._id,
      userId: req.user.userId,
      actorEmail: req.user.email,
      action: 'brand.update',
      resourceId: org._id,
      meta: { changed: Object.keys(validated.patch) },
      ip: req.ip,
    });

    res.json({ brand, config: doc, entitled: true });
  } catch (error) {
    console.error('Update org brand error:', error);
    res.status(500).json({ error: 'Failed to update brand settings' });
  }
};

// ─── PUBLIC TENANT BRAND (pre-auth) ──────────────────────────────
// The login page must render the tenant's brand before anyone is
// authenticated. Display fields only. Hosts resolve through the Phase 8
// Domain model (active custom domains); unknown hosts → platform brand.

const getTenantBrand = async (req, res) => {
  try {
    const host = String(req.query.host || req.headers.host || '');
    const brand = await brandService.resolveBrandByHost(host);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ brand });
  } catch (error) {
    console.error('Tenant brand error:', error);
    res.status(500).json({ error: 'Failed to resolve brand' });
  }
};

// GET /api/tenant/resolve?host= — brand PLUS the resolved orgId, which the
// frontend needs to pin the session to the tenant org on custom domains.
// orgId is display-safe (it's in every org-scoped URL already).

const resolveTenant = async (req, res) => {
  try {
    const host = String(req.query.host || req.headers.host || '');
    const domainService = require('../services/domainService');
    const orgId = await domainService.resolveOrgByHost(host);
    const brand = orgId
      ? (await brandService.getBrandForOrg(orgId)).brand
      : await brandService.getPlatformBrand();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ orgId: orgId ? String(orgId) : null, brand });
  } catch (error) {
    console.error('Tenant resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve tenant' });
  }
};

// ─── ADMIN: LIST + OVERRIDE ──────────────────────────────────────

const adminListBrandConfigs = async (req, res) => {
  try {
    const configs = await BrandConfig.find({}).sort({ updatedAt: -1 }).lean();
    const orgIds = configs.map((c) => c.organizationId).filter(Boolean);
    const orgs = await Organization.find({ _id: { $in: orgIds } })
      .select('name slug ownerId')
      .lean();
    const orgMap = Object.fromEntries(orgs.map((o) => [o._id.toString(), o]));
    res.json({
      configs: configs.map((c) => ({
        ...c,
        organization: c.organizationId ? orgMap[c.organizationId.toString()] || null : null,
        isPlatformDefault: c.scopeKey === 'platform',
      })),
    });
  } catch (error) {
    console.error('Admin list brand configs error:', error);
    res.status(500).json({ error: 'Failed to list brand configs' });
  }
};

// PUT /api/admin/brand-configs/:orgId  ('platform' as orgId edits the
// platform-default brand). No entitlement check — this is the operator.
const adminUpdateBrandConfig = async (req, res) => {
  try {
    const { orgId } = req.params;
    let organizationId = null;
    if (orgId !== 'platform') {
      const org = await Organization.findById(orgId).select('_id').lean();
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      organizationId = org._id;
    }

    const validated = brandService.validateBrandPatch(req.body);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const doc = await brandService.updateBrand(organizationId, validated.patch);

    if (organizationId) {
      auditService.record({
        organizationId,
        userId: req.user.userId,
        actorEmail: req.user.email,
        action: 'brand.update',
        resourceId: organizationId,
        meta: { changed: Object.keys(validated.patch), byPlatformAdmin: true },
        ip: req.ip,
      });
    }

    res.json({ config: doc });
  } catch (error) {
    console.error('Admin update brand config error:', error);
    res.status(500).json({ error: 'Failed to update brand config' });
  }
};

module.exports = {
  getOrgBrand,
  updateOrgBrand,
  getTenantBrand,
  resolveTenant,
  adminListBrandConfigs,
  adminUpdateBrandConfig,
};
