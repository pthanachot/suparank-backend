/**
 * Migration: Create personal organizations for all users.
 *
 * For each user:
 *   1. Create a personal Organization (isPersonal: true)
 *   2. Link all their workspaces to the org (workspace.organizationId)
 *   3. Update their OrgMember records to include organizationId
 *
 * Safe to run multiple times (idempotent).
 */

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Organization = require('../models/Organization');
const Workspace = require('../models/Workspace');
const OrgMember = require('../models/OrgMember');

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'suparank' });
  console.log('Connected to MongoDB');

  const users = await User.find({ status: 'active' }).select('email profile.name').lean();
  console.log(`Found ${users.length} active users`);

  let orgsCreated = 0;
  let workspacesLinked = 0;
  let membersLinked = 0;

  for (const user of users) {
    // 1. Find or create personal org
    const org = await Organization.findOrCreatePersonal(
      user._id,
      user.profile?.name,
      user.email
    );
    if (org.isNew !== false) orgsCreated++; // approx — findOrCreatePersonal may find existing

    // 2. Link workspaces to org
    const result = await Workspace.updateMany(
      { userId: user._id, organizationId: null },
      { $set: { organizationId: org._id } }
    );
    workspacesLinked += result.modifiedCount;

    // 3. Update OrgMember records to include organizationId
    const memberResult = await OrgMember.updateMany(
      { ownerId: user._id, organizationId: { $exists: false } },
      { $set: { organizationId: org._id } }
    );
    membersLinked += memberResult.modifiedCount;

    // Also update OrgMember records where organizationId is null
    const memberResult2 = await OrgMember.updateMany(
      { ownerId: user._id, organizationId: null },
      { $set: { organizationId: org._id } }
    );
    membersLinked += memberResult2.modifiedCount;
  }

  console.log(`\nMigration complete:`);
  console.log(`  Organizations processed: ${users.length}`);
  console.log(`  Workspaces linked: ${workspacesLinked}`);
  console.log(`  OrgMembers linked: ${membersLinked}`);

  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
