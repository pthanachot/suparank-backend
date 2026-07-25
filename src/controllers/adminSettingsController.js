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
  res.json({ settings: getSettings() });
};

const updateSystemSettings = async (req, res) => {
  try {
    const { maintenanceMode, emailNotificationsEnabled, rateLimit, backup } = req.body || {};
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

module.exports = { getSystemSettings, updateSystemSettings, listAdmins };
