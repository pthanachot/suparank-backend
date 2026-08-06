/**
 * Standalone in-memory MongoDB harness for hermetic backend tests.
 *
 * Unlike tests/aiTracker/helpers/db.js (which needs a replica set for
 * multi-document transactions), the sitemap paths use no transactions, so a
 * plain standalone mongod is enough and starts faster.
 *
 * Override: set MONGO_TEST_URI to reuse a running mongod and skip the binary
 * download. First run without it downloads a mongod binary — give before()
 * a generous timeout.
 */

const mongoose = require('mongoose');

let mongod = null;

async function connect() {
  // Match production (src/config/database.js) so tests don't strip query fields
  // prod would keep.
  mongoose.set('strictQuery', false);
  if (process.env.MONGO_TEST_URI) {
    await mongoose.connect(process.env.MONGO_TEST_URI);
    return;
  }
  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

/** Wipe every collection between tests (keeps indexes, drops data). */
async function clear() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

async function disconnect() {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

module.exports = { connect, clear, disconnect };
