/**
 * Admin portal end-to-end verification (Phases 5–10 fixes) against a REAL mongod.
 *
 * Boots the real adminRoutes behind authenticateToken, seeds real docs, and
 * exercises the actual fixes over HTTP — catching things mocks can't, e.g. real
 * Mongoose casting a string `amount` (the coercion bug would produce 10050, not
 * a string, once persisted). Covers: authz gate, credit/quota coercion (user +
 * org + bulk), CSV formula-injection neutralization, announcement open-redirect
 * rejection, feedback enum enforcement, plan override, and the retired route.
 *
 * Run: mongod on :27101, then `node tests/manual/adminE2EVerify.js`
 */
const PORT = 4996;
const DB = 'mongodb://127.0.0.1:27101/admin_e2e_' + process.pid;
process.env.MONGODB_URI = DB;
process.env.ACCESS_TOKEN_SECRET = 'admin-e2e-secret';
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
process.env.ADMIN_EMAILS = 'admin@e2e.co';
delete process.env.IMPERSONATION_ENABLED;

const mongoose = require('mongoose');
const express = require('express');
const User = require('../../src/models/User');
const Organization = require('../../src/models/Organization');
const Feedback = require('../../src/models/Feedback');
const CreditTransaction = require('../../src/models/CreditTransaction');
const adminRoutes = require('../../src/routes/adminRoutes');
const { generateAccessToken } = require('../../src/utils/jwt');

const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const fails = [];
const ok = (n) => { pass++; console.log('  ✓', n); };
const bad = (n, d) => { fail++; fails.push(`${n} → ${d}`); console.log('  ✗', n, '—', d); };

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV / non-JSON */ }
  return { status: res.status, text, json };
}

