const mongoose = require('mongoose');

const platformStatusSchema = new mongoose.Schema({
  platformId: { type: String, required: true },
  status: { type: String, enum: ['completed', 'scanning', 'queued'], default: 'queued' },
}, { _id: false });

const aiTrackerSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
  },
  domain: { type: String, required: true, trim: true },
  defaultModels: { type: [String], default: ['chatgpt', 'gemini', 'claude', 'perplexity'] },
  scanCadence: { type: String, default: 'weekly' },
  scanStatus: {
    type: String,
    enum: ['idle', 'pending', 'scanning', 'ready', 'failed'],
    default: 'idle',
  },
  scanProgress: { type: Number, default: 0, min: 0, max: 100 },
  scanError: { type: String, default: null },
  platformStatuses: { type: [platformStatusSchema], default: [] },
  lastScanAt: { type: Date, default: null },
  nextScanAt: { type: Date, default: null },
  currentScanId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiTrackerScan', default: null },
}, { timestamps: true });

aiTrackerSchema.index({ workspaceId: 1 }, { unique: true });
aiTrackerSchema.index({ nextScanAt: 1, scanStatus: 1 });

aiTrackerSchema.methods.toTrackerState = function () {
  return {
    id: this._id.toString(),
    domain: this.domain,
    createdAt: this.createdAt.toISOString(),
    scanCadence: this.scanCadence,
    lastScanAt: this.lastScanAt ? this.lastScanAt.toISOString() : null,
    nextScanAt: this.nextScanAt ? this.nextScanAt.toISOString() : null,
    scanStatus: this.scanStatus,
    scanProgress: this.scanProgress,
    defaultModels: this.defaultModels,
  };
};

module.exports = mongoose.model('AiTracker', aiTrackerSchema);
