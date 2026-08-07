#!/usr/bin/env node
/**
 * preflightDb — go/no-go check of a MongoDB target BEFORE the app boots
 * against it. Boot is not read-only (connectDB runs syncIndexes, index.js
 * resets stuck scans, configSync seeds settings), so a wrong-but-reachable
 * target gets written to on the first start. Run this first.
 *
 * Checks:
 *   1. Connectivity + identity — resolved host and database name.
 *   2. Topology — replica set or mongos; creditService transactions fail on a
 *      standalone mongod.
 *   3. A real read-only transaction probe (the actual failure mode, not just
 *      the topology flag).
 *   4. Sentinel collection counts — an empty or unfamiliar database is
 *      obvious before boot. A brand-new (pre-restore) target is expected to
 *      be empty: pass --expect-empty.
 *   5. mongodb-database-tools presence and version vs the server version, so
 *      a dump/restore incompatibility surfaces here, not on cutover night.
 *
 * Read-only by design: this script must only look.
 *
 * Usage:
 *   node scripts/preflightDb.js                 # target from backend/.env
 *   MONGODB_URI='mongodb+srv://…' DB_NAME=suparank node scripts/preflightDb.js
 *                                               # explicit target (dotenv never
 *                                               # overrides real env vars)
 *   node scripts/preflightDb.js --expect-empty  # new cluster, before restore
 *
 * Exit codes: 0 = GO, 1 = NO-GO, 2 = could not connect / bad invocation.
 */

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Minimum mongodb-database-tools version per server major version, per the
// tools compatibility matrix. Majors below 6 work with any 100.x release.
const MIN_TOOLS_FOR_SERVER = { 6: '100.6.0', 7: '100.7.3', 8: '100.10.0' };

const SENTINEL_COLLECTIONS = [
  'users',
  'organizations',
  'workspaces',
  'contents',
  'subscriptions',
  'aitrackers',
  'systemsettings',
];

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// mongodump --version prints e.g. "mongodump version: 100.9.4\ngit version: …"
function parseToolsVersion(stdout) {
  const m = String(stdout).match(/mongodump version:\s*([\d.]+)/);
  return m ? m[1] : null;
}

