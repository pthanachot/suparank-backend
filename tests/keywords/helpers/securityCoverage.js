/**
 * Phase C3 — single source of truth for Keyword-Research security coverage.
 *
 * Ported from the Part-I aiTracker pattern (tests/aiTracker/helpers/
 * securityCoverage.js). parseRoutes() extracts every route from
 * keywordRoutes.js SOURCE, so the completeness checks in security-rbac.test.js
 * fail the moment someone adds a keyword route without declaring BOTH its gate
 * expectation and its tenancy posture here. That is the C3 exit criterion,
 * made executable rather than aspirational.
 */

const fs = require('fs');
const path = require('path');

const ROUTES_FILE = path.resolve(__dirname, '../../../src/routes/keywordRoutes.js');

function parseRoutes() {
  const src = fs.readFileSync(ROUTES_FILE, 'utf8');
  const routes = [];
  const re = /router\.(get|post|put|delete)\(\s*'([^']+)'\s*,([^;]*?)keywordController\.(\w+)/gs;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, method, routePath, middle, handler] = m;
    routes.push({
      id: `${method.toUpperCase()} ${routePath}`,
      method: method.toUpperCase(),
      path: routePath,
      handler,
      gates: {
        policy: [...middle.matchAll(/requirePermission\('([^']+)'\)/g)].map((x) => x[1]),
        legacy: [...middle.matchAll(/rp\('([^']+)',\s*'([^']+)'\)/g)].map((x) => `${x[1]}:${x[2]}`),
        quota: /rq\(/.test(middle),
        credits: /rc\(/.test(middle),
        feature: /rf\('keywords'\)|rwrKw/.test(middle),
      },
    });
  }
  return routes;
}

/**
 * Expected gate per route id. `policy` = granular v4 key, `legacy` = old
 * Permission-grid pair. Every parsed route MUST have an entry.
 */
const EXPECTED_GATES = {
  'POST /:workspaceNumber/keywords/search': { policy: 'keywords.search', quota: true, credits: true },
  // Serper deep-dive maps to the INACTIVE serpDeepDive action, so it is
  // entitlement-gated (quota) but deliberately carries no credit gate.
  'GET /:workspaceNumber/keywords/detail': { policy: 'keywords.search', quota: true, credits: false },
  'GET /:workspaceNumber/keywords/history': { legacy: 'keywords:read' },
  // Table 3: Admin+ only. An Editor may NOT delete licensed keyword history.
  'DELETE /:workspaceNumber/keywords/history/:historyId': { policy: 'keywords.deleteHistory' },
  'GET /:workspaceNumber/keywords/cached': { legacy: 'keywords:read' },
  'GET /:workspaceNumber/keywords/countries': { legacy: 'keywords:read' },
};

/**
 * Tenancy coverage per route id: either { probe: '<test name in
 * security-tenancy.test.js>' } or { exempt: '<why no cross-tenant ids are
 * reachable>' }. Every parsed route MUST have an entry.
 *
 * NOTE on the caches: KeywordSearch/KeywordDetail are GLOBAL by design (rows
 * are licensed once and replayed across tenants to avoid re-billing DataForSEO).
 * That is why the exemptions below are about *ids*, and why /cached — the one
 * route that replays global rows — carries the K1 probe instead.
 */
const TENANCY_COVERAGE = {
  'POST /:workspaceNumber/keywords/search': {
    exempt: 'no foreign ids: takes keyword+country strings; history is written under the rwr-resolved own workspace',
  },
  'GET /:workspaceNumber/keywords/detail': {
    exempt: 'no ids: takes a keyword string; KeywordDetail cache is global by design (unbilled)',
  },
  'GET /:workspaceNumber/keywords/history': {
    probe: 'getSearchHistory: B sees only its own history',
  },
  'DELETE /:workspaceNumber/keywords/history/:historyId': {
    probe: 'deleteSearchHistory: foreign historyId survives',
  },
  'GET /:workspaceNumber/keywords/cached': {
    probe: 'K1 regression: foreign-workspace cached rows are not replayable',
  },
  'GET /:workspaceNumber/keywords/countries': {
    exempt: 'returns a static constant list; no tenant data touched',
  },
};

module.exports = { parseRoutes, EXPECTED_GATES, TENANCY_COVERAGE };
