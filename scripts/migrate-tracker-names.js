/**
 * One-time migration: backfill `name` field on existing AiTracker documents
 * and swap the unique index from { workspaceId } to { workspaceId, name }.
 *
 * Run before deploying multi-monitor support:
 *   node scripts/migrate-tracker-names.js
 *
 * Safe to run multiple times (idempotent).
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function migrate() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'suparank';
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  console.log(`Connecting to MongoDB (${dbName})...`);
  await mongoose.connect(uri, { dbName });
  console.log('Connected.');

  const collection = mongoose.connection.db.collection('aitrackers');

  // Step 1: Backfill name = domain where name is null
  const backfillResult = await collection.updateMany(
    { $or: [{ name: null }, { name: { $exists: false } }] },
    [{ $set: { name: '$domain' } }]
  );
  console.log(`Backfilled ${backfillResult.modifiedCount} tracker(s) with name = domain.`);

  // Step 2: Drop old unique index on { workspaceId: 1 } if it exists
  const indexes = await collection.indexes();
  const oldIndex = indexes.find(
    (idx) => idx.unique && idx.key && idx.key.workspaceId === 1 && !idx.key.name
  );
  if (oldIndex) {
    await collection.dropIndex(oldIndex.name);
    console.log(`Dropped old unique index: ${oldIndex.name}`);
  } else {
    console.log('Old unique index on { workspaceId } not found (already dropped or never existed).');
  }

  // Step 3: Create new compound unique index if it doesn't exist
  const newIndex = indexes.find(
    (idx) => idx.unique && idx.key && idx.key.workspaceId === 1 && idx.key.name === 1
  );
  if (!newIndex) {
    await collection.createIndex({ workspaceId: 1, name: 1 }, { unique: true });
    console.log('Created new compound unique index: { workspaceId: 1, name: 1 }');
  } else {
    console.log('Compound unique index { workspaceId, name } already exists.');
  }

  console.log('Migration complete.');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
