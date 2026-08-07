/**
 * Verify (and optionally create) the notification-system indexes on the live
 * database. Mongoose builds indexes lazily and `autoIndex` is typically OFF in
 * production, so their existence must be CONFIRMED, not assumed:
 *   - a missing TTL on Notification → rows accumulate forever
 *   - a missing { userId, createdAt } compound → the 90s feed poll does a
 *     collection scan for every user
 *   - a missing { status, publishAt } compound → the announcement query scans
 *
 * Read-only by default. Pass --sync to create any missing indexes via
 * syncIndexes() (which also drops indexes no longer declared in the schema).
 *
 * Usage:
 *   node src/scripts/verifyNotificationIndexes.js          # report only
 *   node src/scripts/verifyNotificationIndexes.js --sync   # create / reconcile
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Notification = require('../models/Notification');
const Announcement = require('../models/Announcement');

const TTL_90D = 90 * 24 * 60 * 60;

async function liveIndexes(Model) {
  try {
    return await Model.collection.indexes();
  } catch (err) {
    // A collection that has never held a document doesn't exist yet, so
    // .indexes() throws NamespaceNotFound (code 26). That's a valid state — run
    // --sync. Match on the code first, message text as a fallback.
    if (err.code === 26 || /ns does not exist|not found/i.test(err.message)) return null;
    throw err;
  }
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'suparank' });
  console.log('Connected to MongoDB\n');

  if (process.argv.includes('--sync')) {
    console.log('Syncing indexes (create missing, drop stale)…');
    await Notification.syncIndexes();
    await Announcement.syncIndexes();
    console.log('Sync complete.\n');
  }

  let ok = true;

  // ── Notification ──
  const nIdx = await liveIndexes(Notification);
  console.log('Notification indexes:');
  if (!nIdx) {
    ok = false;
    console.error('  ✗ collection does not exist yet — run with --sync');
  } else {
    nIdx.forEach((i) =>
      console.log('  ', JSON.stringify(i.key), i.expireAfterSeconds !== undefined ? `(TTL ${i.expireAfterSeconds}s)` : '')
    );
    const ttl = nIdx.find((i) => i.expireAfterSeconds !== undefined);
    if (!ttl) { ok = false; console.error('  ✗ MISSING: TTL index on createdAt'); }
    else if (ttl.expireAfterSeconds !== TTL_90D) { ok = false; console.error(`  ✗ TTL is ${ttl.expireAfterSeconds}s, expected ${TTL_90D}s (90d)`); }
    else if (JSON.stringify(ttl.key) !== JSON.stringify({ createdAt: 1 })) { ok = false; console.error('  ✗ TTL must be single-field on createdAt'); }
    else console.log('  ✓ TTL 90d on createdAt');

    if (!nIdx.find((i) => i.key.userId === 1 && i.key.createdAt === -1)) { ok = false; console.error('  ✗ MISSING: feed compound { userId:1, createdAt:-1 }'); }
    else console.log('  ✓ feed compound { userId:1, createdAt:-1 }');
  }

  // ── Announcement ──
  const aIdx = await liveIndexes(Announcement);
  console.log('\nAnnouncement indexes:');
  if (!aIdx) {
    ok = false;
    console.error('  ✗ collection does not exist yet — run with --sync');
  } else {
    aIdx.forEach((i) => console.log('  ', JSON.stringify(i.key)));
    if (!aIdx.find((i) => i.key.status === 1 && i.key.publishAt === -1)) { ok = false; console.error('  ✗ MISSING: feed compound { status:1, publishAt:-1 }'); }
    else console.log('  ✓ feed compound { status:1, publishAt:-1 }');
  }

  console.log('');
  if (ok) console.log('✓ All notification indexes present.');
  else { console.error('✗ Some indexes are missing — run with --sync to create them.'); process.exitCode = 1; }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('verifyNotificationIndexes failed:', err.message);
  process.exit(1);
});
