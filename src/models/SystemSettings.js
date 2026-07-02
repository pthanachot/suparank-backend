const mongoose = require('mongoose');

/**
 * SystemSettings — singleton document (key: 'global') holding admin-tunable
 * runtime configuration. Read through systemSettingsService's in-memory
 * cache; never query this model directly on the request path.
 */
const systemSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    maintenanceMode: { type: Boolean, default: false },
    emailNotificationsEnabled: { type: Boolean, default: true },
    rateLimit: {
      windowMs: { type: Number, default: null }, // null → built-in default (15 min)
      max: { type: Number, default: null }, // null → env-based default
    },
    // DB-managed admin emails — union with the ADMIN_EMAILS env var (Phase 4)
    adminEmails: { type: [String], default: [] },
    backup: {
      directory: { type: String, default: null }, // null → <backend>/backups
      retentionCount: { type: Number, default: 7 }, // newest N archives kept on disk
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
