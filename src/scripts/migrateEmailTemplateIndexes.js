/**
 * Migration: per-tenant email templates (white-label Phase 12).
 *
 * The emailtriggers collection historically had a UNIQUE index on triggerId
 * alone (`triggerId_1`). Phase 12 adds organizationId-scoped rows, so
 * uniqueness moves to the compound { triggerId, organizationId } index
 * declared on the model. This script:
 *
 *   1. Drops the legacy `triggerId_1` unique index if present.
 *   2. Runs Model.syncIndexes() so the new compound unique index (and the
 *      organizationId index) exist and match the schema.
 *
 * Existing global rows keep working without a data backfill — resolution
 * queries match them via { organizationId: { $exists: false } }.
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node src/scripts/migrateEmailTemplateIndexes.js --dry-run   # report only
 *   node src/scripts/migrateEmailTemplateIndexes.js             # apply
 */

require('dotenv').config();
const { connectDB } = require('../config/database');
const mongoose = require('mongoose');
const TriggerableEmailTemplate = require('../models/TriggerableEmailTemplate');

const DRY_RUN = process.argv.includes('--dry-run');

async function migrate() {
  try {
    await connectDB();
    console.log(
      `\n─── Email template index migration${DRY_RUN ? ' (DRY RUN — no writes)' : ''} ───\n`
    );

    const collection = TriggerableEmailTemplate.collection;

    let indexes = [];
    try {
      indexes = await collection.indexes();
    } catch (err) {
      // Collection may not exist yet (fresh database) — nothing to drop.
      console.log(`Collection not found (${err.message}) — nothing to drop.`);
    }
    console.log(`Existing indexes: ${indexes.map((i) => i.name).join(', ') || '(none)'}`);

    // Match by KEY SHAPE, not name — a prod index created manually or by an
    // older mongoose could carry a different name than 'triggerId_1'.
    const legacy = indexes.find(
      (i) =>
        i.unique === true &&
        i.key &&
        Object.keys(i.key).length === 1 &&
        i.key.triggerId === 1
    );
    if (legacy) {
      if (DRY_RUN) {
        console.log('Would drop legacy index: triggerId_1');
      } else {
        await collection.dropIndex('triggerId_1');
        console.log('Dropped legacy index: triggerId_1');
      }
    } else {
      console.log('Legacy triggerId_1 index not present — nothing to drop.');
    }

    if (DRY_RUN) {
      console.log('Would run syncIndexes() to create { triggerId: 1, organizationId: 1 } unique.');
    } else {
      const dropped = await TriggerableEmailTemplate.syncIndexes();
      if (dropped.length > 0) console.log(`syncIndexes dropped: ${dropped.join(', ')}`);
      const after = await collection.indexes();
      console.log(`Indexes now: ${after.map((i) => i.name).join(', ')}`);
    }

    console.log('\n─── Migration complete ───\n');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

migrate();
