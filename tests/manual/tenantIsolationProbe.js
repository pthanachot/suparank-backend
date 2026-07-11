/**
 * Phase 20 — cross-tenant isolation probe suite.
 *
 * Boots the REAL org/workspace routers against an isolated throwaway DB on the
 * LOCAL mongod (never the shared Atlas), seeds TWO agency orgs (A and B) with
 * every WL feature flag live + agency entitlement, then asserts:
 *   NEGATIVE — org A's owner token hitting org B's :orgId routes (detail, list,
 *              and mutation) is ALWAYS blocked (never 2xx). A 2xx = cross-tenant leak.
 *   POSITIVE — org B's owner token reaches its own routes (proves the route is
 *              actually live, so a NEGATIVE block is real isolation, not a dark flag).
 *   LIST-LEAK — A's own list endpoints never contain B's org/workspace.
 *
 * Run: node tests/manual/tenantIsolationProbe.js   (requires local mongod on :27099)
 */
const TESTDB = 'mongodb://127.0.0.1:27099/tenant_isolation_probe_' + Date.now();
process.env.MONGODB_URI = TESTDB;
process.env.ACCESS_TOKEN_SECRET = 'probe-secret';
process.env.ADMIN_EMAILS = 'nobody@nowhere.test';
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_for_load';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';

const mongoose = require('mongoose');
const express = require('express');
const User = require('../../src/models/User');
const Organization = require('../../src/models/Organization');
const Workspace = require('../../src/models/Workspace');
const OrgMember = require('../../src/models/OrgMember');
const WorkspaceMember = require('../../src/models/WorkspaceMember');
const Sitemap = require('../../src/models/Sitemap');
const FeatureFlag = require('../../src/models/FeatureFlag');
const tierService = require('../../src/services/tierService');
const { syncPermissions } = require('../../src/scripts/configPermissions');
const { generateAccessToken } = require('../../src/utils/jwt');

const BASE = 'http://127.0.0.1:4998';
const DUMMY = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // stand-in ObjectId for :memberId/:domainId/etc.
let pass = 0, fail = 0;
const fails = [];
const ok = (name) => { pass++; };
const bad = (name, detail) => { fail++; fails.push(`${name}  ->  ${detail}`); };

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let text = ''; try { text = await res.text(); } catch { /* */ }
  return { status: res.status, text };
}

// Every org-tenant-scoped route. {m, p:(orgId)=>path, body?, get?:true means safe positive control}
const ORG_ROUTES = [
  // organizationRoutes (mounted /api/organizations)
  { m: 'GET',    p: (o) => `/api/organizations/${o}`, get: true },
  { m: 'PUT',    p: (o) => `/api/organizations/${o}`, body: { name: 'Hacked' } },
  { m: 'DELETE', p: (o) => `/api/organizations/${o}` },
  // orgRoutes (mounted /api/org) — members
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/members`, get: true },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/members`, body: { email: 'x@y.co', role: 'editor' } },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/members/${DUMMY}/role`, body: { role: 'admin' } },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/members/${DUMMY}/scope`, body: { accessScope: 'all' } },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/members/${DUMMY}/workspaces`, body: { workspaceIds: [] } },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/members/${DUMMY}` },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/invites/${DUMMY}` },
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/audit-log`, get: true },
  // brand
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/brand`, get: true },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/brand`, body: { productName: 'Hacked' } },
  // domains
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/domains`, get: true },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/domains`, body: { hostname: 'evil.example.com' } },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/domains/${DUMMY}/verify` },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/domains/${DUMMY}/primary` },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/domains/${DUMMY}` },
  // export / erase
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/export`, get: true },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/erase`, body: { confirm: 'OrgB' } },
  // email domain / templates
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/email-domain`, get: true },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/email-domain`, body: { domain: 'evil.example.com' } },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/email-domain/verify` },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/email-domain` },
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/email-templates`, get: true },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/email-templates/welcome`, body: { subject: 'x' } },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/email-templates/welcome` },
  // usage
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/usage/by-workspace`, get: true },
  // connect / agency plans (saasMode)
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/connect/onboard` },
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/connect/status`, get: true },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/connect/disconnect` },
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/agency-plans`, get: true },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/agency-plans`, body: { name: 'P', priceCents: 1000, currency: 'usd', interval: 'month' } },
  { m: 'PUT',    p: (o) => `/api/org/organizations/${o}/agency-plans/${DUMMY}`, body: { name: 'P2' } },
  { m: 'DELETE', p: (o) => `/api/org/organizations/${o}/agency-plans/${DUMMY}` },
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/console/roster`, get: true },
  { m: 'GET',    p: (o) => `/api/org/organizations/${o}/console/overview`, get: true },
  // ownership
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/transfer-ownership`, body: { newOwnerId: DUMMY } },
  { m: 'POST',   p: (o) => `/api/org/organizations/${o}/leave` },
];

