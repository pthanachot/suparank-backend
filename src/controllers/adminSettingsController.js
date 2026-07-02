/**
 * Admin system settings — GET/PUT the SystemSettings singleton, plus the
 * admin-accounts list (union of ADMIN_EMAILS env + DB-managed adminEmails).
 */
const { getSettings, updateSettings } = require('../services/systemSettingsService');
const User = require('../models/User');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function envAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

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
    res.json({ success: true, settings });
  } catch (error) {
    console.error('[admin] updateSystemSettings error:', error.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

// ─── Admin accounts ─────────────────────────────────────────
// Env entries are the locked safety floor (can't be removed here — only by
// changing ADMIN_EMAILS). DB entries are editable, with guardrails: no
// removing the last admin, and self-removal requires explicit confirmation.

const listAdmins = async (req, res) => {
  try {
    const env = envAdminEmails();
    const db = (getSettings().adminEmails || []).map((e) => String(e).toLowerCase());
    const admins = [
      ...env.map((email) => ({ email, source: 'env', locked: true })),
      ...db.filter((email) => !env.includes(email)).map((email) => ({ email, source: 'db', locked: false })),
    ];

    const users = await User.find({ email: { $in: admins.map((a) => a.email) } })
      .select('email status')
      .lean();
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    const me = req.user?.email?.toLowerCase();

    res.json({
      admins: admins.map((a) => ({
        ...a,
        userExists: byEmail.has(a.email),
        userStatus: byEmail.get(a.email)?.status || null,
        isYou: a.email === me,
      })),
    });
  } catch (error) {
    console.error('[admin] listAdmins error:', error.message);
    res.status(500).json({ error: 'Failed to list admins' });
  }
};

const addAdmin = async (req, res) => {
  try {
    const raw = req.body?.email;
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const env = envAdminEmails();
    const db = (getSettings().adminEmails || []).map((e) => String(e).toLowerCase());
    if (env.includes(email) || db.includes(email)) {
      return res.status(409).json({ error: 'This email is already an admin' });
    }

    const settings = await updateSettings({ adminEmails: [...db, email] });
    const userExists = !!(await User.exists({ email }));
    console.log(`[admin] Admin added by ${req.user?.email}: ${email} (userExists=${userExists})`);
    res.json({ success: true, adminEmails: settings.adminEmails, userExists });
  } catch (error) {
    console.error('[admin] addAdmin error:', error.message);
    res.status(500).json({ error: 'Failed to add admin' });
  }
};

const removeAdmin = async (req, res) => {
  try {
    // Express has already URL-decoded route params — decoding again throws
    // URIError on values containing a literal '%'.
    const email = String(req.params.email || '').trim().toLowerCase();
    const confirm = req.query.confirm === 'true';

    const env = envAdminEmails();
    const db = (getSettings().adminEmails || []).map((e) => String(e).toLowerCase());

    if (env.includes(email)) {
      return res.status(403).json({
        error: 'This admin is managed by the ADMIN_EMAILS environment variable and cannot be removed here.',
      });
    }
    if (!db.includes(email)) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    if (env.length === 0 && db.length === 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
    if (email === req.user?.email?.toLowerCase() && !confirm) {
      return res.status(400).json({
        error: 'You are removing your own admin access. Repeat the request with ?confirm=true to proceed.',
      });
    }

    const settings = await updateSettings({ adminEmails: db.filter((e) => e !== email) });
    console.log(`[admin] Admin removed by ${req.user?.email}: ${email}`);
    res.json({ success: true, adminEmails: settings.adminEmails });
  } catch (error) {
    console.error('[admin] removeAdmin error:', error.message);
    res.status(500).json({ error: 'Failed to remove admin' });
  }
};

module.exports = { getSystemSettings, updateSystemSettings, listAdmins, addAdmin, removeAdmin };
