/**
 * Tests for backupService — success/failure recording, credential
 * sanitization, partial-file cleanup, concurrency guard, and orphan
 * reconciliation cutoffs. child_process.execFile is stubbed before the
 * service loads (promisify captures it at require time); settings and the
 * BackupRecord model are faked. No mongodump, no database.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suparank-backup-test-'));

// ── Stub child_process.execFile BEFORE the service loads ──────
const cp = require('child_process');
const realExecFile = cp.execFile;
const execState = { fail: null, delayMs: 0, calls: [] };

cp.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  execState.calls.push({ cmd, args });
  const archiveArg = (args || []).find((a) => String(a).startsWith('--archive='));
  const file = archiveArg ? archiveArg.slice('--archive='.length) : null;
  setTimeout(() => {
    // Write the file even on failure — proves the partial-file cleanup path
    if (file) fs.writeFileSync(file, 'FAKEDUMP');
    if (execState.fail) return cb(execState.fail);
    cb(null, '', '');
  }, execState.delayMs);
};

// ── Fake settings (directory → tmp, retention 2) ───────────────
const settingsState = {
  settings: { backup: { directory: TMP_DIR, retentionCount: 2 } },
};
require.cache[require.resolve('../src/services/systemSettingsService')] = {
  exports: {
    getSettings: () => settingsState.settings,
    updateSettings: async () => settingsState.settings,
    loadSettings: async () => settingsState.settings,
    onSettingsChange: () => {},
    DEFAULTS: {},
  },
};

const backupService = require('../src/services/backupService');
const BackupRecord = require('../src/models/BackupRecord');

// ── Fake BackupRecord statics ──────────────────────────────────
const db = { records: [], updateManyCalls: [] };

BackupRecord.create = async (fields) => {
  const rec = {
    ...fields,
    _id: `rec-${db.records.length + 1}`,
    async save() {
      /* fields mutated in place; nothing to persist */
    },
  };
  db.records.push(rec);
  return rec;
};
BackupRecord.updateMany = async (filter, update) => {
  db.updateManyCalls.push({ filter, update });
  return { modifiedCount: 0 };
};
BackupRecord.updateOne = async () => ({});
BackupRecord.find = () => ({
  sort: () => ({
    skip: () => ({ lean: async () => [] }),
    limit: () => ({ lean: async () => db.records }),
  }),
});

after(() => {
  cp.execFile = realExecFile;
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  execState.fail = null;
  execState.delayMs = 0;
  execState.calls = [];
  db.records = [];
  db.updateManyCalls = [];
  process.env.MONGODB_URI = 'mongodb+srv://testuser:secretpass@example.mongodb.net/';
  process.env.DB_NAME = 'suparank';
});

// ── Tests ──────────────────────────────────────────────────────