(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();

  const mk = (userId, email, roles = ['member']) =>
    User.create({ userId, email, name: email, status: 'active', roles, tokenVersion: 0 });
  const admin = await mk(700001, 'admin@e2e.co');
  const nonAdmin = await mk(700002, 'user@e2e.co');
  const target = await mk(700003, 'target@e2e.co');
  const org = await Organization.create({ name: 'E2E Org', slug: 'e2e-' + process.pid, ownerId: admin._id, lifecycleStatus: 'active' });
  const fb = await Feedback.create({ userId: target._id, userEmail: target.email, feature: 'content-editor', rating: 4, comment: 'x', status: 'new' });
  // CSV-injection fixture: an org NAME that is a spreadsheet formula + a txn on it.
  const evilOrg = await Organization.create({ name: '=1+1', slug: 'evil-' + process.pid, ownerId: admin._id, lifecycleStatus: 'active' });
  await CreditTransaction.logTransaction({ orgId: evilOrg._id, userId: null, type: 'general_grant', amount: 5, pool: 'general', description: 'seed', balanceAfter: 5 });

  const tok = (u) => generateAccessToken({ _id: u._id, email: u.email, roles: u.roles, tokenVersion: 0 }, undefined);
  const A = tok(admin);
  const N = tok(nonAdmin);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));

  console.log('\n── Authz gate ──');
  { const r = await call('GET', '/api/admin/stats', N); r.status === 403 ? ok('non-admin GET /stats → 403') : bad('non-admin /stats', `got ${r.status}`); }
  { const r = await call('GET', '/api/admin/stats', A); r.status === 200 ? ok('admin GET /stats → 200') : bad('admin /stats', `got ${r.status}`); }

  console.log('── Credit/quota coercion (real Mongoose cast) ──');
  await call('PUT', `/api/admin/users/${target.userId}/credits`, A, { action: 'add', amount: 100 });
  { const r = await call('PUT', `/api/admin/users/${target.userId}/credits`, A, { action: 'add', amount: '50' });
    r.json?.newFreeBalance === 150 ? ok("user credits add '50' string → 150 (not 10050)") : bad('user credit coercion', `newFreeBalance=${r.json?.newFreeBalance}`); }
  await call('PUT', `/api/admin/organizations/${org._id}/credits`, A, { action: 'add', amount: 100, pool: 'general' });
  { const r = await call('PUT', `/api/admin/organizations/${org._id}/credits`, A, { action: 'add', amount: '50', pool: 'general' });
    r.json?.newBalance === 150 ? ok("org credits add '50' string → 150") : bad('org credit coercion', `newBalance=${r.json?.newBalance}`); }
  { const r = await call('PUT', `/api/admin/users/${target.userId}/quota`, A, { counter: 'articlesCreated', action: 'add', amount: '5' });
    r.json?.newValue === 5 ? ok("user quota add '5' string → 5 (not 05)") : bad('user quota coercion', `newValue=${r.json?.newValue}`); }

  console.log('── Bulk credits (partial failure + coercion) ──');
  { const r = await call('POST', '/api/admin/credits/bulk', A, { targetType: 'user', targets: [String(target.userId), '999999'], operation: 'add', amount: '10' });
    (r.json?.succeeded === 1 && r.json?.failed === 1) ? ok('bulk: 1 succeeded, 1 not-found (no abort)') : bad('bulk partial-failure', `succeeded=${r.json?.succeeded} failed=${r.json?.failed}`); }

  console.log('── CSV export formula-injection ──');
  { const r = await call('GET', '/api/admin/credits/transactions/export', A);
    (r.text.includes("'=1+1") && !/,=1\+1,/.test(r.text)) ? ok("CSV neutralizes org name '=1+1' → \"'=1+1\"") : bad('CSV injection', `row: ${r.text.split('\n')[1] || r.text.slice(0, 120)}`); }

  console.log('── Announcement link open-redirect ──');
  { const r = await call('POST', '/api/admin/announcements', A, { title: 'T', link: '/\\evil.com' }); r.status === 400 ? ok('link /\\evil.com → 400 (backslash bypass blocked)') : bad('announcement backslash', `got ${r.status}`); }
  { const r = await call('POST', '/api/admin/announcements', A, { title: 'T', link: '//evil.com' }); r.status === 400 ? ok('link //evil.com → 400') : bad('announcement protocol-rel', `got ${r.status}`); }
  { const r = await call('POST', '/api/admin/announcements', A, { title: 'T', link: '/ok/path' }); r.status === 201 ? ok('link /ok/path → 201') : bad('announcement valid link', `got ${r.status}`); }

  console.log('── Feedback status enum (real runValidators) ──');
  { const r = await call('PUT', `/api/admin/feedback/${fb._id}`, A, { status: 'banana' }); r.status === 400 ? ok('feedback status "banana" → 400') : bad('feedback enum', `got ${r.status}`); }
  { const r = await call('PUT', `/api/admin/feedback/${fb._id}`, A, { status: 'resolved' }); r.status === 200 ? ok('feedback status "resolved" → 200') : bad('feedback valid status', `got ${r.status}`); }

  console.log('── Plan override (DB-only) + retired route ──');
  { const r = await call('PUT', `/api/admin/organizations/${org._id}/plan`, A, { planId: 'pro-monthly' }); r.status === 200 ? ok('overrideOrgPlan pro-monthly → 200') : bad('overrideOrgPlan', `got ${r.status}`); }
  { const r = await call('PUT', `/api/admin/organizations/${org._id}/plan`, A, { planId: 'galaxy-tier' }); r.status === 400 ? ok('overrideOrgPlan invalid → 400') : bad('overrideOrgPlan invalid', `got ${r.status}`); }
  { const r = await call('POST', '/api/admin/settings/admins', A, { email: 'x@y.co' }); r.status === 410 ? ok('POST /settings/admins → 410 (retired, env-only)') : bad('retired route', `got ${r.status}`); }

  console.log('── Self-target guard (Phase 11) ──');
  { const r = await call('DELETE', `/api/admin/users/${admin.userId}`, A); r.status === 400 ? ok('DELETE own account → 400 (self-guard, before any deletion)') : bad('self-delete guard', `got ${r.status}`); }
  { const r = await call('PUT', `/api/admin/users/${admin.userId}`, A, { status: 'suspended' }); r.status === 400 ? ok('suspend own account → 400') : bad('self-suspend guard', `got ${r.status}`); }
  { const r = await call('PUT', `/api/admin/users/${target.userId}`, A, { status: 'suspended' }); r.status === 200 ? ok('suspend ANOTHER user → 200') : bad('suspend other', `got ${r.status}`); }

  console.log('── Audit-log instrumentation (Phase 14) ──');
  // Fire-and-forget writes — give them a moment to land.
  await new Promise((r) => setTimeout(r, 400));
  const AdminAuditLog = require('../../src/models/AdminAuditLog');
  const rows = await AdminAuditLog.find({}).lean();
  const actions = new Set(rows.map((r) => r.action));
  rows.length > 0 ? ok(`audit rows written to AdminAuditLog (${rows.length})`) : bad('audit rows', 'none written');
  actions.has('admin.user.credits') ? ok('admin.user.credits row present') : bad('credits audit', [...actions].join(',') || 'none');
  actions.has('admin.org.plan_override') ? ok('admin.org.plan_override row present') : bad('plan-override audit', [...actions].join(',') || 'none');
  actions.has('admin.user.update') ? ok('admin.user.update row present (suspend other)') : bad('user-update audit', [...actions].join(',') || 'none');
  rows.length && rows.every((r) => r.actorEmail === 'admin@e2e.co') ? ok('every row attributed to admin@e2e.co') : bad('actor attribution', 'mismatch/none');

  console.log('── Audit-log read API (Phase 15) ──');
  { const r = await call('GET', '/api/admin/audit-log?limit=5', A);
    (r.status === 200 && Array.isArray(r.json?.rows) && r.json.rows.length > 0) ? ok(`list returns rows (${r.json.rows.length})`) : bad('list', `status ${r.status}`); }
  { const r = await call('GET', '/api/admin/audit-log?action=admin.user.credits', A);
    (r.json?.rows?.length > 0 && r.json.rows.every((x) => x.action === 'admin.user.credits')) ? ok('action filter returns only that action') : bad('action filter', JSON.stringify((r.json?.rows || []).map((x) => x.action))); }
  { const r = await call('GET', '/api/admin/audit-log/export', A);
    r.text.startsWith('Date,Actor,Action') ? ok('export returns CSV with header') : bad('export', r.text.slice(0, 60)); }
  { const p1 = await call('GET', '/api/admin/audit-log?limit=3', A);
    if (p1.json?.nextCursor) {
      const p2 = await call('GET', `/api/admin/audit-log?limit=3&cursor=${encodeURIComponent(p1.json.nextCursor)}`, A);
      const overlap = p1.json.rows.some((a) => (p2.json?.rows || []).some((b) => String(a._id) === String(b._id)));
      !overlap ? ok('keyset pagination: page 2 does not overlap page 1') : bad('keyset', 'pages overlap');
    } else { ok('keyset: single page'); }
  }

  console.log(`\n════  ${pass} passed, ${fail} failed  ════`);
  if (fails.length) fails.forEach((f) => console.log('  ❌ ' + f));

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
