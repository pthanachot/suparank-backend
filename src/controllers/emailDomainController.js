/**
 * Per-tenant sender-domain endpoints (Phase 11) — Brevo-backed.
 *
 *   GET    /api/org/organizations/:orgId/email-domain          status + DNS records
 *   PUT    /api/org/organizations/:orgId/email-domain {domain} register with Brevo
 *   POST   /api/org/organizations/:orgId/email-domain/verify   ask Brevo to authenticate
 *   DELETE /api/org/organizations/:orgId/email-domain          remove
 *
 * All owner/full-admin + white-label entitlement; routes additionally sit
 * behind the whiteLabelEmail launch flag (requireFeature).
 */

const brandService = require('../services/brandService');
const brevoService = require('../services/brevoService');
const auditService = require('../services/auditService');
const domainService = require('../services/domainService');
const { resolveOrgWithAccess } = require('./orgMemberController');

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
    action,
    resourceId: org._id,
    meta,
    ip: req.ip,
  });
}

// ─── GET: current state + DNS records ────────────────────────────

const getEmailDomain = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const { config } = await brandService.getBrandForOrg(org._id);
    const emailDomain = config?.emailDomain?.domain ? config.emailDomain : null;

    let dnsRecords = null;
    let brevoLookupFailed = false;
    if (emailDomain && brevoService.isConfigured()) {
      try {
        const info = await brevoService.getSenderDomain(emailDomain.domain);
        dnsRecords = info?.dns_records || null;
        // Self-heal: sender registration is idempotent and can have failed
        // transiently at verify time — reattempt on settings visits so a
        // verified domain never sits with an unregistered from-address.
        if (emailDomain.status === 'verified') {
          const { config: cfg } = await brandService.getBrandForOrg(org._id);
          const fromName = cfg?.emailFromName || cfg?.productName || 'Notifications';
          brevoService
            .createSender({ name: fromName, email: `no-reply@${emailDomain.domain}` })
            .catch(() => {});
        }
      } catch (err) {
        // Domain may have been removed on the Brevo side — surface it so
        // the UI doesn't show a healthy status with no records to fix
        brevoLookupFailed = true;
        console.error('[emailDomain] Brevo status lookup failed:', err.message);
      }
    }

    res.json({
      emailDomain,
      dnsRecords,
      brevoLookupFailed,
      brevoConfigured: brevoService.isConfigured(),
    });
  } catch (error) {
    console.error('Get email domain error:', error);
    res.status(500).json({ error: 'Failed to load email domain settings' });
  }
};

// ─── PUT: register a sender domain ───────────────────────────────

const setEmailDomain = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const validated = domainService.validateHostname(req.body?.domain);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }
    const domain = validated.hostname;

    if (!brevoService.isConfigured()) {
      return res.status(503).json({
        error: 'Email-domain verification is pending platform setup (Brevo not configured)',
      });
    }

    // Cross-org takeover guard: Brevo domains live on ONE shared platform
    // account, so 'already exists' from Brevo may mean ANOTHER org owns it.
    // Without this check, org B could attach org A's verified domain and a
    // later DELETE would remove it account-wide, silently breaking A's email.
    const BrandConfig = require('../models/BrandConfig');
    const claimed = await BrandConfig.findOne({
      'emailDomain.domain': domain,
      organizationId: { $ne: org._id },
    })
      .select('_id')
      .lean();
    if (claimed) {
      return res
        .status(409)
        .json({ error: 'This domain is already connected to another organization' });
    }

    let dnsRecords = null;
    try {
      const created = await brevoService.createSenderDomain(domain);
      dnsRecords = created?.dns_records || null;
    } catch (err) {
      // Already registered on our Brevo account (and not claimed by another
      // org per the guard above — e.g. this org re-adding after a partial
      // remove) → fetch its records instead
      if (/already/i.test(err.message)) {
        const info = await brevoService.getSenderDomain(domain);
        dnsRecords = info?.dns_records || null;
      } else {
        return res.status(err.status && err.status < 500 ? 400 : 502).json({
          error: `Brevo rejected the domain: ${err.message}`,
        });
      }
    }

    await brandService.updateBrand(org._id, {
      'emailDomain.domain': domain,
      'emailDomain.status': 'pending',
      'emailDomain.providerId': 'brevo',
    });

    _audit(req, org, 'brand.email_domain_add', { domain });
    const { config } = await brandService.getBrandForOrg(org._id);
    res.status(201).json({ emailDomain: config?.emailDomain || null, dnsRecords });
  } catch (error) {
    console.error('Set email domain error:', error);
    res.status(500).json({ error: 'Failed to register email domain' });
  }
};

