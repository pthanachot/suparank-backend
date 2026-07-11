const mongoose = require('mongoose');

/**
 * Opportunity — a lifecycle-tracked SEO improvement surfaced from a data source
 * (GSC striking-distance, GSC decay; ai_citation_gap reserved for v2). The row
 * carries the state machine (open → applied → recovered, or → dismissed) and a
 * metrics snapshot from the last refresh. Display data is joined fresh from the
 * source each fetch; this row is the durable status + before/after timeline
 * (appliedAt/recoveredAt) that Rec 14's outcome tracking reads as a query.
 *
 * Identity is (workspaceId, source, query, page). For gsc_striking rows the
 * opportunity is about the QUERY (which page ranks can vary refresh to refresh),
 * so page is '' — the live ranking page is passed through in the API response,
 * not baked into identity. For gsc_decay rows page is the declining URL.
 */
const opportunitySchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    // Nullable: site-wide striking rows have no content until one is created.
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', default: null, index: true },
    source: {
      type: String,
      enum: ['gsc_striking', 'gsc_decay', 'ai_citation_gap'],
      required: true,
    },
    query: { type: String, default: '' },
    page: { type: String, default: '' },
    // Decay display keyword (the page's current top query). NOT part of identity:
    // a page's top query drifts refresh-to-refresh, so keying on it would spawn a
    // new row (and un-dismiss / un-apply the page) every time it changes. Decay
    // identity is the page; this field is refreshed in place for display + goals.
    topQuery: { type: String, default: '' },
    status: {
      type: String,
      enum: ['open', 'applied', 'dismissed', 'recovered'],
      default: 'open',
      index: true,
    },
    appliedAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null },
    recoveredAt: { type: Date, default: null },
    // Snapshot at last refresh (shape mirrors rankStrikingDistance output).
    metrics: {
      position: { type: Number, default: null },
      impressions: { type: Number, default: null },
      clicks: { type: Number, default: null },
      opportunity: { type: Number, default: null },
      potentialClicks: { type: Number, default: null },
    },
  },
  { timestamps: true },
);

// One row per (workspace, source, query, page); page '' for striking rows.
opportunitySchema.index({ workspaceId: 1, source: 1, query: 1, page: 1 }, { unique: true });

module.exports = mongoose.model('Opportunity', opportunitySchema);
