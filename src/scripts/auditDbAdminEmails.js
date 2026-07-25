/**
 * Phase 3 migration read — env-only admin cutover.
 *
 * Admin identity became env-only in Phase 2: the DB-managed
 * SystemSettings.adminEmails list is no longer consulted by the gate. This
 * script is the ORDERING GATE's safety check — run it BEFORE (or as part of)
 * the Phase 2 deploy to find any admin who exists ONLY in the DB list and would
 * be orphaned by the cutover, so you can fold them into the Railway env slots
 * (ADMIN_EMAILS + ADMIN_EMAILS_2..5) first.
 *
 * Read-only: it never writes. Exit code 1 if any DB-only admin is found (so it
 * can gate a deploy pipeline), 0 if the env slots already cover everyone.
 *
 * Usage:
 *   node src/scripts/auditDbAdminEmails.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const SystemSettings = require('../models/SystemSettings');
const { adminEmailSet } = require('../utils/adminEmails');

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  // Match the app's own resolution (config/database.js) so this safety check
  // reads the SAME database the running server uses — a hardcoded name could
  // query the wrong DB and falsely report "no DB-only admins".
  const dbName = process.env.DB_NAME || 'suparank';
  await mongoose.connect(uri, { dbName });
  console.log(`Connected to MongoDB (db: ${dbName})\n`);

  const envAdmins = [...adminEmailSet()]; // env-only (ADMIN_EMAILS + ADMIN_EMAILS_2..5)
  const doc = await SystemSettings.findOne({ key: 'global' }).lean();
  const dbAdmins = (doc?.adminEmails || []).map((e) => String(e).toLowerCase());
  const orphaned = dbAdmins.filter((e) => !envAdmins.includes(e));

  console.log(`Env admin slots (currently ${envAdmins.length}):`);
  if (envAdmins.length === 0) console.log('  (none — ADMIN_EMAILS…ADMIN_EMAILS_5 are all empty!)');
  else envAdmins.forEach((e) => console.log(`  • ${e}`));

  console.log(`\nDeprecated DB adminEmails (${dbAdmins.length}):`);
  if (dbAdmins.length === 0) console.log('  (none)');
  else dbAdmins.forEach((e) => console.log(`  • ${e}${envAdmins.includes(e) ? '  ✓ also in env' : '  ⚠ DB-ONLY'}`));

  console.log('');
  if (orphaned.length === 0) {
    console.log('✓ No DB-only admins. The env slots already cover everyone — safe to cut over.');
  } else {
    console.error(`✗ ${orphaned.length} admin(s) exist ONLY in the DB and will LOSE ACCESS after the cutover:`);
    orphaned.forEach((e) => console.error(`    ${e}`));
    console.error('\n  Add these to the Railway env slots (ADMIN_EMAILS…ADMIN_EMAILS_5) and');
    console.error('  redeploy TOGETHER with the Phase 2 cutover before removing DB access.');
    process.exitCode = 1;
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('auditDbAdminEmails failed:', err.message);
  process.exit(1);
});