// ─── POST verify: ask Brevo to authenticate ──────────────────────

const verifyEmailDomain = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const { config } = await brandService.getBrandForOrg(org._id);
    const domain = config?.emailDomain?.domain;
    if (!domain) {
      return res.status(400).json({ error: 'No email domain configured' });
    }
    if (!brevoService.isConfigured()) {
      return res.status(503).json({
        error: 'Email-domain verification is pending platform setup (Brevo not configured)',
      });
    }

    let verified = false;
    let dnsRecords = null;
    try {
      await brevoService.authenticateSenderDomain(domain).catch(() => {
        // authenticate 400s while DNS is missing — the status GET below is
        // the source of truth either way
      });
      const info = await brevoService.getSenderDomain(domain);
      dnsRecords = info?.dns_records || null;
      // Tolerant detection: Brevo's exact response fields are unconfirmed
      // against a live account (top-level verified/authenticated vs
      // per-record dns_records[*].status). Accept either signal.
      // TODO(staging): validate against a real Brevo response and tighten.
      const recordStatuses = Object.values(info?.dns_records || {})
        .map((r) => String(r?.status ?? '').toLowerCase())
        .filter((s) => s !== '');
      const dnsAllOk =
        recordStatuses.length > 0 &&
        recordStatuses.every((s) => ['verified', 'success', 'ok', 'true'].includes(s));
      verified = Boolean((info?.verified && info?.authenticated) || dnsAllOk);
    } catch (err) {
      return res.status(502).json({ error: `Brevo verification failed: ${err.message}` });
    }

    if (verified) {
      if (config.emailDomain.status !== 'verified') {
        await brandService.updateBrand(org._id, { 'emailDomain.status': 'verified' });
        _audit(req, org, 'brand.email_domain_verified', { domain });
      }
      // Register the from-address so SMTP sends from it are accepted.
      // Attempted on EVERY verify of a verified domain (idempotent —
      // 'already exists' counts as success): a one-shot attempt could fail
      // transiently and leave sends rejected with no retry path.
      const fromName = config.emailFromName || config.productName || 'Notifications';
      brevoService
        .createSender({ name: fromName, email: `no-reply@${domain}` })
        .catch((err) => console.error('[emailDomain] sender registration failed:', err.message));
    }

    const fresh = await brandService.getBrandForOrg(org._id);
    res.json({
      emailDomain: fresh.config?.emailDomain || null,
      dnsRecords,
      verified,
    });
  } catch (error) {
    console.error('Verify email domain error:', error);
    res.status(500).json({ error: 'Failed to verify email domain' });
  }
};

// ─── DELETE ──────────────────────────────────────────────────────

const removeEmailDomain = async (req, res) => {
  try {
    const org = await _gate(req, res);
    if (!org) return;

    const { config } = await brandService.getBrandForOrg(org._id);
    const domain = config?.emailDomain?.domain;
    if (!domain) {
      return res.status(404).json({ error: 'No email domain configured' });
    }

    if (brevoService.isConfigured()) {
      await brevoService
        .deleteSenderDomain(domain)
        .catch((err) => console.error('[emailDomain] Brevo delete failed:', err.message));
    }

    await brandService.updateBrand(org._id, {
      'emailDomain.domain': '',
      'emailDomain.status': 'unverified',
      'emailDomain.providerId': '',
    });

    _audit(req, org, 'brand.email_domain_remove', { domain });
    res.json({ success: true });
  } catch (error) {
    console.error('Remove email domain error:', error);
    res.status(500).json({ error: 'Failed to remove email domain' });
  }
};

module.exports = { getEmailDomain, setEmailDomain, verifyEmailDomain, removeEmailDomain };
