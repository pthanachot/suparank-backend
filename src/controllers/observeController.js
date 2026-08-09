const ObservationEvent = require('../models/ObservationEvent');

// Phase 7.3 — the server-side allow-set is the enforcement point: the client
// batches arbitrary {event, ts, payload} and drops on non-2xx, so we admit only
// known event names and silently ignore the rest (still returning 2xx so the
// best-effort client never loud-fails).
// Wave 0 (§3.2): the set itself now lives in the analytics event registry —
// adding an event is a one-line registry change, covered by a conformance test
// that parses the frontend's emit sites.
const { ALLOWED_EVENTS } = require('../config/analyticsEvents');

const MAX_EVENTS = 50;
// Wave 0 review (F6): payload is Mixed under a 10MB body limit — without a cap,
// one authed user at the 30/min limiter ceiling could push ~300MB/min into
// Mongo. Oversized payloads are replaced, not dropped: the event still counts.
const MAX_PAYLOAD_BYTES = 4096;

// Wave 0 review (F2): organizationId is DERIVED from workspaceNumber, never
// taken from the client — payload.orgId was client-controlled, so any authed
// user could attribute events to any org, and the daily rollups make that
// attribution durable. (Audit: no frontend emit ever actually sent orgId, so
// nothing is lost.) Small TTL cache: workspace→org is stable and batches
// repeat the same workspace.
const Workspace = require('../models/Workspace');
const ORG_CACHE = new Map(); // workspaceNumber → { orgId: string|null, at: ms }
const ORG_CACHE_TTL_MS = 5 * 60 * 1000;
const ORG_CACHE_MAX = 5000;

async function orgForWorkspace(workspaceNumber) {
  if (workspaceNumber == null) return null;
  const now = Date.now();
  const hit = ORG_CACHE.get(workspaceNumber);
  if (hit && now - hit.at < ORG_CACHE_TTL_MS) return hit.orgId;
  let orgId = null;
  try {
    const w = await Workspace.findOne({ workspaceNumber }).select('organizationId').lean();
    orgId = w?.organizationId ? String(w.organizationId) : null;
  } catch {
    // Lookup failure: fall back to a stale cache entry if we have one — a
    // metrics write must never depend on a healthy lookup.
    orgId = hit ? hit.orgId : null;
  }
  if (ORG_CACHE.size >= ORG_CACHE_MAX) ORG_CACHE.clear(); // crude but bounded
  ORG_CACHE.set(workspaceNumber, { orgId, at: now });
  return orgId;
}

/**
 * Fallback org for events fired OUTSIDE a /workspace/<n>/ route (Wave 5 §9 P3-1).
 *
 * upgrade_clicked, checkout_started, settings_tab_viewed and the onboarding
 * events all come from routes with no workspace segment, so the sink can't
 * infer a workspaceNumber and every one of them was landing with a null org —
 * silently zeroing the org-denominated conversion funnel and, worse, writing
 * null attribution durably into the daily rollups.
 *
 * This does NOT reintroduce the spoofing hole the workspace derivation closed.
 * Nothing here comes from the request body: activeWorkspaceId is written only
 * by the authorization-checked activate endpoint, and the personal-org fallback
 * is looked up by the authenticated user's own id.
 *
 * Known ambiguity: a user in several orgs who is working in org B while their
 * last activated workspace belongs to org A attributes to A. The UI's "active
 * org" is client-side only (localStorage), so there is no server-side signal to
 * do better today; persisting an active organization would remove the guess.
 */
const User = require('../models/User');
const Organization = require('../models/Organization');
const USER_ORG_CACHE = new Map(); // userId → { orgId: string|null, at: ms }

