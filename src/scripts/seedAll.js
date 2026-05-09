/**
 * Seeds all RBAC and feature flag data into MongoDB.
 *
 * Usage:
 *   node src/scripts/seedAll.js
 *
 * Requires MONGODB_URI (and optionally DB_NAME) in environment.
 * Idempotent — safe to run multiple times. Does NOT overwrite existing rows.
 */

require('dotenv').config();
const { connectDB } = require('../config/database');
const mongoose = require('mongoose');
const { seedRoles } = require('./seedRoles');
const { seedPermissions } = require('./seedPermissions');
const { seedFeatureFlags } = require('./seedFeatureFlags');

async function main() {
  try {
    await connectDB();
    console.log('\n─── Seeding RBAC data ───\n');

    await seedRoles();
    await seedPermissions();
    await seedFeatureFlags();

    console.log('\n─── Done ───\n');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

main();
