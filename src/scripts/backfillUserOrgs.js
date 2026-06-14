/**
 * Backfill: ensure every user has at least one organization + workspace.
 *
 * Fixes accounts created before auto-provisioning existed, or whose signup
 * bootstrap failed — i.e. users with zero owned orgs and no active membership,
 * who would otherwise hit the org-creation dead-end on next login.
 *
 * Delegates to orgBootstrapService.ensureUserHasOrg, so behavior is identical
 * to live signup/login self-heal. Idempotent — safe to run multiple times.
 *
 * Usage:  node src/scripts/backfillUserOrgs.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Organization = require('../models/Organization');
const { ensureUserHasOrg } = require('../services/orgBootstrapService');

async function backfill() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'suparank' });
  console.log('Connected to MongoDB');

  // Skip accounts pending deletion — they must not get fresh orgs.
  const users = await User.find({ status: { $ne: 'pending_deletion' } })
    .select('email profile.name')
    .lean();
  console.log(`Scanning ${users.length} users...`);

  let healed = 0;
  let promoted = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const ownedOrgs = await Organization.find({ ownerId: user._id })
        .select('_id isPersonal')
        .lean();

      if (ownedOrgs.length === 0) {
        // Stranded — provision a home org (created as isPersonal: true).
        const result = await ensureUserHasOrg(user);
        if (result?.org) {
          healed++;
          console.log(`  + healed ${user.email} -> org "${result.org.name}" (${result.org._id})`);
        } else {
          skipped++; // member of someone else's org, or provisioning failed (logged)
        }
      } else if (!ownedOrgs.some((o) => o.isPersonal === true) && ownedOrgs.length === 1) {
        // Bootstrap-era home org created as isPersonal:false — promote it so the
        // cohort matches new signups and the isPersonal:true lookups resolve it.
        // Safe under maxOrganizationsPerUser=1: the sole owned org IS the home org.
        await Organization.updateOne({ _id: ownedOrgs[0]._id }, { $set: { isPersonal: true } });
        promoted++;
        console.log(`  ^ promoted ${user.email} -> org ${ownedOrgs[0]._id} isPersonal=true`);
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      console.error(`  ! failed ${user.email}: ${err.message}`);
    }
  }

  console.log('\nBackfill complete:');
  console.log(`  Users scanned:    ${users.length}`);
  console.log(`  Orgs created:     ${healed}`);
  console.log(`  Orgs promoted:    ${promoted}`);
  console.log(`  Already OK:       ${skipped}`);
  console.log(`  Failed:           ${failed}`);

  await mongoose.disconnect();
}

backfill().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
