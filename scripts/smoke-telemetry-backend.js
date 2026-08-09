/**
 * Usage-telemetry backend smoke (USAGE-TELEMETRY-PLAN.md) — boots the REAL
 * backend (src/index.js) on a throwaway port against a disposable in-memory
 * Mongo, then drives it over HTTP like a client: ingest → org derivation →
 * per-user limiter → rollup → admin usage endpoints (+ an authz probe).
 * Prints PASS/FAIL lines and exits non-zero on any failure. No external
 * services, no real DB touched.
 *
 *   node scripts/smoke-telemetry-backend.js
 *
 * For the browser leg, use smoke-telemetry-server.js (keep-alive variant)
 * plus suparank/scripts/smoke-telemetry-browser.js.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.ACCESS_TOKEN_SECRET = 'smoke-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'smoke-refresh-secret';
process.env.ADMIN_EMAILS = 'smoke-admin@test.dev';
process.env.ENGINE_URL = 'http://127.0.0.1:1/';
process.env.WRITING_ENGINE_URL = 'http://127.0.0.1:2/';
process.env.PORT = '4599';
// webhookController news up Stripe at module load — dummy keys keep the boot
// alive exactly like the e2e harness does; no Stripe call is made in this smoke.
process.env.STRIPE_SECRET_KEY = 'sk_test_smoke_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_smoke_dummy';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_smoke_dummy2';

const path = require('path');
const BACKEND = path.join(__dirname, '..');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BASE = 'http://127.0.0.1:4599';
let pass = 0, fail = 0;
const check = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('── boot ──────────────────────────────────────');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  require(path.join(BACKEND, 'src/index.js')); // the real app: middleware, limiters, routes, crons

  let up = false;
  for (let i = 0; i < 120; i++) {
    try { await fetch(BASE + '/health'); up = true; break; } catch { await sleep(500); }
  }
  check(up, 'backend boots and listens on :4599');
  if (!up) process.exit(1);
  await sleep(1500); // let configSync finish seeding roles/flags/tiers

  // ── seed: user, admin, org, workspace, sessions (raw inserts, like tests) ──
  const User = require(path.join(BACKEND, 'src/models/User'));
  const Session = require(path.join(BACKEND, 'src/models/Session'));
  const Organization = require(path.join(BACKEND, 'src/models/Organization'));
  const Workspace = require(path.join(BACKEND, 'src/models/Workspace'));
  const ObservationEvent = require(path.join(BACKEND, 'src/models/ObservationEvent'));
  const ObservationDailyRollup = require(path.join(BACKEND, 'src/models/ObservationDailyRollup'));

  const oid = () => new mongoose.Types.ObjectId();
  const uid = oid(), aid = oid(), orgId = oid(), sess = oid(), asess = oid();
  // userId (numeric, unique-indexed) must be set explicitly on raw inserts.
  await User.collection.insertMany([
    { _id: uid, userId: 990001, email: 'smoke-user@test.dev', status: 'active', tokenVersion: 0, profile: { name: 'Smoke User' } },
    { _id: aid, userId: 990002, email: 'smoke-admin@test.dev', status: 'active', tokenVersion: 0, profile: { name: 'Smoke Admin' } },
  ]);
  await Session.collection.insertMany([
    { _id: sess, userId: uid, status: 'active', createdAt: new Date() },
    { _id: asess, userId: aid, status: 'active', createdAt: new Date() },
  ]);
  await Organization.collection.insertOne({ _id: orgId, name: 'Smoke Org', ownerId: uid, isPersonal: false });
  await Workspace.collection.insertOne({ workspaceNumber: 9001, organizationId: orgId, userId: uid, name: 'Smoke WS' });

  const mint = (userId, email, sessionId) => jwt.sign(
    { userId: String(userId), email, roles: [], sessionId: String(sessionId), tokenVersion: 0 },
    process.env.ACCESS_TOKEN_SECRET, { algorithm: 'HS256', expiresIn: '1h' },
  );
  const userTok = mint(uid, 'smoke-user@test.dev', sess);
  const adminTok = mint(aid, 'smoke-admin@test.dev', asess);
  const post = (p, body, tok) => fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
  const get = (p, tok) => fetch(BASE + p, { headers: { Authorization: `Bearer ${tok}` } });

  console.log('── 1. ingest: registry gate + server-side org derivation ──');
  const r1 = await post('/api/observe', { events: [
    { event: 'editor_opened', ts: Date.now(), payload: { workspaceNumber: 9001, scoreAtOpen: 42 } },
    { event: 'ai_chat_message_sent', ts: Date.now(), payload: { workspaceNumber: 9001, chars: 12 } },
    { event: 'totally_fake_event', ts: Date.now(), payload: {} },
  ] }, userTok);
  const b1 = await r1.json();
  check(r1.status === 200 && b1.ok === true, 'POST /api/observe accepted', JSON.stringify(b1));
  check(b1.stored === 2, 'unknown event silently dropped (stored=2)', `stored=${b1.stored}`);
  await sleep(300); // insertMany is fire-and-forget
  const rows = await ObservationEvent.find({ event: { $in: ['editor_opened', 'ai_chat_message_sent', 'totally_fake_event'] } }).lean();
  check(rows.length === 2, 'exactly the 2 registered events persisted', `rows=${rows.length}`);
  check(rows.every((r) => String(r.organizationId) === String(orgId)), 'organizationId DERIVED from workspaceNumber (not client-supplied)');
  check(rows.every((r) => r.impersonatedBy == null && String(r.userId) === String(uid)), 'userId stamped, impersonatedBy null');

  console.log('── 2. per-user rate limiter (60/min) ──');
  let limited = 0, okCount = 0;
  for (let i = 0; i < 70; i++) {
    const r = await post('/api/observe', { events: [{ event: 'nav_item_clicked', ts: Date.now(), payload: { item: 'smoke' } }] }, userTok);
    if (r.status === 429) limited++;
    else if (r.status === 200) okCount++;
  }
  check(limited > 0, 'excess requests 429 (per-user limiter live)', `ok=${okCount} 429=${limited}`);
  check(okCount >= 55, 'well over 50 requests succeeded before the cap', `ok=${okCount}`);

  console.log('── 3. rollup: backdate → runDailyRollup → durable rows ──');
  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
  // Raw driver: Mongoose strips $set on immutable timestamp paths silently.
  await ObservationEvent.collection.updateMany({}, { $set: { createdAt: yesterday, updatedAt: yesterday } });
  const { runDailyRollup } = require(path.join(BACKEND, 'src/services/observationRollupService'));
  const rr = await runDailyRollup({ days: 3 });
  check(rr.rows > 0, 'runDailyRollup wrote rollup rows', `rows=${rr.rows}`);
  const roll = await ObservationDailyRollup.findOne({ event: 'editor_opened' }).lean();
  check(!!roll && roll.count === 1 && roll.uniqueUsers === 1, 'editor_opened rollup row: count=1, uniqueUsers=1', JSON.stringify({ count: roll?.count, users: roll?.uniqueUsers }));
  check(!!roll && String(roll.organizationId) === String(orgId) && roll.workspaceNumber === 9001, 'rollup carries org + workspace dimensions');

  console.log('── 4. admin usage endpoints ──');
  const denied = await get('/api/admin/usage/overview?days=7', userTok);
  check(denied.status === 403, 'non-admin gets 403 on admin usage endpoints', `status=${denied.status}`);

  const ov = await (await get('/api/admin/usage/overview?days=7', adminTok)).json();
  check(ov.current?.activeWorkspaces === 1 && ov.current?.activeUsers === 1, 'overview: 1 active workspace, 1 active user', JSON.stringify(ov.current));
  check((ov.lanes?.client ?? 0) > 0, 'overview: client-lane events counted', `client=${ov.lanes?.client}`);
  check(Array.isArray(ov.topEvents) && ov.topEvents.some((t) => t.event === 'nav_item_clicked'), 'overview: topEvents includes the flood event');

  const fu = await (await get('/api/admin/usage/funnels?days=7', adminTok)).json();
  const editor = (fu.funnels || []).find((f) => f.id === 'editor');
  check(fu.mode === 'stage-reach' && !!editor, 'funnels respond in stage-reach mode');
  check(editor?.stages?.[0]?.actors === 1 && editor?.stages?.[1]?.actors === 1, 'editor funnel: opened=1 actor, engaged=1 actor', JSON.stringify(editor?.stages?.map((s) => s.actors)));
  const reports = (fu.funnels || []).find((f) => f.id === 'reports');
  check(reports?.annotations?.every((a) => a.label !== 'End-client opens' || a.countOnly === true), 'countOnly flag flows through the API (V4-4)');

  const se = await (await get('/api/admin/usage/series?days=7', adminTok)).json();
  check(Array.isArray(se.series) && se.series.length === 1 && se.series[0].count >= 2, 'series: one rolled day with the seeded volume', JSON.stringify(se.series));

  const ur = await (await get('/api/admin/usage-rollups?days=7', adminTok)).json();
  check(Array.isArray(ur.rows) && ur.rows.length > 0, 'usage-rollups raw reader returns rows', `rows=${ur.rows?.length}`);

  console.log('──────────────────────────────────────────────');
  console.log(`SMOKE ${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
  await mongoose.disconnect().catch(() => {});
  await mongod.stop().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE CRASHED:', e); process.exit(1); });
