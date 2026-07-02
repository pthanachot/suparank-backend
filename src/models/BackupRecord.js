const mongoose = require('mongoose');

/**
 * BackupRecord — history of database backup runs (manual or scheduled).
 * The archive file lives on disk at `path`; `prunedAt` is set when retention
 * cleanup deletes the file (the record itself is kept as history).
 */
const backupRecordSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['running', 'success', 'failed'],
      required: true,
    },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    path: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    error: { type: String, default: null },
    triggeredBy: { type: String, default: null }, // admin email or 'schedule'
    prunedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

backupRecordSchema.index({ startedAt: -1 });

module.exports = mongoose.model('BackupRecord', backupRecordSchema);
