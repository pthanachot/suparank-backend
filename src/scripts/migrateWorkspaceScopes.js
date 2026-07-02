/**
 * Migration: per-workspace membership scoping (white-label Phase 2).
 *
 * 1. Backfills accessScope: 'all' on OrgMember rows missing the field,
 *    preserving pre-migration behavior (org role applies to all workspaces).
 * 2. Converts legacy Workspace.members[] entries on ORG-OWNED workspaces
 *    into WorkspaceMember rows (role 'editor' — exactly what the legacy
 *    fallback granted) and clears those arrays, so the legacy fallbacks in
 *    permissions.js / listWorkspaces stop matching and can be deleted later.
 *    Users not already in the org get an accessScope 'assigned' OrgMember
 *    row, keeping their access exactly what the legacy array gave them.
 *
 * Personal (organizationId: null) workspaces keep their members[] array —
 * the legacy fallback still covers them until they are moved into orgs.
 * (The older migrateWorkspaceMembers.js handled those via owner-based
 * OrgMember rows.)
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node src/scripts/migrateWorkspaceScopes.js --dry-run   # report only
 *   node src/scripts/migrateWorkspaceScopes.js             # apply
 */

require('dotenv').config();
const { connectDB } = require('../config/database');
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
const User = require('../models/User');

const DRY_RUN = process.argv.includes('--dry-run');

async function migrate() {
  try {
    await connectDB();
    console.log(
      `\n─── Workspace scope migration${DRY_RUN ? ' (DRY RUN — no writes)' : ''} ───\n`
    );

    // ── 1. Backfill accessScope on OrgMember ──────────────────────
    const missingScope = await OrgMember.countDocuments({
      accessScope: { $exists: false },
    });
    console.log(`OrgMembers missing accessScope: ${missingScope}`);
    if (missingScope > 0 && !DRY_RUN) {
      const r = await OrgMember.updateMany(
        { accessScope: { $exists: false } },
        { $set: { accessScope: 'all' } }
      );
      console.log(`  → backfilled ${r.modifiedCount} rows to accessScope 'all'`);
    }

    // ── 2. Convert legacy members[] on org-owned workspaces ───────
    const legacyWorkspaces = await Workspace.find({
      organizationId: { $ne: null },
      'members.0': { $exists: true },
    }).lean();
    console.log(`Org workspaces with legacy members[]: ${legacyWorkspaces.length}`);

    let created = 0;
    let alreadyExisted = 0;
    let orgMembersCreated = 0;
    let skippedNoUser = 0;

    for (const ws of legacyWorkspaces) {
      for (const legacy of ws.members) {
        if (!legacy.userId) {
          skippedNoUser++;
          continue;
        }

        let email = legacy.email;
        if (!email) {
          const u = await User.findById(legacy.userId).select('email').lean();
          email = u?.email || 'unknown@migrated.local';
        }

        // WorkspaceMember grant (idempotent via unique index + upsert)
        if (DRY_RUN) {
          const exists = await WorkspaceMember.findOne({
            workspaceId: ws._id,
            userId: legacy.userId,
          }).lean();
          if (exists) alreadyExisted++;
          else created++;
        } else {
          const r = await WorkspaceMember.updateOne(
            { workspaceId: ws._id, userId: legacy.userId },
            {
              $setOnInsert: {
                organizationId: ws.organizationId,
                email,
                role: 'editor', // exactly what the legacy fallback granted
                status: 'active',
                invitedBy: null,
              },
            },
            { upsert: true }
          );
          if (r.upsertedCount > 0) created++;
          else alreadyExisted++;
        }

        // Ensure an OrgMember row exists so org/workspace resolution finds
        // them. Scope 'assigned' — access stays exactly this workspace.
        const orgMembership = await OrgMember.findOne({
          organizationId: ws.organizationId,
          userId: legacy.userId,
        }).lean();
        if (!orgMembership) {
          if (!DRY_RUN) {
            const org = await Organization.findById(ws.organizationId)
              .select('ownerId')
              .lean();
            if (!org) {
              console.warn(`  ! org ${ws.organizationId} missing for workspace ${ws.workspaceNumber} — skipped OrgMember`);
              continue;
            }
            await OrgMember.create({
              organizationId: ws.organizationId,
              ownerId: org.ownerId,
              userId: legacy.userId,
              email,
              role: 'editor',
              accessScope: 'assigned',
              status: 'active',
            });
          }
          orgMembersCreated++;
        }
      }

      if (!DRY_RUN) {
        await Workspace.updateOne({ _id: ws._id }, { $set: { members: [] } });
      }
    }

    console.log(`WorkspaceMember grants created: ${created}`);
    console.log(`Grants already existed: ${alreadyExisted}`);
    console.log(`Assigned-scope OrgMembers created: ${orgMembersCreated}`);
    console.log(`Legacy entries without userId (skipped): ${skippedNoUser}`);
    console.log(
      `Workspaces cleared of legacy members[]: ${DRY_RUN ? '0 (dry run)' : legacyWorkspaces.length}`
    );
    console.log('\n─── Migration complete ───\n');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

migrate();