describe('runBackup', () => {
  it('records a successful dump with size and prunes afterwards', async () => {
    const rec = await backupService.runBackup('tester@x.com');
    assert.equal(rec.status, 'success');
    assert.equal(rec.sizeBytes, 'FAKEDUMP'.length);
    assert.equal(rec.triggeredBy, 'tester@x.com');
    assert.ok(fs.existsSync(rec.path), 'archive file should exist');
    const args = execState.calls[0].args;
    assert.ok(args.includes('--db') && args.includes('suparank'), 'dump scoped to the app db');
    assert.ok(args.includes('--gzip'));
  });

  it('passes a path-less URI to mongodump even when MONGODB_URI carries a db path', async () => {
    process.env.MONGODB_URI = 'mongodb+srv://testuser:secretpass@example.mongodb.net/otherdb?retryWrites=true';
    const rec = await backupService.runBackup('tester@x.com');
    assert.equal(rec.status, 'success');
    const args = execState.calls[0].args;
    const uriIdx = args.indexOf('--uri');
    assert.equal(
      args[uriIdx + 1],
      'mongodb+srv://testuser:secretpass@example.mongodb.net/?retryWrites=true',
      'URI path must be stripped so --db stays valid'
    );
  });

  it('names the archive after DB_NAME so per-database dumps stay distinguishable', async () => {
    process.env.DB_NAME = 'cutovertest';
    const rec = await backupService.runBackup('tester@x.com');
    assert.ok(
      path.basename(rec.path).startsWith('cutovertest-'),
      `archive should be named after the db, got ${path.basename(rec.path)}`
    );
    const args = execState.calls[0].args;
    assert.ok(args.includes('--db') && args.includes('cutovertest'), 'dump scoped to DB_NAME');
  });

  it('marks failures, removes the partial file, and sanitizes credentials', async () => {
    execState.fail = new Error(
      `connection refused for mongodb+srv://testuser:secretpass@example.mongodb.net/ (auth failed)`
    );
    const rec = await backupService.runBackup('tester@x.com');
    assert.equal(rec.status, 'failed');
    assert.ok(!fs.existsSync(rec.path), 'partial archive must be deleted');
    assert.ok(rec.error.includes('<mongodb-uri>'), 'URI should be redacted');
    assert.ok(!rec.error.includes('secretpass'), 'credentials must never be persisted');
  });

  it('maps ENOENT to the human "install mongodb-database-tools" message', async () => {
    execState.fail = Object.assign(new Error('spawn mongodump ENOENT'), { code: 'ENOENT' });
    const rec = await backupService.runBackup('tester@x.com');
    assert.equal(rec.status, 'failed');
    assert.match(rec.error, /mongodump not found/i);
  });

  it('rejects a second run while one is in flight (BACKUP_RUNNING)', async () => {
    execState.delayMs = 50;
    const first = backupService.runBackup('one@x.com');
    await assert.rejects(() => backupService.runBackup('two@x.com'), (err) => err.code === 'BACKUP_RUNNING');
    const rec = await first;
    assert.equal(rec.status, 'success');
    assert.equal(backupService.isRunning(), false, 'flag must clear after completion');
  });

  it('allows a new run after a failure (finally clears the flag)', async () => {
    execState.fail = new Error('boom');
    await backupService.runBackup('a@x.com');
    execState.fail = null;
    const rec = await backupService.runBackup('b@x.com');
    assert.equal(rec.status, 'success');
  });
});

describe('stripUriPath', () => {
  const { stripUriPath } = backupService;

  it('strips a database path while preserving the query string', () => {
    assert.equal(
      stripUriPath('mongodb+srv://u:p@example.mongodb.net/somedb?retryWrites=true'),
      'mongodb+srv://u:p@example.mongodb.net/?retryWrites=true'
    );
  });

  it('leaves a path-less URI unchanged', () => {
    assert.equal(
      stripUriPath('mongodb+srv://u:p@example.mongodb.net/?retryWrites=true'),
      'mongodb+srv://u:p@example.mongodb.net/?retryWrites=true'
    );
    assert.equal(stripUriPath('mongodb://localhost:27017'), 'mongodb://localhost:27017');
  });

  it('handles multi-host mongodb:// URIs', () => {
    assert.equal(
      stripUriPath('mongodb://h1:27017,h2:27018/mydb?replicaSet=rs0'),
      'mongodb://h1:27017,h2:27018/?replicaSet=rs0'
    );
  });
});

describe('orphan reconciliation (markStaleRunning via listBackups)', () => {
  it('uses the short grace cutoff (~60s) when this process is idle', async () => {
    await backupService.listBackups(5);
    assert.equal(db.updateManyCalls.length, 1);
    const { filter, update } = db.updateManyCalls[0];
    assert.equal(filter.status, 'running');
    const cutoffAge = Date.now() - filter.startedAt.$lt.getTime();
    assert.ok(cutoffAge >= 55_000 && cutoffAge <= 70_000, `idle cutoff should be ~60s, got ${cutoffAge}ms`);
    assert.equal(update.$set.status, 'failed');
  });

  it('uses the long stale ceiling (~20min) while a dump is in flight', async () => {
    execState.delayMs = 60;
    const run = backupService.runBackup('busy@x.com');
    await new Promise((r) => setTimeout(r, 10)); // let the run start
    await backupService.listBackups(5);
    const { filter } = db.updateManyCalls[db.updateManyCalls.length - 1];
    const cutoffAge = Date.now() - filter.startedAt.$lt.getTime();
    assert.ok(cutoffAge >= 19 * 60_000, `in-flight cutoff should be ~20min, got ${cutoffAge}ms`);
    await run;
  });
});
