/**
 * Phase C3 — Keyword RBAC matrix + route-gate binding + COMPLETENESS.
 *
 * Three layers, no DB (mirrors tests/aiTracker/security-rbac.test.js):
 *  1. Policy matrix: can(role, action) for every keyword action × all five
 *     roles — notably keywords.deleteHistory is Admin+ (Table 3: Y·Y·–·–),
 *     because deleting licensed keyword history destroys paid-for rows.
 *  2. Route→gate binding: every route in keywordRoutes.js carries exactly the
 *     expected policy/legacy gate, plus quota/credit middleware where billing
 *     demands them — and NOT where it doesn't (/detail must stay unbilled).
 *  3. COMPLETENESS (the phase exit criterion): every route parsed from SOURCE
 *     must appear in EXPECTED_GATES and TENANCY_COVERAGE — adding a keyword
 *     route without declaring its security posture fails here.
 *
 * Run: node --test tests/keywords/security-rbac.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { can } = require('../../src/middleware/permissions.policy');
const { parseRoutes, EXPECTED_GATES, TENANCY_COVERAGE } = require('./helpers/securityCoverage');

const ROLES = ['owner', 'admin', 'editor', 'viewer', 'client'];

// action → [owner, admin, editor, viewer, client]
const POLICY_MATRIX = {
  'keywords.search': [true, true, true, false, false],
  'keywords.viewHistory': [true, true, true, true, true],
  'keywords.deleteHistory': [true, true, false, false, false],
};

describe('policy matrix — keyword actions × roles', () => {
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

  it('an Editor can SEARCH but must NOT delete licensed history', () => {
    assert.equal(can('editor', 'keywords.search'), true);
    assert.equal(can('editor', 'keywords.deleteHistory'), false, 'Table 3 violation: Editor gained delete');
  });

  it('a Viewer/Client can read history but never spend money', () => {
    for (const role of ['viewer', 'client']) {
      assert.equal(can(role, 'keywords.viewHistory'), true, `${role} lost history read`);
      assert.equal(can(role, 'keywords.search'), false, `${role} can spend credits`);
      assert.equal(can(role, 'keywords.deleteHistory'), false, `${role} can delete history`);
    }
  });

  it('monotonicity: client ⟹ viewer ⟹ editor ⟹ admin for every keyword action', () => {
    for (const action of Object.keys(POLICY_MATRIX)) {
      const [, admin, editor, viewer, client] = ROLES.map((role) => can(role, action));
      assert.ok(!client || viewer, `${action}: client without viewer`);
      assert.ok(!viewer || editor, `${action}: viewer without editor`);
      assert.ok(!editor || admin, `${action}: editor without admin`);
    }
  });
});

describe('route→gate binding (parsed from keywordRoutes.js source)', () => {
  const routes = parseRoutes();

  it('parses the full surface (route count guard)', () => {
    assert.equal(routes.length, 6, `parsed ${routes.length} routes — parser drift or the surface changed`);
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
          `${route.id}: expected rp('${expected.legacy.replace(':', "', '")}'), found [${route.gates.legacy}]`,
        );
      }
      if (expected.credits) assert.ok(route.gates.credits, `${route.id}: billing route without a credit gate`);
      if (expected.quota) assert.ok(route.gates.quota, `${route.id}: quota-bearing route without rq()`);
      // Every keyword route sits behind the feature flag + workspace resolution.
      assert.ok(route.gates.feature, `${route.id}: not behind rwr + rf('keywords')`);
      // No route may rely on NOTHING.
      assert.ok(
        route.gates.policy.length > 0 || route.gates.legacy.length > 0,
        `${route.id}: ungated route`,
      );
    });
  }

  it('/detail stays UNBILLED — a credit gate here would double-charge the SERP dive', () => {
    const detail = parseRoutes().find((r) => r.id === 'GET /:workspaceNumber/keywords/detail');
    assert.ok(detail, 'the /detail route disappeared');
    assert.equal(detail.gates.credits, false, 'serpDeepDive is INACTIVE in creditCosts — it must not carry rc()');
    assert.equal(detail.gates.quota, true, 'it is still entitlement-gated by keywordSearches');
  });

  it('every credit-bearing route also carries a quota gate', () => {
    for (const route of parseRoutes()) {
      if (route.gates.credits) {
        assert.ok(route.gates.quota, `${route.id}: bills credits but is not entitlement-gated`);
      }
    }
  });
});

// Phase C review. The HTTP tests seed their own Permission grid
// (helpers/httpWorld.js#KEYWORD_PERMISSION_GRID). If production's grid changes,
// that harness would keep testing a fiction — the same failure mode the Phase-B
// review found in buildReq. This pins the two together.
describe('harness fidelity — the seeded permission grid matches production config', () => {
  const fs = require('fs');
  const path = require('path');
  const { KEYWORD_PERMISSION_GRID } = require('./helpers/httpWorld');

  it('every keywords row in configPermissions.js is reproduced by the harness', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/scripts/configPermissions.js'), 'utf8',
    );
    // Rows look like: ['keywords', 'read', true, true, true, true, true]
    const rows = [...src.matchAll(/\['keywords',\s*'(\w+)',\s*([^\]]+)\]/g)].map((m) => ({
      action: m[1],
      roles: m[2].split(',').map((v) => v.trim() === 'true'),
    }));
    assert.ok(rows.length >= 2, `parsed only ${rows.length} keyword permission rows — parser drift`);

    for (const row of rows) {
      // The harness only needs to model the actions the ROUTES consult.
      const harnessRows = KEYWORD_PERMISSION_GRID.filter(([, , action]) => action === row.action);
      if (harnessRows.length === 0) continue;
      for (let i = 0; i < ROLES.length; i++) {
        const harness = harnessRows.find(([role]) => role === ROLES[i]);
        assert.ok(harness, `harness grid missing ${ROLES[i]} × keywords:${row.action}`);
        assert.equal(
          harness[3], row.roles[i],
          `harness grid drifted from configPermissions.js at ${ROLES[i]} × keywords:${row.action}`,
        );
      }
    }
  });

  it('the legacy grid lets an Editor delete, but the POLICY gate does not — the route uses the policy', () => {
    // Worth pinning explicitly: configPermissions.js has keywords:delete true
    // for Editor, while permissions.policy denies keywords.deleteHistory below
    // Admin. The delete route is wired to the POLICY gate, so Admin+ wins.
    // If the route were ever switched to rp('keywords','delete'), Editors would
    // silently regain the ability to destroy licensed history.
    assert.equal(can('editor', 'keywords.deleteHistory'), false);
    const del = parseRoutes().find((r) => r.method === 'DELETE');
    assert.ok(
      del.gates.policy.includes('keywords.deleteHistory'),
      'the delete route must use the policy gate, not the more permissive legacy grid',
    );
  });
});

describe('COMPLETENESS — every keyword route declared in both coverage maps', () => {
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
        (cov.probe && cov.probe.length > 0) || (cov.exempt && cov.exempt.length > 20),
        `${r.id}: needs a probe name or a substantive exemption rationale`,
      );
    }
    for (const id of Object.keys(TENANCY_COVERAGE)) {
      assert.ok(parsedIds.has(id), `stale TENANCY_COVERAGE entry: ${id}`);
    }
  });

  it('every route bearing an :id path param has a PROBE, never an exemption', () => {
    for (const r of routes) {
      const hasIdParam = /:(?!workspaceNumber)\w+/.test(r.path);
      if (hasIdParam) {
        assert.ok(
          TENANCY_COVERAGE[r.id]?.probe,
          `${r.id}: takes a foreign-referencable id but is only exempted, not probed`,
        );
      }
    }
  });
});
