/**
 * Syncs all config data (roles, permissions, feature flags, tiers)
 * from config files into MongoDB on every server startup.
 *
 * THESE FILES ARE THE SOURCE OF TRUTH.
 * To change config, edit the config files and restart the server.
 * Do not edit config values in MongoDB directly.
 *
 * Can also be run manually:
 *   node src/scripts/configSync.js
 */

const { syncRoles } = require('./configRoles');
const { syncPermissions } = require('./configPermissions');
const { syncFeatureFlags } = require('./configFeatureFlags');
const { syncTiers } = require('./configTiers');

async function syncConfig() {
  console.log('[syncConfig] Syncing config from files...');

  await syncRoles();
  await syncPermissions();
  await syncFeatureFlags();
  await syncTiers();

  console.log('[syncConfig] Done.');
}

module.exports = { syncConfig };

// ── Standalone script support ──────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const { connectDB } = require('../config/database');
  const mongoose = require('mongoose');

  (async () => {
    try {
      await connectDB();
      await syncConfig();
    } catch (err) {
      console.error('Sync failed:', err);
      process.exitCode = 1;
    } finally {
      await mongoose.connection.close();
    }
  })();
}