// Workspace (client) boundary — workspaceCrudRoutes resolves :workspaceId by Mongo
// _id, the classic IDOR shape. A hitting B's workspace _id must be blocked.
const WORKSPACE_ROUTES = [
  { m: 'GET',    p: (w) => `/api/workspaces/${w}/members`, get: true },
  { m: 'GET',    p: (w) => `/api/workspaces/${w}/content-summary`, get: true },
  { m: 'PUT',    p: (w) => `/api/workspaces/${w}`, body: { name: 'Hacked' } },
  { m: 'PUT',    p: (w) => `/api/workspaces/${w}/move`, body: { organizationId: DUMMY } },
  { m: 'PUT',    p: (w) => `/api/workspaces/${w}/activate` },
  { m: 'POST',   p: (w) => `/api/workspaces/${w}/members`, body: { email: 'x@y.co', role: 'editor' } },
  { m: 'DELETE', p: (w) => `/api/workspaces/${w}/members/${DUMMY}` },
  { m: 'DELETE', p: (w) => `/api/workspaces/${w}` },
];

const BLOCKED = new Set([400, 401, 403, 404]);

(async () => {
  await mongoose.connect(TESTDB);
  await mongoose.connection.dropDatabase();

  const ownerA = await User.create({ userId: 810001, email: 'ownera@probe.test', name: 'OwnerA', status: 'active', roles: ['member'], tokenVersion: 0 });
  const ownerB = await User.create({ userId: 810002, email: 'ownerb@probe.test', name: 'OwnerB', status: 'active', roles: ['member'], tokenVersion: 0 });
  const orgA = await Organization.create({ name: 'OrgA', slug: 'orga-' + Date.now(), ownerId: ownerA._id, lifecycleStatus: 'active' });
  const orgB = await Organization.create({ name: 'OrgB', slug: 'orgb-' + Date.now(), ownerId: ownerB._id, lifecycleStatus: 'active' });
  const wsA = await Workspace.create({ workspaceNumber: 810001, userId: ownerA._id, organizationId: orgA._id, name: 'WS-A' });
  const wsB = await Workspace.create({ workspaceNumber: 810002, userId: ownerB._id, organizationId: orgB._id, name: 'WS-B-SECRET' });

  // Cross-workspace-SAME-org fixtures: a 2nd workspace in org A + an 'assigned'-scope
  // member granted to wsA ONLY. This is the exact vector the sitemap + content-summary
  // IDOR fixes close — an org member restricted to wsA must not reach sibling wsA2.
  const wsA2 = await Workspace.create({ workspaceNumber: 810003, userId: ownerA._id, organizationId: orgA._id, name: 'WS-A2-SIBLING-SECRET' });
  const memberM = await User.create({ userId: 810004, email: 'assigned@probe.test', name: 'AssignedM', status: 'active', roles: ['member'], tokenVersion: 0 });
  await OrgMember.create({ organizationId: orgA._id, ownerId: ownerA._id, userId: memberM._id, email: memberM.email, role: 'editor', accessScope: 'assigned', status: 'active' });
  await WorkspaceMember.create({ workspaceId: wsA._id, organizationId: orgA._id, userId: memberM._id, email: memberM.email, role: 'editor', status: 'active' });
  const smA = await Sitemap.create({ organizationId: orgA._id, workspaceId: wsA._id, url: 'https://a.example.com', label: 'A-sitemap' });
  const smA2 = await Sitemap.create({ organizationId: orgA._id, workspaceId: wsA2._id, url: 'https://a2.example.com', label: 'A2-sitemap-SECRET' });

  // All WL flags live so routes are reachable (positive controls are meaningful).
  for (const key of ['customDomains', 'whiteLabelEmail', 'saasMode', 'dataExport', 'dataErasure', 'sitemap']) {
    await FeatureFlag.create({ key, displayName: key, enabled: true, implemented: true });
  }
  // Seed the role→permission matrix so rp('sitemap', …) resolves (else every role 403s
  // on "Insufficient permissions" and the sitemap workspace-scope fix can't be exercised).
  await syncPermissions();
  // Grant both orgs the agency entitlement so per-controller saasMode/WL gates pass.
  const realGetOrgTier = tierService.getOrgTier;
  tierService.getOrgTier = async () => 'agency';
  // triggerCrawl/createSitemap read config off getOrgTierConfig — stub it so the crawl
  // path reaches the workspace-scope filter instead of crashing on a null config.
  const realGetOrgTierConfig = tierService.getOrgTierConfig;
  tierService.getOrgTierConfig = async () => ({ tier: 'agency', config: { maxCrawlPages: 500, maxSitemaps: 100 } });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../src/routes/authRoutes'));
  app.use('/api/org', require('../../src/routes/orgRoutes'));
  app.use('/api/organizations', require('../../src/routes/organizationRoutes'));
  app.use('/api/workspaces', require('../../src/routes/workspaceCrudRoutes'));
  app.use('/api/workspace', require('../../src/routes/sitemapRoutes')); // /:workspaceNumber/sitemaps/...
  const server = app.listen(4998);
  await new Promise((r) => server.once('listening', r));

  const tokenA = generateAccessToken({ _id: ownerA._id, email: ownerA.email, roles: ownerA.roles, tokenVersion: 0 }, undefined);
  const tokenB = generateAccessToken({ _id: ownerB._id, email: ownerB.email, roles: ownerB.roles, tokenVersion: 0 }, undefined);
  const tokenM = generateAccessToken({ _id: memberM._id, email: memberM.email, roles: memberM.roles, tokenVersion: 0 }, undefined);

  const bId = String(orgB._id);
  const statusTally = {};
  const provenProof = []; // routes where B reaches (2xx) AND A is blocked → isolation independently proven
  const gatedRoutes = []; // routes neither A nor B could reach (dark/entitlement) — block not independently proven

  console.log('\n─── NEGATIVE: orgA owner hitting orgB routes must be BLOCKED (never 2xx) ───');
  for (const r of ORG_ROUTES) {
    const path = r.p(bId);
    const neg = await call(r.m, path, tokenA, r.body);
    const label = `${r.m} ${path.replace(bId, ':orgB')}`;
    statusTally[neg.status] = (statusTally[neg.status] || 0) + 1;
    if (neg.status >= 200 && neg.status < 300) {
      bad('LEAK ' + label, `A got ${neg.status} on org B! body=${neg.text.slice(0, 160)}`);
    } else if (neg.status === 500) {
      bad('CRASH ' + label, `500 (unexpected) body=${neg.text.slice(0, 160)}`);
    } else if (BLOCKED.has(neg.status)) {
      ok(label);
    } else {
      bad('ODD ' + label, `unexpected status ${neg.status}`);
    }
    // POSITIVE control on safe GETs: B should reach its own route (else the block above is just a dark gate).
    if (r.get) {
      const pos = await call(r.m, path, tokenB, r.body);
      if (pos.status >= 200 && pos.status < 300) {
        provenProof.push(label);
        // Strongest per-route proof: route is LIVE for B, and A is specifically authz-blocked (403).
        if (neg.status !== 403) bad('WEAK-BLOCK ' + label, `B reaches it (${pos.status}) but A got ${neg.status}, expected 403 authz block`);
      } else {
        gatedRoutes.push(`${label} (B:${pos.status})`);
      }
    }
  }
  console.log('  negative status distribution: ' + JSON.stringify(statusTally));
  console.log(`  isolation INDEPENDENTLY PROVEN on ${provenProof.length} live routes (B reaches 2xx, A blocked 403)`);
  if (gatedRoutes.length) console.log('  not-independently-proven (dark/entitlement gate fires first): ' + gatedRoutes.join(', '));

  console.log('─── NEGATIVE (workspace boundary): orgA owner hitting orgB\'s workspace _id must be BLOCKED ───');
  const wsTally = {};
  let wsProven = 0;
  const wBId = String(wsB._id);
  for (const r of WORKSPACE_ROUTES) {
    const path = r.p(wBId);
    const neg = await call(r.m, path, tokenA, r.body);
    const label = `${r.m} ${path.replace(wBId, ':wsB')}`;
    wsTally[neg.status] = (wsTally[neg.status] || 0) + 1;
    if (neg.status >= 200 && neg.status < 300) bad('WS-LEAK ' + label, `A got ${neg.status} on B's workspace! body=${neg.text.slice(0, 160)}`);
    else if (neg.status === 500) bad('WS-CRASH ' + label, `500 body=${neg.text.slice(0, 160)}`);
    else if (BLOCKED.has(neg.status)) ok(label);
    else bad('WS-ODD ' + label, `unexpected ${neg.status}`);
    if (r.get) {
      const pos = await call(r.m, path, tokenB, r.body);
      if (pos.status >= 200 && pos.status < 300) { wsProven++; if (neg.status !== 403 && neg.status !== 404) bad('WS-WEAK ' + label, `B reaches (${pos.status}) but A got ${neg.status}`); }
    }
  }
  console.log('  workspace-boundary status distribution: ' + JSON.stringify(wsTally) + `  (${wsProven} live routes proven isolated)`);

  console.log('─── CROSS-WORKSPACE (same org): assigned member (granted wsA only) must NOT reach sibling wsA2 ───');
  const cwTally = {};
  const cw = async (label, method, path) => {
    const r = await call(method, path, tokenM);
    cwTally[r.status] = (cwTally[r.status] || 0) + 1;
    if (r.status >= 200 && r.status < 300) bad('CW-LEAK ' + label, `member reached sibling wsA2! ${r.status} body=${r.text.slice(0, 160)}`);
    else if (r.status === 500) bad('CW-CRASH ' + label, `500 body=${r.text.slice(0, 160)}`);
    else if (BLOCKED.has(r.status)) ok(label);
    else bad('CW-ODD ' + label, `unexpected ${r.status}`);
  };
  const wnA = wsA.workspaceNumber; // member's granted workspace — rwr passes here
  const idA2 = String(smA2._id);   // sibling workspace's sitemap — must NOT be reachable via wnA
  // Sitemap IDOR: URL workspace = wsA (grant OK), sitemapId = wsA2's → the workspaceId filter must 404.
  await cw('member GET wsA/sitemaps/{smA2}',        'GET',    `/api/workspace/${wnA}/sitemaps/${idA2}`);
  await cw('member GET wsA/sitemaps/{smA2}/pages',  'GET',    `/api/workspace/${wnA}/sitemaps/${idA2}/pages`);
  await cw('member POST wsA/sitemaps/{smA2}/crawl', 'POST',   `/api/workspace/${wnA}/sitemaps/${idA2}/crawl`);
  await cw('member GET wsA/sitemaps/{smA2}/export', 'GET',    `/api/workspace/${wnA}/sitemaps/${idA2}/export`);
  await cw('member DELETE wsA/sitemaps/{smA2}',     'DELETE', `/api/workspace/${wnA}/sitemaps/${idA2}`);
  // content-summary IDOR: member (no grant to wsA2) hitting wsA2 by _id → getContentSummary must 404.
  await cw('member GET wsA2/content-summary',       'GET',    `/api/workspaces/${wsA2._id}/content-summary`);

  // POSITIVE CONTROLS — prove the blocks above are the workspace-scope, not dead routes.
  // Owner reaches wsA2's own sitemap/content-summary through wsA2's OWN number → route is live and
  // wsA2 IS reachable by an authorized caller, so the member's 404s are the scope, not a dark gate.
  const posOwnerSitemap = await call('GET', `/api/workspace/${wsA2.workspaceNumber}/sitemaps/${idA2}`, tokenA);
  const posOwnerCS = await call('GET', `/api/workspaces/${wsA2._id}/content-summary`, tokenA);
  const posMemberSitemap = await call('GET', `/api/workspace/${wnA}/sitemaps/${String(smA._id)}`, tokenM); // member → own ws
  const posMemberCS = await call('GET', `/api/workspaces/${wsA._id}/content-summary`, tokenM);
  if (posOwnerSitemap.status >= 200 && posOwnerSitemap.status < 300) ok('owner reaches wsA2 sitemap via its own workspace (positive control)');
  else bad('CW-DEADROUTE sitemap', `owner could NOT reach wsA2's own sitemap (${posOwnerSitemap.status}) → negative blocks inconclusive. body=${posOwnerSitemap.text.slice(0, 160)}`);
  if (posOwnerCS.status >= 200 && posOwnerCS.status < 300) ok('owner reaches wsA2 content-summary (positive control)');
  else bad('CW-DEADROUTE content-summary', `owner could NOT reach wsA2 content-summary (${posOwnerCS.status}). body=${posOwnerCS.text.slice(0, 160)}`);
  console.log('  cross-workspace status distribution: ' + JSON.stringify(cwTally));
  console.log(`  positive controls — owner→wsA2 sitemap:${posOwnerSitemap.status} owner→wsA2 CS:${posOwnerCS.status} | member→ownWs sitemap:${posMemberSitemap.status} member→ownWs CS:${posMemberCS.status}`);

  console.log('─── LIST-LEAK: A\'s own collections must not contain B ───');
  const orgList = await call('GET', '/api/organizations', tokenA);
  if (orgList.text.includes(bId) || orgList.text.includes('OrgB')) bad('LIST orgs', `A's org list contains org B! ${orgList.text.slice(0, 200)}`);
  else ok('GET /api/organizations excludes org B');

  const wsList = await call('GET', '/api/workspaces', tokenA);
  if (wsList.text.includes(String(wsB._id)) || wsList.text.includes('WS-B-SECRET')) bad('LIST workspaces', `A's workspace list contains B's workspace! ${wsList.text.slice(0, 200)}`);
  else ok('GET /api/workspaces excludes B\'s workspace');

  const membersA = await call('GET', `/api/org/organizations/${orgA._id}/members`, tokenA);
  if (membersA.text.includes('ownerb@probe.test')) bad('LIST members', `A's member list contains org B's owner!`);
  else ok('GET org A members excludes org B owner');

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (fails.length) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ❌ ' + f)); }

  tierService.getOrgTier = realGetOrgTier;
  tierService.getOrgTierConfig = realGetOrgTierConfig;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
