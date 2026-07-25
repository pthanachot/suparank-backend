/**
 * Phase 4 — admin authz coverage sweep.
 *
 * Statically walks the REAL adminRoutes Express router and proves every route
 * is gated by [authenticateToken, validateAdmin] — the single defense that
 * makes /api/admin/* admin-only. The ONE documented exception is
 * POST /user-lookup (authenticateToken-only; it self-gates inside the
 * controller and is the bootstrap that decides whether to render the shell).
 *
 * Deliberately static (no DB, no HTTP): it catches the highest-impact bug — a
 * new admin route that forgets validateAdmin — at the wiring level, and
 * enumerates routes automatically so future additions are covered by default.
 *
 * Combined with platformAdminAccess.test.js (which proves validateAdmin itself
 * 403s a non-admin and blocks impersonated sessions), this composes to: every
 * admin route rejects a non-admin.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/routes/adminRoutes');
const validateAdmin = require('../src/middleware/validateAdmin');
const { authenticateToken } = require('../src/middleware/auth');

// Routes intentionally NOT behind validateAdmin (they gate themselves).
const AUTH_ONLY_EXCEPTIONS = new Set(['POST /user-lookup']);

function collectRoutes(r) {
  const out = [];
  for (const layer of r.stack) {
    if (!layer.route) continue; // skip param()/middleware layers
    const path = layer.route.path;
    const handles = layer.route.stack.map((s) => s.handle);
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ key: `${method.toUpperCase()} ${path}`, handles });
    }
  }
  return out;
}

const routes = collectRoutes(router);

describe('admin authz coverage (Phase 4)', () => {
  it('discovers the full admin route table', () => {
    // Also the anti-vacuity guard: if introspection silently returned [], every
    // "every route is gated" assertion below would pass over an empty set.
    assert.ok(routes.length >= 55, `expected the full admin route table, found ${routes.length}`);
  });

  it('the router is flat — no un-walked sub-routers can hide ungated routes', () => {
    // collectRoutes only walks top-level route layers. A mounted sub-router
    // (router.use(path, subRouter)) would add routes this sweep cannot see.
    // Assert there are none, so adding one fails HERE and forces the sweep to be
    // extended to recurse — rather than a nested route silently escaping the gate.
    const nonRoute = router.stack.filter((l) => !l.route).map((l) => l.name || '(anon)');
    assert.deepEqual(nonRoute, [], `unexpected non-route layers (extend collectRoutes to recurse): ${nonRoute.join(', ')}`);
  });

  it('every admin route requires authenticateToken', () => {
    const missing = routes.filter((r) => !r.handles.includes(authenticateToken)).map((r) => r.key);
    assert.deepEqual(missing, [], `routes missing authenticateToken: ${missing.join(', ')}`);
  });

  it('every admin route is behind validateAdmin except the documented exception', () => {
    const missing = routes
      .filter((r) => !AUTH_ONLY_EXCEPTIONS.has(r.key))
      .filter((r) => !r.handles.includes(validateAdmin))
      .map((r) => r.key);
    assert.deepEqual(missing, [], `routes missing validateAdmin: ${missing.join(', ')}`);
  });

  it('authenticateToken precedes validateAdmin on every gated route', () => {
    const bad = [];
    for (const r of routes) {
      if (AUTH_ONLY_EXCEPTIONS.has(r.key)) continue;
      const ai = r.handles.indexOf(authenticateToken);
      const vi = r.handles.indexOf(validateAdmin);
      if (!(ai >= 0 && vi >= 0 && ai < vi)) bad.push(r.key);
    }
    assert.deepEqual(bad, [], `bad middleware order (auth must precede validateAdmin): ${bad.join(', ')}`);
  });

  it('validateAdmin runs BEFORE the route handler on every gated route', () => {
    // The security invariant is only "the gate precedes the handler" — NOT that
    // it sits immediately before it. A legit middleware may follow the gate (the
    // request is already authorized by then). This still catches the real bug: a
    // handler placed BEFORE the gate leaves validateAdmin as the final layer.
    const bad = [];
    for (const r of routes) {
      if (AUTH_ONLY_EXCEPTIONS.has(r.key)) continue;
      const vi = r.handles.indexOf(validateAdmin);
      // Present, and not the final layer → at least the handler runs after it.
      if (!(vi >= 0 && vi < r.handles.length - 1)) bad.push(`${r.key} (validateAdmin at ${vi}/${r.handles.length})`);
    }
    assert.deepEqual(bad, [], `validateAdmin does not run before the handler: ${bad.join(', ')}`);
  });

  it('the /user-lookup exception is authenticated but intentionally not validateAdmin-gated', () => {
    const ul = routes.find((r) => r.key === 'POST /user-lookup');
    assert.ok(ul, '/user-lookup route not found');
    assert.ok(ul.handles.includes(authenticateToken), '/user-lookup must still require auth');
    assert.ok(!ul.handles.includes(validateAdmin), '/user-lookup must self-gate, not use validateAdmin');
  });
});
