/**
 * Real-Mongo test tier for AI Tracker integration tests.
 *
 * Default: an in-memory mongod started by mongodb-memory-server in REPLSET
 * mode — required, not optional: creditService runs multi-document
 * transactions (startSession/withTransaction, creditService.js:214/:748)
 * and a standalone mongod rejects them.
 *
 * Override: set MONGO_TEST_URI to point at any running mongod that was
 * started with --replSet (skips the binary download entirely).
 *
 * First run without MONGO_TEST_URI downloads a mongod binary — allow a
 * generous before() timeout in suites that use this helper.
 */

const mongoose = require('mongoose');

let replset = null;
let currentUri = null;

async function connect() {
  // Match production exactly (src/config/database.js:5) — a stricter setting
  // here would make tests strip unknown query fields that prod would send.
  mongoose.set('strictQuery', false);
  if (process.env.MONGO_TEST_URI) {
    currentUri = process.env.MONGO_TEST_URI;
    await mongoose.connect(currentUri);
    return;
  }
  // Lazy require so unit-tier tests never need the package installed.
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  replset = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
      // FLAKE FIX (identified 2026-08-02 by a 24-run capture hunt): Mongo's
      // default maxTransactionLockRequestTimeoutMillis is 5ms. creditService
      // runs multi-document transactions that hold locks on `credits`; a
      // plain write from the next test (e.g. grantGeneralCredits) racing a
      // still-committing transaction failed with "Unable to acquire IX lock
      // … within 5ms" roughly 1 run in 20. Raising the wait makes the tier
      // deterministic WITHOUT masking product behaviour — production Mongo
      // is tuned separately and real contention still surfaces as retries.
      args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=5000'],
    },
  });
  currentUri = replset.getUri();
  await mongoose.connect(currentUri);
}

/** Connection string of the running test DB — for spawning CLI tools against it. */
function getUri() {
  return currentUri;
}

/** Wipe every collection between tests (keeps indexes, drops data). */
async function clear() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

async function disconnect() {
  await mongoose.disconnect();
  if (replset) {
    await replset.stop();
    replset = null;
  }
}

module.exports = { connect, clear, disconnect, getUri };
