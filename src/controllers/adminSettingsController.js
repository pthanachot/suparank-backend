/**
 * Admin system settings — GET/PUT the SystemSettings singleton, plus a
 * READ-ONLY admin-accounts list. Admin identity is env-only (Phase 2):
 * ADMIN_EMAILS + ADMIN_EMAILS_2..5 in Railway. The add/remove endpoints were
 * retired; listing reflects the env slots via utils/adminEmails.
 */
const { getSettings, updateSettings } = require('../services/systemSettingsService');
const { adminEmailSet } = require('../utils/adminEmails');
const User = require('../models/User');
const adminAudit = require('../services/adminAuditService');
const AUDIT = require('../services/adminAuditActions');

const getSystemSettings = async (req, res) => {
  // knownAgentCommands is the SAME registry the PUT validates against, so the
  // admin UI renders exactly the toggles the server will accept. Without it the
  // UI would need its own copy of the command list, which is how you get a
  // console offering a command the API then rejects as unknown — or worse,
  // quietly omitting one that is disabled in production and cannot be re-enabled
  // from the console at all.
  //
  // `defaultDisabled` ships alongside so the UI can label which commands are off
  // because nobody has touched the setting, versus off by an admin's decision:
  // `disabledAgentCommands: null` means "use the default", and showing that as
  // an empty selection would misreport /image (and three others) as enabled.
  const { COMMAND_TOOLS, DEFAULT_DISABLED_AGENT_COMMANDS } = require('../config/agentBilling');
  res.json({
    settings: getSettings(),
    knownAgentCommands: Object.keys(COMMAND_TOOLS).sort(),
    defaultDisabledAgentCommands: [...DEFAULT_DISABLED_AGENT_COMMANDS].sort(),
  });
};

