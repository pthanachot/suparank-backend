const mongoose = require('mongoose');

// Guardrail: a stale env file silently pointing this server at the wrong
// cluster must scream at boot. Substring match (case-insensitive, trimmed —
// the driver lowercases hosts) against the resolved per-shard hostname,
// ac-<token>-shard-00-0N.<projecthash>.mongodb.net. NOTE: the <projecthash>
// suffix is per Atlas PROJECT, not per cluster — two clusters in one project
// share it. To tell same-project clusters apart, use the per-cluster
// 'ac-<token>' prefix (copy it from the "MongoDB connected:" boot log line),
// or put the new cluster in its own project.
// Unset/blank EXPECTED_DB_HOST disables the check.
function hostMismatch(actualHost, expectedHost) {
  const expected = String(expectedHost || '').trim().toLowerCase();
  if (!expected) return false;
  return !String(actualHost || '').toLowerCase().includes(expected);
}

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', false);

    const options = {
      dbName: process.env.DB_NAME || 'suparank',
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      retryWrites: true,
      retryReads: true,
    };

    console.log(`Connecting to MongoDB (${options.dbName})...`);
    const conn = await mongoose.connect(process.env.MONGODB_URI, options);
    console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);

    if (hostMismatch(conn.connection.host, process.env.EXPECTED_DB_HOST)) {
      console.warn('================================================');
      console.warn(`[db] WARNING: connected host '${conn.connection.host}' does not`);
      console.warn(`[db] match EXPECTED_DB_HOST '${process.env.EXPECTED_DB_HOST}'.`);
      console.warn('[db] A stale MONGODB_URI may be pointing this server at the wrong cluster.');
      console.warn('================================================');
    }

    // Sync indexes to drop stale unique constraints
    const Avatar = require('../models/Avatar');
    await Avatar.syncIndexes();
    const AiTracker = require('../models/AiTracker');
    await AiTracker.syncIndexes();
    console.log('[db] AiTracker indexes synced');
    // Rec 14: the unique {contentId, date} index IS the one-snapshot-per-day
    // guarantee — sync explicitly rather than relying on autoIndex.
    const ContentOutcome = require('../models/ContentOutcome');
    await ContentOutcome.syncIndexes();
    console.log('[db] ContentOutcome indexes synced');

    return conn;
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    throw error;
  }
};

const checkConnectionHealth = () => {
  const state = mongoose.connection.readyState;
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

  return {
    state: states[state] || 'unknown',
    isConnected: state === 1,
    host: mongoose.connection.host,
    name: mongoose.connection.name,
    // Surfaced on /health so a wrong-cluster deploy is visible remotely, not
    // just in boot logs. True when EXPECTED_DB_HOST is unset (check disabled).
    expectedHostMatch: !hostMismatch(mongoose.connection.host, process.env.EXPECTED_DB_HOST),
  };
};

module.exports = { connectDB, checkConnectionHealth, hostMismatch };
