const ObservationEvent = require('../models/ObservationEvent');

// Phase 7.3 — server-side allow-set is the enforcement point: the client
// batches arbitrary {event, ts, payload} and drops on non-2xx, so we admit only
// known event names and silently ignore the rest (still returning 2xx so the
// best-effort client never loud-fails).
const ALLOWED_EVENTS = new Set([
  // Plan-mode observations (already emitted by the frontend usePlanMode sink).
  'plan_proposed',
  'drift_observed',
  'time_to_approval',
  'plan_approval_rate',
  // Phase 7 product metrics.
  'ai_edit_applied',      // { rung, workspaceNumber, contentNumber }
  'ai_edit_reverted',     // { rung, scope, ... }
  'time_to_first_word',   // { ms, ... }
  'analysis_recovered',   // { attempts, ... } — emitted backend-side
]);

const MAX_EVENTS = 50;

// Coerce a string-or-number id to a finite number, else null. The editor's
// workspaceNumber/contentNumber props are strings, so a strict typeof check
// would drop them.
const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * POST /api/observe — ingest a batch of observation events.
 * Body: { events: Array<{ event: string; ts?: number; payload?: object }> }.
 * Unknown events are ignored; the response is always 2xx (best-effort client).
 */
async function ingestObservations(req, res) {
  try {
    const raw = Array.isArray(req.body?.events) ? req.body.events.slice(0, MAX_EVENTS) : [];
    const userId = req.user?.userId || null;

    const docs = [];
    for (const e of raw) {
      if (!e || typeof e.event !== 'string' || !ALLOWED_EVENTS.has(e.event)) continue;
      const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
      docs.push({
        event: e.event,
        payload,
        userId,
        organizationId: payload.orgId || null,
        workspaceNumber: toNum(payload.workspaceNumber),
        contentNumber: toNum(payload.contentNumber),
        ts: toNum(e.ts),
      });
    }

    if (docs.length) {
      // ordered:false + swallow — a metrics write must never break a user flow.
      await ObservationEvent.insertMany(docs, { ordered: false }).catch(() => {});
    }
    res.json({ ok: true, stored: docs.length });
  } catch (err) {
    console.error('ingestObservations error:', err.message);
    res.json({ ok: false, stored: 0 }); // best-effort: never surface an error
  }
}

/** Server-side helper so backend code (e.g. analysis retries) can record an
 *  observation directly, bypassing the HTTP client. Fire-and-forget. */
function recordObservation(event, payload = {}, userId = null) {
  if (!ALLOWED_EVENTS.has(event)) return;
  ObservationEvent.create({
    event,
    payload,
    userId: userId || null,
    organizationId: payload.orgId || null,
    workspaceNumber: toNum(payload.workspaceNumber),
    contentNumber: toNum(payload.contentNumber),
    ts: Date.now(),
  }).catch(() => {});
}

module.exports = { ingestObservations, recordObservation, ALLOWED_EVENTS };
