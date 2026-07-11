const mongoose = require('mongoose');

/**
 * ContentOutcome (Rec 14) — one row per content per day recording what
 * happened AFTER optimization: the content's own score, its GSC position/
 * clicks/impressions for the primary keyword, and AI visibility from the
 * tracker (when Rec 11 tracking is on). Written by the weekly outcome sweep
 * and at the end of every successful (re)analysis; read by the editor's
 * Results panel and the monthly report's before/after deltas.
 *
 * All metric fields are nullable: a snapshot is still worth taking when GSC
 * is disconnected or tracking is off (score history alone charts fine).
 *
 * `date` is UTC-day-truncated; the unique index makes "max one snapshot per
 * content per day regardless of trigger" a database guarantee, not a
 * convention. (Migration note: index is created on deploy by Mongoose
 * autoIndex / ensureIndexes.)
 */
const contentOutcomeSchema = new mongoose.Schema(
  {
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true, index: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    date: { type: Date, required: true }, // UTC midnight of the snapshot day

    overallScore: { type: Number, default: null }, // content.score at snapshot time
    gscPosition: { type: Number, default: null }, // primary keyword avg position (1 = best)
    gscClicks: { type: Number, default: null },
    gscImpressions: { type: Number, default: null },
    aiCited: { type: Boolean, default: null },
    aiMentioned: { type: Boolean, default: null },

    // Which trigger wrote this row (last writer wins within a day).
    source: { type: String, enum: ['cron', 'reanalyze', 'publish'], default: 'cron' },
  },
  { timestamps: true },
);

contentOutcomeSchema.index({ contentId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ContentOutcome', contentOutcomeSchema);
