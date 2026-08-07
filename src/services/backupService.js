/**
 * backupService — runs `mongodump` against MONGODB_URI and records history
 * in BackupRecord. Archives land in the admin-configured directory
 * (SystemSettings.backup.directory) or <backend>/backups by default.
 * Retention keeps the newest N archives on disk; older files are deleted
 * but their history records remain (marked prunedAt).
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const BackupRecord = require('../models/BackupRecord');
const { getSettings } = require('./systemSettingsService');

const execFileAsync = promisify(execFile);

const DEFAULT_DIR = path.join(process.cwd(), 'backups');
const DUMP_TIMEOUT_MS = 15 * 60 * 1000;
// Hard ceiling for 'running' records when a dump IS in flight in this
// process (the 15-min exec timeout normally settles the record well before).
const STALE_RUNNING_MS = 20 * 60 * 1000;
// When this process is idle, any 'running' record is an orphan from a
// crashed/restarted run — reconcile after a short grace period.
const ORPHAN_GRACE_MS = 60 * 1000;

let running = false;

function effectiveDirectory() {
  return getSettings().backup?.directory || DEFAULT_DIR;
}

function isRunning() {
  return running;
}

// Strip connection strings (credentials) from error text before persisting
function sanitize(text) {
  if (!text) return text;
  return String(text).replace(/mongodb(\+srv)?:\/\/\S+/g, '<mongodb-uri>');
}

// Normalize a connection string to path-less form (query string preserved).
// The app ignores any database in the URI path (the dbName connect option
// wins), but mongodump errors when --db names a DIFFERENT database than the
// URI path — so a URI like mongodb+srv://host/otherdb?x would break backups
// while the app itself runs fine. Stripping the path keeps the dump pinned to
// the same database the app actually uses (mismatches are warned about at the
// call site, since stripping also removes mongodump's own mismatch error).
function stripUriPath(uri) {
  if (!uri) return uri;
  return String(uri).replace(/^((mongodb(?:\+srv)?):\/\/[^/?]+)\/[^?]*/, '$1/');
}

async function markStaleRunning() {
  // Records are only created after `running` flips true and settle before it
  // flips back — so when this process is idle, a 'running' record can only be
  // an orphan (server crashed/restarted mid-dump). Reconcile it after a short
  // grace instead of leaving the UI locked for the full stale window. The
  // grace covers out-of-process runs (e.g. maintenance scripts).
  const cutoff = running ? STALE_RUNNING_MS : ORPHAN_GRACE_MS;
  await BackupRecord.updateMany(
    { status: 'running', startedAt: { $lt: new Date(Date.now() - cutoff) } },
    { $set: { status: 'failed', error: 'Interrupted (server restart or timeout)', finishedAt: new Date() } }
  );
}

async function pruneOldBackups() {
  const keep = getSettings().backup?.retentionCount ?? 7;
  const stale = await BackupRecord.find({ status: 'success', prunedAt: null })
    .sort({ startedAt: -1 })
    .skip(keep)
    .lean();
  for (const rec of stale) {
    try {
      if (rec.path && fs.existsSync(rec.path)) fs.unlinkSync(rec.path);
      await BackupRecord.updateOne({ _id: rec._id }, { $set: { prunedAt: new Date() } });
    } catch (err) {
      console.error(`[backup] prune failed for ${rec.path}:`, err.message);
    }
  }
  return stale.length;
}

async function runBackup(triggeredBy) {
  if (running) {
    const err = new Error('A backup is already running');
    err.code = 'BACKUP_RUNNING';
    throw err;
  }
  running = true;

  const dir = effectiveDirectory();
  const dbName = process.env.DB_NAME || 'suparank';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // db name in the filename so archives from different databases/clusters
  // stay distinguishable on disk (e.g. across a DB migration); basename() so
  // a mis-set DB_NAME (e.g. 'a/b') can never write outside the backup dir.
  const file = path.join(dir, `${path.basename(dbName)}-${stamp}.archive.gz`);
  const record = await BackupRecord.create({
    status: 'running',
    startedAt: new Date(),
    path: file,
    triggeredBy: triggeredBy || null,
  });

  try {
    fs.mkdirSync(dir, { recursive: true });

    // --db pins the dump to the app database. The URI is normalized to
    // path-less form first (see stripUriPath) so --db stays valid even if
    // someone sets a URI with a database path.
    const uriDb = (process.env.MONGODB_URI || '').match(/^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]+)/);
    if (uriDb && uriDb[1] !== dbName) {
      console.warn(`[backup] MONGODB_URI path names '${uriDb[1]}' but DB_NAME is '${dbName}' — dumping '${dbName}', the database the app uses`);
    }
    const args = ['--uri', stripUriPath(process.env.MONGODB_URI), '--db', dbName, `--archive=${file}`, '--gzip'];
    await execFileAsync('mongodump', args, { timeout: DUMP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });

    record.status = 'success';
    record.finishedAt = new Date();
    record.sizeBytes = fs.statSync(file).size;
    await record.save();
    console.log(`[backup] Completed: ${file} (${record.sizeBytes} bytes) by ${triggeredBy || 'unknown'}`);

    pruneOldBackups().catch((err) => console.error('[backup] prune error:', err.message));
    return record;
  } catch (err) {
    // Remove any partial archive so retention never keeps a corrupt file
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
    const message =
      err.code === 'ENOENT'
        ? 'mongodump not found on this server — install mongodb-database-tools'
        : sanitize(err.message).slice(0, 500);
    record.status = 'failed';
    record.finishedAt = new Date();
    record.error = message;
    await record.save();
    console.error(`[backup] Failed: ${message}`);
    return record;
  } finally {
    running = false;
  }
}

async function listBackups(limit = 10) {
  await markStaleRunning();
  return BackupRecord.find().sort({ startedAt: -1 }).limit(limit).lean();
}

module.exports = { runBackup, listBackups, effectiveDirectory, isRunning, pruneOldBackups, stripUriPath };