const updateSystemSettings = async (req, res) => {
  try {
    const { maintenanceMode, emailNotificationsEnabled, rateLimit, backup, disabledAgentCommands } = req.body || {};
    const patch = {};

    if (maintenanceMode !== undefined) {
      if (typeof maintenanceMode !== 'boolean') {
        return res.status(400).json({ error: 'maintenanceMode must be a boolean' });
      }
      patch.maintenanceMode = maintenanceMode;
    }

    if (emailNotificationsEnabled !== undefined) {
      if (typeof emailNotificationsEnabled !== 'boolean') {
        return res.status(400).json({ error: 'emailNotificationsEnabled must be a boolean' });
      }
      patch.emailNotificationsEnabled = emailNotificationsEnabled;
    }

    if (rateLimit !== undefined) {
      const { windowMs, max } = rateLimit || {};
      if (windowMs !== undefined && windowMs !== null && (!Number.isInteger(windowMs) || windowMs < 1000)) {
        return res.status(400).json({ error: 'rateLimit.windowMs must be an integer >= 1000 (ms) or null' });
      }
      if (max !== undefined && max !== null && (!Number.isInteger(max) || max < 1)) {
        return res.status(400).json({ error: 'rateLimit.max must be a positive integer or null' });
      }
      if (windowMs !== undefined) patch['rateLimit.windowMs'] = windowMs;
      if (max !== undefined) patch['rateLimit.max'] = max;
    }

    if (backup !== undefined) {
      const { directory, retentionCount } = backup || {};
      if (directory !== undefined && directory !== null && (typeof directory !== 'string' || !directory.trim())) {
        return res.status(400).json({ error: 'backup.directory must be a non-empty path or null for the default' });
      }
      if (
        retentionCount !== undefined &&
        (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 100)
      ) {
        return res.status(400).json({ error: 'backup.retentionCount must be an integer between 1 and 100' });
      }
      if (directory !== undefined) patch['backup.directory'] = directory === null ? null : directory.trim();
      if (retentionCount !== undefined) patch['backup.retentionCount'] = retentionCount;
    }

    if (disabledAgentCommands !== undefined) {
      // null resets to the built-in default; an array (even []) is an explicit
      // admin decision. Names are validated against the server command
      // registry so a typo can't silently disable nothing.
      if (disabledAgentCommands !== null) {
        if (!Array.isArray(disabledAgentCommands) || disabledAgentCommands.some((c) => typeof c !== 'string')) {
          return res.status(400).json({ error: 'disabledAgentCommands must be an array of command names, or null for the default' });
        }
        if (disabledAgentCommands.length > 100) {
          return res.status(400).json({ error: 'disabledAgentCommands is too long' });
        }
        const { COMMAND_TOOLS } = require('../config/agentBilling');
        // Own-property check: a bare lookup accepts inherited keys, so
        // "constructor" would validate as a real command name.
        const unknown = disabledAgentCommands.filter(
          (c) => !Object.prototype.hasOwnProperty.call(COMMAND_TOOLS, c)
        );
        if (unknown.length > 0) {
          return res.status(400).json({ error: `Unknown command name(s): ${unknown.join(', ')}` });
        }
      }
      patch.disabledAgentCommands = disabledAgentCommands;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid settings provided' });
    }

    const settings = await updateSettings(patch);
    console.log(`[admin] System settings updated by ${req.user?.email}: ${JSON.stringify(patch)}`);
    adminAudit.fromReq(req, { action: AUDIT.SETTINGS_UPDATE, targetType: 'system', targetId: 'global', meta: { patch } });
    res.json({ success: true, settings });
  } catch (error) {
    console.error('[admin] updateSystemSettings error:', error.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

// ─── Admin accounts (read-only) ─────────────────────────────
// Admin identity is env-only: ADMIN_EMAILS + ADMIN_EMAILS_2..5 in Railway.
// Every listed admin is env-managed and locked; changes require editing the
// env vars and redeploying. Add/remove endpoints were retired in Phase 2.

const listAdmins = async (req, res) => {
  try {
    const emails = [...adminEmailSet()]; // already lowercased, deduped
    const users = await User.find({ email: { $in: emails } })
      .select('email status')
      .lean();
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    const me = req.user?.email?.toLowerCase();

    res.json({
      admins: emails.map((email) => ({
        email,
        source: 'env',
        locked: true,
        userExists: byEmail.has(email),
        userStatus: byEmail.get(email)?.status || null,
        isYou: email === me,
      })),
    });
  } catch (error) {
    console.error('[admin] listAdmins error:', error.message);
    res.status(500).json({ error: 'Failed to list admins' });
  }
};

/**
 * GET /api/admin/image-spend — per-org image COGS, worst first.
 *
 * Images are the only thing the engine buys per UNIT rather than per token, so
 * one tenant can run up real money without moving any token-based dashboard.
 * This is the view an operator checks after enabling /image, and the one that
 * says whether to switch it back off.
 *
 * Read-only and admin-gated like the rest of this controller; deliberately NOT
 * audit-logged (reading a cost total changes nothing, and the audit trail is
 * for actions).
 */
const getImageSpend = async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const AiCostLedger = require('../models/AiCostLedger');
    const rows = await AiCostLedger.imageSpendByOrg({
      sinceMs: days * 24 * 60 * 60 * 1000,
      limit,
    });
    res.json({
      days,
      orgs: rows,
      totals: {
        costUsd: rows.reduce((s, r) => s + (r.costUsd || 0), 0),
        images: rows.reduce((s, r) => s + (r.images || 0), 0),
      },
      // Named so the reader knows a low count over an old window is a recording
      // gap, not a quiet month — the column is newer than the ledger.
      note: 'images is 0 on ledger rows written before the images column shipped; costUsd is accurate throughout.',
    });
  } catch (err) {
    console.error('[admin] image spend query failed:', err.message);
    res.status(500).json({ error: 'Failed to load image spend' });
  }
};

module.exports = { getSystemSettings, updateSystemSettings, listAdmins, getImageSpend };
