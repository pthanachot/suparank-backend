/**
 * Migrates existing Workspace.members[] to OrgMember documents.
 *
 * Each workspace member becomes an org-level member of the workspace owner,
 * with role 'editor' (closest to current equal-access behavior).
 *
 * Usage:
 *   node src/scripts/migrateWorkspaceMembers.js
 *
 * Idempotent — uses upsert with unique index, safe to run multiple times.
 */

require('dotenv').config();
const { connectDB } = require('../config/database');
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const OrgMember = require('../models/OrgMember');

async function migrate() {
  try {
    await connectDB();
    console.log('\n─── Migrating workspace members → OrgMember ───\n');

    // Find all workspaces that have at least one member
    const workspaces = await Workspace.find({
      'members.0': { $exists: true },
    }).lean();

    console.log(`Found ${workspaces.length} workspaces with members`);

    let created = 0;
    let skipped = 0;

    for (const ws of workspaces) {
      for (const member of ws.members) {
        const result = await OrgMember.updateOne(
          { ownerId: ws.userId, userId: member.userId },
          {
            $setOnInsert: {
              ownerId: ws.userId,
              userId: member.userId,
              email: member.email,
              role: 'editor',
              status: 'active',
              invitedAt: member.addedAt || new Date(),
            },
          },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          created++;
          console.log(`  + ${member.email} → org of workspace "${ws.name}" (owner: ${ws.userId})`);
        } else {
          skipped++;
        }
      }
    }

    console.log(`\n─── Migration complete: ${created} created, ${skipped} already existed ───\n`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

migrate();
