/**
 * Tenant custom-domain endpoints (Phase 8).
 *
 *   GET    /api/org/organizations/:orgId/domains                    owner/admin
 *   POST   /api/org/organizations/:orgId/domains                    owner/admin + entitlement
 *   POST   /api/org/organizations/:orgId/domains/:domainId/verify   owner/admin
 *   PUT    /api/org/organizations/:orgId/domains/:domainId/primary  owner/admin
 *   DELETE /api/org/organizations/:orgId/domains/:domainId          owner/admin
 *
 * Every :domainId lookup is scoped by organizationId — a valid ObjectId
 * belonging to another org 404s, never leaks.
 */

const Domain = require('../models/Domain');
const domainService = require('../services/domainService');
const cloudflareService = require('../services/cloudflareService');
const brandService = require('../services/brandService');
const auditService = require('../services/auditService');
const { resolveOrgWithAccess } = require('./orgMemberController');

/** Owner/admin gate; scoped admins manage workspaces, not org identity. */
async function _resolveDomainAccess(req, res) {
  const result = await resolveOrgWithAccess(req, res, true);
  if (!result) return null;
  if (result.accessScope === 'assigned' && result.callerRole !== 'owner') {
    res.status(403).json({ error: 'You do not have access to domain settings' });
    return null;
  }
  return result;
}

/** Response shape for a domain (includes the DNS records to publish). */
function _serialize(domain) {
  const d = domain.toObject ? domain.toObject() : domain;
  return {
    _id: d._id,
    hostname: d.hostname,
    status: d.status,
    statusDetail: d.statusDetail || '',
    isPrimary: Boolean(d.isPrimary),
    lastCheckedAt: d.lastCheckedAt || null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    instructions: domainService.dnsInstructions(d),
  };
}

/** Audit shorthand mirroring orgMemberController.auditOrg. */
function _audit(req, org, action, resourceId, meta) {
  auditService.record({
    organizationId: org._id,
    userId: req.user.userId,
    actorEmail: req.user.email,
    impersonatedBy: req.user?.impersonatedBy || null,
    action,
    resourceId,
    meta,
    ip: req.ip,
  });
}

// ─── LIST ────────────────────────────────────────────────────────

const listDomains = async (req, res) => {
  try {
    const result = await _resolveDomainAccess(req, res);
    if (!result) return;
    const { org } = result;

    const domains = await Domain.find({ organizationId: org._id })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      domains: domains.map(_serialize),
      cloudflareConfigured: cloudflareService.isConfigured(),
    });
  } catch (error) {
    console.error('List domains error:', error);
    res.status(500).json({ error: 'Failed to load domains' });
  }
};

// ─── ADD ─────────────────────────────────────────────────────────

const addDomain = async (req, res) => {
  try {
    const result = await _resolveDomainAccess(req, res);
    if (!result) return;
    const { org } = result;

    if (!(await brandService.isWhiteLabelEntitled(org._id))) {
      return res.status(403).json({
        error: 'Custom domains require the Agency plan',
        code: 'UPGRADE_REQUIRED',
      });
    }

    let domain;
    try {
      domain = await domainService.createDomain(org._id, req.body?.hostname);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    _audit(req, org, 'domain.add', domain._id, { hostname: domain.hostname });

    res.status(201).json({
      domain: _serialize(domain),
      instructions: domainService.dnsInstructions(domain),
    });
  } catch (error) {
    console.error('Add domain error:', error);
    res.status(500).json({ error: 'Failed to add domain' });
  }
};

// ─── VERIFY ──────────────────────────────────────────────────────

const verifyDomain = async (req, res) => {
  try {
    const result = await _resolveDomainAccess(req, res);
    if (!result) return;
    const { org } = result;

    const domain = await Domain.findOne({
      _id: req.params.domainId,
      organizationId: org._id,
    });
    if (!domain) return res.status(404).json({ error: 'Domain not found' });

    const wasActive = domain.status === 'active';
    const updated = await domainService.verifyDomain(domain._id);

    if (!wasActive && updated.status === 'active') {
      _audit(req, org, 'domain.verified', updated._id, { hostname: updated.hostname });
    }

    res.json({
      domain: _serialize(updated),
      instructions: domainService.dnsInstructions(updated),
    });
  } catch (error) {
    console.error('Verify domain error:', error);
    res.status(500).json({ error: 'Failed to verify domain' });
  }
};

// ─── SET PRIMARY ─────────────────────────────────────────────────

const setPrimaryDomain = async (req, res) => {
  try {
    const result = await _resolveDomainAccess(req, res);
    if (!result) return;
    const { org } = result;

    const domain = await Domain.findOne({
      _id: req.params.domainId,
      organizationId: org._id,
    });
    if (!domain) return res.status(404).json({ error: 'Domain not found' });

    await Domain.updateMany(
      { organizationId: org._id, _id: { $ne: domain._id } },
      { $set: { isPrimary: false } }
    );
    domain.isPrimary = true;
    await domain.save();
    domainService.clearDomainCache(); // resolveBaseUrl must see the change

    _audit(req, org, 'domain.set_primary', domain._id, { hostname: domain.hostname });

    res.json({ domain: _serialize(domain) });
  } catch (error) {
    console.error('Set primary domain error:', error);
    res.status(500).json({ error: 'Failed to set primary domain' });
  }
};

// ─── DELETE ──────────────────────────────────────────────────────

const deleteDomain = async (req, res) => {
  try {
    const result = await _resolveDomainAccess(req, res);
    if (!result) return;
    const { org } = result;

    const domain = await Domain.findOne({
      _id: req.params.domainId,
      organizationId: org._id,
    });
    if (!domain) return res.status(404).json({ error: 'Domain not found' });

    // Best-effort Cloudflare cleanup — a CF failure must not strand the doc
    if (domain.cloudflareId && cloudflareService.isConfigured()) {
      try {
        await cloudflareService.deleteCustomHostname(domain.cloudflareId);
      } catch (err) {
        console.error(
          `[domains] Cloudflare cleanup failed for ${domain.hostname}:`,
          err.message
        );
      }
    }

    await Domain.deleteOne({ _id: domain._id });
    domainService.clearDomainCache();
    brandService.clearBrandCache(org._id);

    _audit(req, org, 'domain.remove', domain._id, { hostname: domain.hostname });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete domain error:', error);
    res.status(500).json({ error: 'Failed to delete domain' });
  }
};

module.exports = {
  listDomains,
  addDomain,
  verifyDomain,
  setPrimaryDomain,
  deleteDomain,
};
