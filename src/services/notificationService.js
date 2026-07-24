const Notification = require('../models/Notification');

// The single write path for in-app, per-user notifications. Everything that
// wants to tell a user something (analysis ready, content locked, …) goes
// through emit().
//
// CONTRACT: emit() NEVER throws and NEVER rejects. A notification is always a
// side effect of some real work (an analysis finishing, a downgrade running),
// and that work must never fail or slow because telling the user about it
// failed. Callers may await it or fire-and-forget it safely — either way a DB
// hiccup here is swallowed and logged, not propagated. This mirrors the
// best-effort outcome-snapshot block in analysisController.
//
// DEFERRED (email delivery): emit() is IN-APP ONLY. When email lands it must
// NOT be bolted on here as a second channel per call — it reads the same source
// event and delivers through an idempotent claim-and-drain worker. See
// NOTIFICATION-SYSTEM-PLAN.md Phase 2/6.

// System-generated copy can embed user data (a content title, a keyword), which
// is unbounded. Truncate as a backstop so one giant title can't bloat a row.
// The model intentionally has no maxlength on these (a length rejection would
// silently drop a fire-and-forget notification) — bounding lives here instead.
function truncate(str, max) {
  const s = String(str == null ? '' : str);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

async function emit({ userId, type, title, body = '', link = '' } = {}) {
  try {
    if (!userId || !type || !title) return null; // can't address it — skip quietly
    return await Notification.create({
      userId,
      type,
      title: truncate(title, 200),
      body: truncate(body, 500),
      link,
    });
  } catch (err) {
    console.error('[notificationService] emit failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { emit };