async function orgForUser(userId) {
  if (!userId) return null;
  const key = String(userId);
  const now = Date.now();
  const hit = USER_ORG_CACHE.get(key);
  if (hit && now - hit.at < ORG_CACHE_TTL_MS) return hit.orgId;
  let orgId = null;
  try {
    const u = await User.findById(userId).select('activeWorkspaceId').lean();
    if (u?.activeWorkspaceId) {
      const w = await Workspace.findById(u.activeWorkspaceId).select('organizationId').lean();
      orgId = w?.organizationId ? String(w.organizationId) : null;
    }
    if (!orgId) {
      // Every user has exactly one of these (orgBootstrapService guarantees it).
      const personal = await Organization.findOne({ ownerId: userId, isPersonal: true }).select('_id').lean();
      orgId = personal?._id ? String(personal._id) : null;
    }
  } catch {
    orgId = hit ? hit.orgId : null;
  }
  if (USER_ORG_CACHE.size >= ORG_CACHE_MAX) USER_ORG_CACHE.clear();
  USER_ORG_CACHE.set(key, { orgId, at: now });
  return orgId;
}

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
      let payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
      // Scoping fields are read BEFORE the size cap below — an oversized
      // payload loses its blob, never its workspace/content attribution.
      const workspaceNumber = toNum(payload.workspaceNumber);
      const contentNumber = toNum(payload.contentNumber);
      // F6: replace oversized payloads (body-parsed JSON can't be circular).
      try {
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) payload = { _truncated: true };
      } catch {
        payload = {};
      }
      docs.push({
        event: e.event,
        payload,
        userId,
        workspaceNumber,
        contentNumber,
        ts: toNum(e.ts),
        // Wave 0 (§3.5): the middleware swaps in the impersonation token, so an
        // admin browsing "as" a tenant authenticates as that tenant here. Tag
        // the row with the real admin (from the JWT claim) so metrics queries
        // can exclude impersonated activity instead of polluting the tenant's
        // numbers. Stored as a string — a cast error inside the swallowed
        // insertMany would silently drop the whole batch.
        impersonatedBy: req.user?.impersonatedBy ? String(req.user.impersonatedBy) : null,
      });
    }

    // F2: derive org attribution server-side from the workspace (unique
    // numbers only — cached, so this is usually zero lookups).
    const wsNums = [...new Set(docs.map((d) => d.workspaceNumber).filter((n) => n != null))];
    const orgByWs = new Map();
    for (const n of wsNums) orgByWs.set(n, await orgForWorkspace(n));
    // One lookup for the whole batch: every doc here belongs to the same
    // authenticated user, and events off a workspace route still need an org.
    const needsFallback = docs.some((d) => d.workspaceNumber == null);
    const fallbackOrg = needsFallback ? await orgForUser(userId) : null;
    for (const d of docs) {
      d.organizationId = d.workspaceNumber != null ? orgByWs.get(d.workspaceNumber) : fallbackOrg;
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
 *  observation directly, bypassing the HTTP client. Fire-and-forget.
 *  Unlike ingestObservations, payload.orgId IS honored here — callers are
 *  backend code that already resolved tenancy, not the client. W1 review fix:
 *  when the caller passes workspaceNumber but no orgId, org is DERIVED via the
 *  same cache the ingest lane uses — otherwise server-lane rows land org-null
 *  and every per-org rollup silently loses them. */
async function recordObservation(event, payload = {}, userId = null, impersonatedBy = null) {
  try {
    if (!ALLOWED_EVENTS.has(event)) return;
    // Scoping fields read BEFORE the cap (mirror of the ingest lane).
    const workspaceNumber = toNum(payload.workspaceNumber);
    const contentNumber = toNum(payload.contentNumber);
    // W6 parity: same payload cap as the ingest lane — onboarding forwards
    // client-controlled arrays, and server lane must not be the bypass.
    let p = payload && typeof payload === 'object' ? payload : {};
    try {
      if (JSON.stringify(p).length > MAX_PAYLOAD_BYTES) p = { _truncated: true };
    } catch {
      p = {};
    }
    const organizationId =
      payload.orgId || (workspaceNumber != null ? await orgForWorkspace(workspaceNumber) : null);
    ObservationEvent.create({
      event,
      payload: p,
      userId: userId || null,
      organizationId,
      workspaceNumber,
      contentNumber,
      ts: Date.now(),
      // W7: server-lane rows written during an impersonation session must be
      // excludable exactly like ingested rows.
      impersonatedBy: impersonatedBy ? String(impersonatedBy) : null,
    }).catch(() => {});
  } catch { /* fire-and-forget — never throws into a caller */ }
}

/**
 * GET /api/admin/usage-rollups — Wave 0 (§3.6) first reader for the durable
 * daily rollups. Query: ?days=30&event=&orgId= (all optional). Admin-gated in
 * adminRoutes. Capped result set; newest first.
 */
async function getUsageRollups(req, res) {
  try {
    // F8: a malformed orgId is a caller error, not a server failure.
    if (req.query.orgId && !require('mongoose').isValidObjectId(req.query.orgId)) {
      return res.status(400).json({ error: 'Invalid orgId' });
    }
    const { getRollups } = require('../services/observationRollupService');
    const rows = await getRollups({
      days: Math.min(3650, Math.max(1, parseInt(req.query.days, 10) || 30)),
      event: typeof req.query.event === 'string' && req.query.event ? req.query.event : null,
      organizationId: typeof req.query.orgId === 'string' && req.query.orgId ? req.query.orgId : null,
    });
    res.json({ rows });
  } catch (err) {
    console.error('[observe] getUsageRollups error:', err.message);
    res.status(500).json({ error: 'Failed to fetch rollups' });
  }
}

module.exports = { ingestObservations, recordObservation, getUsageRollups, ALLOWED_EVENTS };
