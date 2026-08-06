/**
 * Chaos child runner — starts a real executeScan against a STALLING vendor
 * stub so the parent can SIGKILL it at a controlled point (between the
 * credit pre-deduct and settle). Not meant to be run directly.
 *
 * argv: [mongoUri, trackerId]   env: CHAOS_STALL_MS
 */

const path = require('path');
const mongoose = require('mongoose');

const [, , uri, trackerId] = process.argv;
const STALL_MS = Number(process.env.CHAOS_STALL_MS || 60_000);

// Stall every vendor call — the scan reaches "in flight" and stays there.
global.fetch = async () => {
  await new Promise((r) => setTimeout(r, STALL_MS));
  throw new Error('chaos: stalled vendor never answers');
};

(async () => {
  await mongoose.connect(uri, { dbName: 'chaos' });
  const aiTrackerController = require(path.resolve(__dirname, '../../src/controllers/aiTrackerController'));

  // Announce as soon as the scan is under way (post-claim, post-preDeduct is
  // what the parent waits an extra beat for).
  setTimeout(() => console.log('SCAN_STARTED'), 800);

  await aiTrackerController.executeScan(trackerId, null, {
    force: true, costAction: 'trackerRefreshAll', bill: true,
  });
  console.log('SCAN_FINISHED_UNEXPECTEDLY');
})().catch((e) => {
  console.error('child error:', e.message);
  process.exit(1);
});
