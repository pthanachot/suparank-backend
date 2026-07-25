/**
 * Verify (and optionally --sync) the AdminAuditLog indexes on the live database.
 * Mongoose builds indexes lazily and `autoIndex` is typically OFF in production,
 * so their existence must be CONFIRMED on first deploy of the admin audit log:
 *   - a missing TTL → audit rows accumulate forever
 *   - a missing feed/actor/action/target index → the Audit Log tab's queries scan
 *
 * Read-only by default. Pass --sync to create any missing indexes via
 * syncIndexes() (which also drops indexes no longer declared in the schema).
 *
 * Usage:
 *   node src/scripts/verifyAdminAuditIndexes.js          # report only
 *   node src/scripts/verifyAdminAuditIndexes.js --sync   # create / reconcile
 */

const mongoose = require('mongoose');
require('dotenv').config();

const AdminAuditLog = require('../models/AdminAuditLog');

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const dbName = process.env.DB_NAME || 'suparank';
  await mongoose.connect(uri, { dbName });
  console.log(`Connected to MongoDB (db: ${dbName})\n`);

  if (process.argv.includes('--sync')) {
    console.log('Syncing AdminAuditLog indexes (create missing, drop stale)…');
    await AdminAuditLog.syncIndexes();
    console.log('Sync complete.\n');
  }

  let idx;
  try {
    idx = await AdminAuditLog.collection.indexes();
  } catch (err) {
    if (err.code === 26 || /ns does not exist|not found/i.test(err.message)) {
      console.error('✗ collection does not exist yet — run with --sync');
      process.exit(1);
    }
    throw err;
  }

  console.log('AdminAuditLog indexes:');
  idx.forEach((i) =>
    console.log('  ', JSON.stringify(i.key), i.expireAfterSeconds !== undefined ? `(TTL ${i.expireAfterSeconds}s)` : '')
  );

  let ok = true;
  const has = (pred, label) => {
    if (idx.find(pred)) console.log('  ✓', label);
    else { ok = false; console.error('  ✗ MISSING:', label); }
  };
  has((i) => i.key.createdAt === -1 && i.key._id === -1, 'feed { createdAt:-1, _id:-1 }');
  has((i) => i.key.actorEmail === 1 && i.key.createdAt === -1, 'by-actor { actorEmail:1, createdAt:-1 }');
  has((i) => i.key.action === 1 && i.key.createdAt === -1, 'by-action { action:1, createdAt:-1 }');
  has((i) => i.key.targetType === 1 && i.key.targetId === 1, 'by-target { targetType:1, targetId:1, createdAt:-1 }');

  const want = (AdminAuditLog.RETENTION_DAYS || 730) * 24 * 60 * 60;
  const ttl = idx.find((i) => i.expireAfterSeconds !== undefined);
  if (!ttl) { ok = false; console.error('  ✗ MISSING: TTL on createdAt'); }
  else if (ttl.expireAfterSeconds !== want) { ok = false; console.error(`  ✗ TTL is ${ttl.expireAfterSeconds}s, expected ${want}s`); }
  else if (JSON.stringify(ttl.key) !== JSON.stringify({ createdAt: 1 })) { ok = false; console.error('  ✗ TTL must be single-field on createdAt'); }
  else console.log(`  ✓ TTL ${want}s (${AdminAuditLog.RETENTION_DAYS || 730}d) on createdAt`);

  console.log('');
  if (ok) console.log('✓ All AdminAuditLog indexes present.');
  else { console.error('✗ Some indexes are missing — run with --sync to create them.'); process.exitCode = 1; }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('verifyAdminAuditIndexes failed:', err.message);
  process.exit(1);
});
