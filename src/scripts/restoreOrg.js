/**
 * Operator tool (Phase 18D) — restore a SUSPENDED agency org, reversing the
 * lifecycleService.suspend teardown. Delegates to restoreService.restoreSuspendedOrg,
 * so behaviour is identical to the auto-restore that reconcile() runs on
 * re-subscribe. Idempotent — safe to re-run (re-drives a crashed 'restoring').
 *
 * IMPORTANT: restore flips the org to 'active'. If the agency is NOT entitled
 * again (has not re-subscribed on the platform), the next billing reconcile will
 * wind it back down. Confirm re-subscription (or expect to re-suspend) first — see
 * docs/tenant-restore-runbook.md. The dark saasMode flag makes this a no-op.
 *
 * Usage:  node src/scripts/restoreOrg.js <orgId>
 */

const mongoose = require('mongoose');
require('dotenv').config();

const { restoreSuspendedOrg } = require('../services/restoreService');

async function main() {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error('Usage: node src/scripts/restoreOrg.js <orgId>');
    process.exit(2);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'suparank' });
  console.log('Connected to MongoDB');

  const result = await restoreSuspendedOrg(orgId);
  console.log('\nRestore result:');
  console.log(JSON.stringify(result, null, 2));

  if (result.restored) {
    console.log(`\n✓ Org ${orgId} restored to active.`);
    if (result.purged) {
      console.log('  NOTE: this org was PURGED — client workspaces are gone. Reactivated as a fresh shell.');
    }
    const pending = result.clientSubsNeedingResubscribe || [];
    if (pending.length) {
      console.log(`  ${pending.length} client subscription(s) were cancelled and need MANUAL re-subscription:`);
      for (const p of pending) console.log(`    - ${p.clientEmail || '(no email)'}  workspace=${p.workspaceId || '-'}`);
    }
  } else {
    console.log(`\n✗ Not restored: ${result.reason || result.skipped}`);
  }

  await mongoose.disconnect();
  // Reflect the logical outcome in the exit code so operator automation can chain on it.
  if (!result.restored) process.exit(1);
}

main().catch((err) => {
  console.error('Restore failed:', err);
  process.exit(1);
});
