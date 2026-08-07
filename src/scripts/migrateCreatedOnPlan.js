/**
 * Migration: Backfill `createdOnPlan` field on Content, BrandVoice, Avatar,
 * KeywordResearchHistory, and AiTrackerPrompt.
 *
 * For each organization:
 *   - Look up current tier
 *   - Set createdOnPlan to 'free' if tier is free, 'paid' otherwise
 *   - Updates all resources in that org's workspaces
 *
 * Safe to run multiple times (idempotent).
 *
 * Usage: node src/scripts/migrateCreatedOnPlan.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Organization = require('../models/Organization');
const Workspace = require('../models/Workspace');
const Content = require('../models/Content');
const BrandVoice = require('../models/BrandVoice');
const Avatar = require('../models/Avatar');
const AiTracker = require('../models/AiTracker');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const tierService = require('../services/tierService');

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'suparank' });
  console.log('Connected to MongoDB');

  const orgs = await Organization.find({}).select('_id name').lean();
  console.log(`Found ${orgs.length} organizations`);

  let contentUpdated = 0;
  let bvUpdated = 0;
  let avatarUpdated = 0;
  let kwHistoryUpdated = 0;
  let promptUpdated = 0;

  for (const org of orgs) {
    const { tier } = await tierService.getOrgTierConfig(org._id);
    const createdOnPlan = tier === 'free' ? 'free' : 'paid';

    const wsIds = await Workspace.find({ organizationId: org._id }).distinct('_id');
    if (wsIds.length === 0) continue;

    // Only update documents that don't already have createdOnPlan set
    const contentResult = await Content.updateMany(
      { workspaceId: { $in: wsIds }, createdOnPlan: { $exists: false } },
      { $set: { createdOnPlan } }
    );
    contentUpdated += contentResult.modifiedCount;

    const bvResult = await BrandVoice.updateMany(
      { workspace: { $in: wsIds }, createdOnPlan: { $exists: false } },
      { $set: { createdOnPlan } }
    );
    bvUpdated += bvResult.modifiedCount;

    const avatarResult = await Avatar.updateMany(
      { workspace: { $in: wsIds }, createdOnPlan: { $exists: false } },
      { $set: { createdOnPlan } }
    );
    avatarUpdated += avatarResult.modifiedCount;

    const kwResult = await KeywordResearchHistory.updateMany(
      { workspaceId: { $in: wsIds }, createdOnPlan: { $exists: false } },
      { $set: { createdOnPlan } }
    );
    kwHistoryUpdated += kwResult.modifiedCount;

    const trackerIds = await AiTracker.find({ workspaceId: { $in: wsIds } }).distinct('_id');
    if (trackerIds.length > 0) {
      const promptResult = await AiTrackerPrompt.updateMany(
        { trackerId: { $in: trackerIds }, createdOnPlan: { $exists: false } },
        { $set: { createdOnPlan } }
      );
      promptUpdated += promptResult.modifiedCount;
    }

    const total = contentResult.modifiedCount + bvResult.modifiedCount + avatarResult.modifiedCount + kwResult.modifiedCount;
    if (total > 0) {
      console.log(`  ${org.name || org._id}: tier=${tier} → ${createdOnPlan} (content: ${contentResult.modifiedCount}, bv: ${bvResult.modifiedCount}, avatar: ${avatarResult.modifiedCount}, kw: ${kwResult.modifiedCount})`);
    }
  }

  console.log(`\nMigration complete: ${contentUpdated} content, ${bvUpdated} brand voices, ${avatarUpdated} avatars, ${kwHistoryUpdated} keyword histories, ${promptUpdated} AI tracker prompts updated`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
