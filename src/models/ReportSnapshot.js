const mongoose = require('mongoose');

/**
 * Monthly workspace performance report (Phase 14).
 *
 * One snapshot per {workspaceId, period} — regeneration upserts in place
 * (idempotent). `data` is a denormalized, display-ready aggregate built by
 * reportService.generateSnapshot from Content, AiTracker/AiTrackerScan and
 * locally-stored GSC snapshot stats (Site.snapshotStats). Report generation
 * NEVER calls external APIs — it only reads what is already in Mongo.
 *
 * data shape:
 *   {
 *     workspaceName,
 *     content: null | { total, createdInPeriod, avgScore, scoredCount,
 *                       topContent: [{ contentNumber, title, score, wordCount }] },
 *     tracker: null | { monitors, scansInPeriod,
 *                       latest: null | { visibility, mentionRate, shareOfVoice, scannedAt },
 *                       monitorsDetail: [{ name, domain, scansInPeriod,
 *                         latest: null | { visibility, mentionRate, shareOfVoice, scannedAt } }],
 *                       // Phase 3 enrichment — keys ABSENT when no monitor has a scan.
 *                       // All bounded: prompts ≤20 rows, competitors ≤1+10, citations ≤10,
 *                       // highlights ≤3 (one per kind), excerpts ±200 chars, never full answers.
 *                       engines?: [{ platformId, prompts, mentioned, cited, visibility }],
 *                       funnel?: { prompts, mentioned, cited },   // prompt-level: named vs linked
 *                       competitors?: [{ name, mentions, citations, visibility, isOwn }],
 *                       citationsWon?: [{ url, prompt, platformId }],
 *                       highlights?: [{ kind: 'win'|'competitor'|'absence', prompt,
 *                                       platformId, excerpt, competitor? }],
 *                       promptsDetail?: { totalTracked, rows: [{ prompt, monitor?, visibility,
 *                         engines: [{ platformId, mentioned, cited, position }] }] },
 *                       // Phase 4 — every trend point is a REAL scan (no synthetic
 *                       // zeros for scanless gaps); baseline = last pre-period scan,
 *                       // flagged in trend and merged for delta anchoring. ≤31
 *                       // points/monitor (true count in monitorsDetail.scansInPeriod).
 *                       baseline?: { visibility, mentionRate, shareOfVoice, scannedAt },
 *                       trend?: [{ monitor?, date, visibility, mentionRate, shareOfVoice,
 *                                  citationRate, sentiment, baseline?: true }],
 *                       promptSuggestions?: [string] },  // weakest prompt, ≤6
 *     opportunities: null | [{ source: 'ai_citation_gap'|'gsc_striking',
 *                              query, page, potentialClicks }],  // ≤3, AEO gaps first
 *     deltas: null | {  // vs previous period; each side only when real
 *       tracker: null | { visibility|mentionRate|shareOfVoice:
 *                           { current, previous, delta } },
 *       gsc:     null | { clicks|impressions: { current, previous, delta } },
 *       content: null | { createdInPeriod: { current, previous, delta } } },
 *     commentary?: string,  // Phase 5 — freelancer-written narrative, ≤1500
 *                           // chars, plain text. Edited via the commentary-only
 *                           // $set path (never re-aggregates a past period);
 *                           // full regenerates carry it forward.
 *     gsc:     null | { sites, clicks, impressions, avgCtr, avgPosition, updatedAt,
 *                       dataThrough?: 'YYYY-MM-DD',  // period path: min complete
 *                                                    // coverage across sites
 *                       topQueries?: [{ query, clicks, impressions, ctr, position }],
 *                       approximate?: true },  // true = snapshotStats fallback,
 *                                              // NOT period-scoped data

 *     sourceErrors?: [{ source, error }]   // present only when a source failed
 *   }
 */
const reportSnapshotSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    // Calendar month, e.g. '2026-06'
    period: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    generatedAt: { type: Date, default: Date.now },
    // Set once the monthly cron has sent this report's emails. The cron's
    // dedupe key is "snapshot exists AND reportEmailedAt set" — so a snapshot
    // generated manually (or a crash between generate and email) still gets
    // its monthly email on the next cron run, and re-runs never double-send.
    reportEmailedAt: { type: Date, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// One report per workspace per month — regeneration upserts
reportSnapshotSchema.index({ workspaceId: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('ReportSnapshot', reportSnapshotSchema);
