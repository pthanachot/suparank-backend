/**
 * Per-tenant email template endpoints (Phase 12).
 *
 *   GET    /api/org/organizations/:orgId/email-templates              list triggers + overrides
 *   PUT    /api/org/organizations/:orgId/email-templates/:triggerId   upsert tenant override
 *   DELETE /api/org/organizations/:orgId/email-templates/:triggerId   reset to default
 *
 * All owner/full-admin + white-label entitlement; routes additionally sit
 * behind the whiteLabelEmail launch flag (requireFeature).
 */

const TriggerableEmailTemplate = require('../models/TriggerableEmailTemplate');
const brandService = require('../services/brandService');
const auditService = require('../services/auditService');
const { resolveOrgWithAccess } = require('./orgMemberController');
const { SYSTEM_TRIGGERS, ORIGINAL_DEFAULT_TEMPLATES } = require('./emailPortalController');

// Platform-only triggers a tenant may not view or override.
const EXCLUDED_TRIGGERS = new Set(['feedback_submitted', 'contact_submitted']);

const MAX_SUBJECT_LENGTH = 200;
const MAX_HTML_LENGTH = 50000;

const _tenantTriggers = () => SYSTEM_TRIGGERS.filter((t) => !EXCLUDED_TRIGGERS.has(t.id));

/** Shared gate: owner or org-wide admin, entitled org. Writes the error response itself. */
async function _gate(req, res) {
  const result = await resolveOrgWithAccess(req, res, true);
  if (!result) return null;
  const { org, callerRole, accessScope } = result;
  if (accessScope === 'assigned' && callerRole !== 'owner') {
    res.status(403).json({ error: 'You do not have access to email settings' });
    return null;
  }
  if (!(await brandService.isWhiteLabelEntitled(org._id))) {
    res.status(403).json({
      error: 'White-label email requires the Agency plan',
      code: 'UPGRADE_REQUIRED',
    });
    return null;
  }
  return org;
}

function _audit(req, org, action, meta) {
  auditService.record({
    organizationId: org._id,
    userId: req.user.userId,
    actorEmail: req.user.email,
    impersonatedBy: req.user?.impersonatedBy || null,
    action,
    resourceId: org._id,
    meta,
    ip: req.ip,
  });
}

// ─── GET: all customizable triggers with tenant + default content ─

const listEmailTemplates = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const triggerIds = _tenantTriggers().map((t) => t.id);
    const rows = await TriggerableEmailTemplate.find({
      triggerId: { $in: triggerIds },
      $or: [
        { organizationId: org._id },
        { organizationId: null },
        { organizationId: { $exists: false } },
      ],
    }).lean();

    const tenantMap = {};
    const globalMap = {};
    for (const row of rows) {
      if (row.organizationId && String(row.organizationId) === String(org._id)) {
        tenantMap[row.triggerId] = row;
      } else {
        globalMap[row.triggerId] = row;
      }
    }

    const triggers = _tenantTriggers().map((def) => {
      const original = ORIGINAL_DEFAULT_TEMPLATES[def.id];
      const global = globalMap[def.id];
      const tenant = tenantMap[def.id];
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        variables: original?.variables || def.variables || [],
        hasTenantOverride: Boolean(tenant?.defaultSubject || tenant?.defaultHtml),
        tenantSubject: tenant?.defaultSubject || null,
        tenantHtml: tenant?.defaultHtml || null,
        // What the tenant would get without an override: global admin
        // override when set, else the hardcoded original.
        defaultSubject: global?.defaultSubject || original?.subject || '',
        defaultHtml: global?.defaultHtml || original?.html || '',
      };
    });

    res.json({ triggers });
  } catch (error) {
    console.error('List tenant email templates error:', error);
    res.status(500).json({ error: 'Failed to load email templates' });
  }
};

// ─── PUT: upsert the tenant override ─────────────────────────────

const updateEmailTemplate = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const { triggerId } = req.params;
    if (!_tenantTriggers().some((t) => t.id === triggerId)) {
      return res.status(404).json({ error: 'Unknown trigger' });
    }

    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    if (!subject || !html.trim()) {
      return res.status(400).json({ error: 'Subject and HTML are required' });
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      return res.status(400).json({ error: `Subject must be at most ${MAX_SUBJECT_LENGTH} characters` });
    }
    if (html.length > MAX_HTML_LENGTH) {
      return res.status(400).json({ error: `HTML must be at most ${MAX_HTML_LENGTH} characters` });
    }

    await TriggerableEmailTemplate.findOneAndUpdate(
      { triggerId, organizationId: org._id },
      { $set: { defaultSubject: subject, defaultHtml: html } },
      { upsert: true, new: true }
    );

    _audit(req, org, 'brand.email_template_update', { triggerId });
    // Return the full trigger row (list shape) — the settings editor merges
    // it back into its list to refresh the 'Customized' state.
    const meta = _tenantTriggers().find((t) => t.id === triggerId);
    res.json({
      success: true,
      trigger: {
        id: triggerId,
        name: meta?.name || triggerId,
        description: meta?.description || '',
        category: meta?.category || '',
        variables: meta?.variables || [],
        hasTenantOverride: true,
        tenantSubject: subject,
        tenantHtml: html,
      },
    });
  } catch (error) {
    console.error('Update tenant email template error:', error);
    res.status(500).json({ error: 'Failed to save email template' });
  }
};

// ─── DELETE: reset to default ────────────────────────────────────

const resetEmailTemplate = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const { triggerId } = req.params;
    if (!_tenantTriggers().some((t) => t.id === triggerId)) {
      return res.status(404).json({ error: 'Unknown trigger' });
    }

    await TriggerableEmailTemplate.deleteOne({ triggerId, organizationId: org._id });

    _audit(req, org, 'brand.email_template_reset', { triggerId });
    res.json({ success: true, triggerId });
  } catch (error) {
    console.error('Reset tenant email template error:', error);
    res.status(500).json({ error: 'Failed to reset email template' });
  }
};

module.exports = { listEmailTemplates, updateEmailTemplate, resetEmailTemplate, EXCLUDED_TRIGGERS };
