/**
 * Migration: Link existing Subscriptions to Organizations.
 *
 * For each Subscription that has a userId but no organizationId:
 *   1. Find the user's personal org (isPersonal: true)
 *   2. If found → set subscription.organizationId = org._id
 *   3. If not found → create a personal org, then set organizationId
 *
 * Idempotent: skips subscriptions that already have organizationId.
 *
 * Usage:
 *   node src/scripts/migrateSubscriptionsToOrg.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Subscription = require('../models/Subscription');
const Organization = require('../models/Organization');
const User = require('../models/User');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'suparank' });
  console.log('Connected to MongoDB');

  const subscriptions = await Subscription.find({
    organizationId: { $exists: false },
    userId: { $exists: true, $ne: null },
  });

  // Also find subs where organizationId is explicitly null
  const nullOrgSubs = await Subscription.find({
    organizationId: null,
    userId: { $exists: true, $ne: null },
  });

  // Merge and deduplicate
  const allSubs = [...subscriptions];
  for (const sub of nullOrgSubs) {
    if (!allSubs.some((s) => s._id.equals(sub._id))) {
      allSubs.push(sub);
    }
  }

  console.log(`Found ${allSubs.length} subscriptions to migrate`);

  let migrated = 0;
  let orgsCreated = 0;
  let errors = 0;

  for (const sub of allSubs) {
    try {
      // Find user's personal org
      let personalOrg = await Organization.findOne({
        ownerId: sub.userId,
        isPersonal: true,
      });

      if (!personalOrg) {
        // Create personal org for this user
        const user = await User.findById(sub.userId).lean();
        if (!user) {
          console.error(`  User not found: ${sub.userId} — skipping sub ${sub._id}`);
          errors++;
          continue;
        }

        const name = user.profile?.name || user.email?.split('@')[0] || 'Personal';
        const slug = await Organization.generateSlug(`${name}'s Org`, sub.userId);

        personalOrg = await Organization.create({
          name: `${name}'s Org`,
          slug,
          ownerId: sub.userId,
          isPersonal: true,
        });

        console.log(`  Created personal org: ${personalOrg._id} for user ${sub.userId}`);
        orgsCreated++;
      }

      sub.organizationId = personalOrg._id;
      await sub.save();
      migrated++;

      console.log(`  Migrated sub ${sub._id}: userId=${sub.userId} → orgId=${personalOrg._id}`);
    } catch (err) {
      console.error(`  Error migrating sub ${sub._id}:`, err.message);
      errors++;
    }
  }

  console.log('\n─── Migration Summary ───');
  console.log(`  Subscriptions migrated: ${migrated}`);
  console.log(`  Personal orgs created:  ${orgsCreated}`);
  console.log(`  Errors:                 ${errors}`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