// Returns the minimum tools version for a server version, or null when the
// matrix has no entry (old server: anything works; unknown new major: caller
// must warn rather than assume).
function minToolsForServer(serverVersion) {
  const major = Number(String(serverVersion).split('.')[0]);
  if (!Number.isFinite(major)) return null;
  if (major < 6) return '100.0.0';
  return MIN_TOOLS_FOR_SERVER[major] || null;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const mongoose = require('mongoose');

  const unknownArgs = process.argv.slice(2).filter((a) => a !== '--expect-empty');
  if (unknownArgs.length) {
    console.error(`Unknown argument(s): ${unknownArgs.join(' ')} — only --expect-empty is supported.`);
    process.exit(2);
  }
  const expectEmpty = process.argv.includes('--expect-empty');
  const dbName = process.env.DB_NAME || 'suparank';
  const failures = [];
  const warnings = [];
  const ok = (msg) => console.log(`  ✓ ${msg}`);
  const bad = (msg) => {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  };
  const warn = (msg) => {
    warnings.push(msg);
    console.log(`  ! ${msg}`);
  };
  // On cutover night "your credentials are too narrow" and "this is the wrong
  // cluster" demand different reactions — label auth errors explicitly.
  const authHint = (err) =>
    err.code === 13 || /not authorized/i.test(err.message || '')
      ? `${err.message} (authorization too narrow for this check — not a wrong-target signal)`
      : err.message;

  if (!process.env.MONGODB_URI) {
    console.error('Set MONGODB_URI (in .env or the environment) to run this preflight.');
    process.exit(2);
  }

  console.log('── 1. Connectivity ──');
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName,
      serverSelectionTimeoutMS: 8000,
    });
  } catch (err) {
    console.error(`  ✗ Connection failed: ${err.message.replace(/mongodb(\+srv)?:\/\/\S+/g, '<mongodb-uri>')}`);
    process.exit(2);
  }
  ok(`Connected: ${mongoose.connection.host} / db '${mongoose.connection.name}'`);

  const admin = mongoose.connection.db.admin();

  console.log('── 2. Topology ──');
  let serverVersion = null;
  try {
    let hello;
    try {
      hello = await admin.command({ hello: 1 });
    } catch (err) {
      // `hello` exists only on MongoDB >= 4.4 — fall back to the legacy name
      // so an old-but-healthy replica set is not misreported as a failure.
      if (err.code === 59 || err.codeName === 'CommandNotFound') hello = await admin.command({ isMaster: 1 });
      else throw err;
    }
    if (hello.setName) ok(`Replica set '${hello.setName}' — transactions supported`);
    else if (hello.msg === 'isdbgrid') ok('Sharded cluster (mongos) — transactions supported');
    else bad('STANDALONE server — creditService transactions will fail; use Atlas or a replica set');
  } catch (err) {
    bad(`Topology check failed: ${authHint(err)}`);
  }
  try {
    const info = await admin.command({ buildInfo: 1 });
    serverVersion = info.version;
    ok(`Server version ${serverVersion}`);
  } catch (err) {
    // buildInfo only feeds the advisory tools check — never a NO-GO by itself.
    warn(`Server version unavailable (${err.message}) — verify tools compatibility manually`);
  }

  console.log('── 3. Transaction probe (read-only) ──');
  const session = mongoose.connection.getClient().startSession();
  try {
    await session.withTransaction(async () => {
      await mongoose.connection.db.collection('users').findOne({}, { session });
    });
    ok('Read-only transaction committed');
  } catch (err) {
    bad(`Transaction probe failed: ${err.message}`);
  } finally {
    await session.endSession();
  }

  console.log('── 4. Sentinel collections ──');
  try {
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    ok(`${names.length} collections present`);
    let total = 0;
    for (const name of SENTINEL_COLLECTIONS) {
      const count = names.includes(name)
        ? await mongoose.connection.db.collection(name).estimatedDocumentCount()
        : 0;
      total += count;
      console.log(`      ${name.padEnd(16)} ${count}`);
    }
    if (total === 0 && !expectEmpty) {
      bad("Sentinel collections are all empty — wrong target, or restore not done (pass --expect-empty if a fresh cluster is intended)");
    } else if (total === 0) {
      ok('Empty target — accepted (--expect-empty)');
    } else if (expectEmpty) {
      warn(`--expect-empty was passed but the target holds ${total} sentinel documents`);
    } else {
      ok(`${total} documents across sentinel collections`);
    }
  } catch (err) {
    bad(`Sentinel check failed: ${authHint(err)}`);
  }

  console.log('── 5. mongodb-database-tools ──');
  try {
    const { stdout } = await execFileAsync('mongodump', ['--version'], { timeout: 10_000 });
    const toolsVersion = parseToolsVersion(stdout);
    if (!toolsVersion) {
      warn('Could not parse mongodump version output — verify tools compatibility manually');
    } else if (!serverVersion) {
      warn(`mongodump ${toolsVersion} installed, but server version unknown — verify compatibility manually`);
    } else {
      const min = minToolsForServer(serverVersion);
      if (min === null) {
        warn(`mongodump ${toolsVersion} vs server ${serverVersion}: no matrix entry for this server major — verify compatibility manually`);
      } else if (compareVersions(toolsVersion, min) >= 0) {
        ok(`mongodump ${toolsVersion} is compatible with server ${serverVersion} (needs >= ${min})`);
      } else {
        bad(`mongodump ${toolsVersion} is too old for server ${serverVersion} — upgrade mongodb-database-tools to >= ${min}`);
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') bad('mongodump not found — install mongodb-database-tools');
    else bad(`Tools check failed: ${err.message}`);
  }

  // A failed disconnect must not eat the verdict — the report below is the
  // whole point of the run, and process exit closes sockets anyway.
  await mongoose.disconnect().catch(() => {});

  console.log('');
  if (failures.length === 0) {
    console.log(`GO — all checks passed${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`);
    process.exit(0);
  }
  console.log(`NO-GO — ${failures.length} failure${failures.length > 1 ? 's' : ''}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

module.exports = { compareVersions, parseToolsVersion, minToolsForServer, SENTINEL_COLLECTIONS };

if (require.main === module) {
  main().catch((err) => {
    console.error('preflightDb crashed:', err);
    process.exit(2);
  });
}
