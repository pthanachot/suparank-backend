const mongoose = require('mongoose');

/**
 * GenerationSnapshot — the settings that produced one AI run
 * (Wave 5 Phase 7, USAGE-TELEMETRY-PLAN §9).
 *
 * AgentUsageLog already records what a run COST, but it TTLs at 90 days and
 * deliberately stays narrow ("anything richer belongs in a separate analytics
 * sink" — its own schema comment). Meanwhile targetScore, maxIterations and
 * commandName were passed to the engine and discarded outright, so "does
 * anyone ever change the defaults" had no answer at all, and "which brand
 * voice wrote this article" stopped being answerable after a quarter.
 *
 * NO TTL. This is the durable half of that pair.
 *
 * RAW VALUES ONLY. Nothing here stores "kept the default" — that is computed
 * at read time against the documented defaults, so a future change to those
 * defaults reinterprets old rows correctly instead of freezing a judgement
 * made under different rules (plan §9 W5). The defaults in force are recorded
 * in the service, with their change date.
 *
 * Impersonated runs are tagged, as everywhere else, so admin "browse as"
 * activity can be excluded from tenant metrics.
 */
const generationSnapshotSchema = new mongoose.Schema(
  {
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    impersonatedBy: { type: String, default: null },

    // Persona: which voice/avatar was in force. Kept as strings — these mirror
    // AgentUsageLog's fields, and the referenced documents can be deleted while
    // this row must survive.
    voiceId: { type: String, default: null },
    avatarId: { type: String, default: null },

    // The knobs. null means "the client did not send one", which is different
    // from "the client sent the default value" — only the second is evidence
    // that someone looked at the control and left it alone.
    targetScore: { type: Number, default: null },
    maxIterations: { type: Number, default: null },
    commandName: { type: String, default: null },
    // 'sequential' | 'freeform' as sent by the editor; free-form so a new mode
    // lands as data rather than a validation error in a telemetry write.
    runMode: { type: String, default: null },

    source: { type: String, default: '' },
    runId: { type: String, default: '' },
  },
  { timestamps: true }
);

// Read paths: settings for one article; per-voice and per-avatar run tables.
generationSnapshotSchema.index({ contentId: 1, createdAt: -1 });
generationSnapshotSchema.index({ createdAt: -1 });
generationSnapshotSchema.index({ voiceId: 1 });
generationSnapshotSchema.index({ avatarId: 1 });

module.exports = mongoose.model('GenerationSnapshot', generationSnapshotSchema);
