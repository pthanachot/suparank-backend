/**
 * Phase 8 — RBAC matrix + route-gate binding + COMPLETENESS.
 *
 * Three layers, no DB:
 *  1. Policy matrix: can(role, action) for every tracker action × all five
 *     roles — the v4 Table-3 contract (refreshOne Editor+, refreshAll and
 *     manageMonitor Admin+, view all-roles).
 *  2. Route→gate binding: every route in aiTrackerRoutes.js carries exactly
 *     the expected policy/legacy gate (+ quota/credit middlewares where
 *     billing demands them).
 *  3. COMPLETENESS (the phase exit criterion): every route parsed from the
 *     SOURCE must have an entry in EXPECTED_GATES and TENANCY_COVERAGE —
 *     adding a route without declaring its security posture fails here.
 *
 * Run: node --test tests/aiTracker/security-rbac.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { can } = require('../../src/middleware/permissions.policy');
const { parseRoutes, EXPECTED_GATES, TENANCY_COVERAGE } = require('./helpers/securityCoverage');

const ROLES = ['owner', 'admin', 'editor', 'viewer', 'client'];

// action → [owner, admin, editor, viewer, client]
const POLICY_MATRIX = {
  'tracker.view': [true, true, true, true, true],
  'tracker.managePrompts': [true, true, true, false, false],
  'tracker.refreshOne': [true, true, true, false, false],
  'tracker.refreshAll': [true, true, false, false, false],
  'tracker.manageMonitor': [true, true, false, false, false],
};

describe('policy matrix — tracker actions × roles', () => {
  for (const [action, expected] of Object.entries(POLICY_MATRIX)) {
    it(`${action} → ${expected.map((v, i) => (v ? ROLES[i][0].toUpperCase() : '·')).join('')}`, () => {
      for (let i = 0; i < ROLES.length; i++) {
        assert.equal(
          can(ROLES[i], action),
          expected[i],
          `${ROLES[i]} × ${action}: expected ${expected[i]}`,
        );
      }
    });
  }

  it('monotonicity: client ⟹ viewer ⟹ editor ⟹ admin for every tracker action', () => {
    for (const action of Object.keys(POLICY_MATRIX)) {
      const [_, admin, editor, viewer, client] = ROLES.map((r) => can(r, action));
      assert.ok(!client || viewer, `${action}: client without viewer`);
      assert.ok(!viewer || editor, `${action}: viewer without editor`);
      assert.ok(!editor || admin, `${action}: editor without admin`);
    }
  });
});

describe('route→gate binding (parsed from aiTrackerRoutes.js source)', () => {
  const routes = parseRoutes();

  it('parses the full surface (route count guard)', () => {
    assert.ok(routes.length >= 32, `only ${routes.length} routes parsed — parser drift or surface shrank`);
  });

  for (const route of parseRoutes()) {
    it(`${route.id} carries its declared gate`, () => {
      const expected = EXPECTED_GATES[route.id];
      assert.ok(expected, `route missing from EXPECTED_GATES — declare its security posture: ${route.id}`);
      if (expected.policy) {
        assert.ok(
          route.gates.policy.includes(expected.policy),
          `${route.id}: expected requirePermission('${expected.policy}'), found [${route.gates.policy}] / legacy [${route.gates.legacy}]`,
        );
      }
      if (expected.legacy) {
        assert.ok(
          route.gates.legacy.includes(expected.legacy),
          `${route.id}: expected rp('${expected.legacy}'), found [${route.gates.legacy}]`,
        );
      }
      if (expected.credits) assert.ok(route.gates.credits, `${route.id}: billing route without a credit gate`);
      if (expected.quota) assert.ok(route.gates.quota, `${route.id}: quota-bearing route without rq()`);
      // No write route may rely on NOTHING: every route has policy or legacy.
      assert.ok(
        route.gates.policy.length > 0 || route.gates.legacy.length > 0,
        `${route.id}: ungated route`,
      );
    });
  }
});

describe('COMPLETENESS — every route declared in both coverage maps', () => {
  const routes = parseRoutes();

  it('EXPECTED_GATES covers every parsed route (and nothing stale)', () => {
    const parsedIds = new Set(routes.map((r) => r.id));
    for (const r of routes) {
      assert.ok(EXPECTED_GATES[r.id], `undeclared route gate: ${r.id}`);
    }
    for (const id of Object.keys(EXPECTED_GATES)) {
      assert.ok(parsedIds.has(id), `stale EXPECTED_GATES entry (route removed/renamed): ${id}`);
    }
  });

  it('TENANCY_COVERAGE covers every parsed route with a probe or a justified exemption', () => {
    const parsedIds = new Set(routes.map((r) => r.id));
    for (const r of routes) {
      const cov = TENANCY_COVERAGE[r.id];
      assert.ok(cov, `route missing tenancy coverage declaration: ${r.id}`);
      assert.ok(
        (cov.probe && cov.probe.length > 3) || (cov.exempt && cov.exempt.length > 10),
        `${r.id}: tenancy entry must name a probe or justify an exemption`,
      );
    }
    for (const id of Object.keys(TENANCY_COVERAGE)) {
      assert.ok(parsedIds.has(id), `stale TENANCY_COVERAGE entry: ${id}`);
    }
  });

  it('every id-carrying route is PROBED, not exempted', () => {
    for (const r of parseRoutes()) {
      const carriesForeignId = /:monitorId|:promptId|:competitorId|:contentNumber/.test(r.path);
      if (carriesForeignId) {
        assert.ok(
          TENANCY_COVERAGE[r.id]?.probe,
          `${r.id} carries a client-supplied id but is not probed`,
        );
      }
    }
  });
});
