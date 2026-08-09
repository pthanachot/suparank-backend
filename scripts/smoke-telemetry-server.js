/**
 * Keep-alive variant of smoke-telemetry-backend.js for the browser leg:
 * boots the real backend on :4599 against in-memory Mongo, seeds the same
 * user/admin/org/workspace (onboarding completed, so the shell doesn't bounce
 * to the wizard), pre-rolls one backdated day (so the admin Daily chart has a
 * bar), writes tokens to a session file, then STAYS ALIVE until killed.
 *
 * Full browser-leg recipe:
 *   1. node scripts/smoke-telemetry-server.js            (this file, backend/)
 *   2. API_URL=http://127.0.0.1:4599 npx next dev -p 3599   (suparank/)
 *   3. node scripts/smoke-telemetry-browser.js           (suparank/, Node 22+)
 *
 * Session file: $SMOKE_SESSION_FILE or <os tmpdir>/suparank-smoke-session.json
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.ACCESS_TOKEN_SECRET = 'smoke-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'smoke-refresh-secret';
process.env.ADMIN_EMAILS = 'smoke-admin@test.dev';
process.env.ENGINE_URL = 'http://127.0.0.1:1/';
process.env.WRITING_ENGINE_URL = 'http://127.0.0.1:2/';
process.env.PORT = '4599';
process.env.STRIPE_SECRET_KEY = 'sk_test_smoke_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_smoke_dummy';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_smoke_dummy2';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BACKEND = path.join(__dirname, '..');
const SESSION_FILE = process.env.SMOKE_SESSION_FILE || path.join(os.tmpdir(), 'suparank-smoke-session.json');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  require(path.join(BACKEND, 'src/index.js'));

  for (let i = 0; i < 120; i++) {
    try { await fetch('http://127.0.0.1:4599/health'); break; } catch { await sleep(500); }
  }
  await sleep(1500);

  const User = require(path.join(BACKEND, 'src/models/User'));
  const Session = require(path.join(BACKEND, 'src/models/Session'));
  const Organization = require(path.join(BACKEND, 'src/models/Organization'));
  const Workspace = require(path.join(BACKEND, 'src/models/Workspace'));
  const ObservationEvent = require(path.join(BACKEND, 'src/models/ObservationEvent'));

  const oid = () => new mongoose.Types.ObjectId();
  const uid = oid(), aid = oid(), orgId = oid(), sess = oid(), asess = oid();
  // onboarding.completed — without it the shell bounces every page to the wizard.
  const done = { completed: true, completedAt: new Date() };
  await User.collection.insertMany([
    { _id: uid, userId: 990001, email: 'smoke-user@test.dev', status: 'active', tokenVersion: 0, profile: { name: 'Smoke User' }, onboarding: done },
    { _id: aid, userId: 990002, email: 'smoke-admin@test.dev', status: 'active', tokenVersion: 0, profile: { name: 'Smoke Admin' }, onboarding: done },
  ]);
  await Session.collection.insertMany([
    { _id: sess, userId: uid, status: 'active', createdAt: new Date() },
    { _id: asess, userId: aid, status: 'active', createdAt: new Date() },
  ]);
  await Organization.collection.insertOne({ _id: orgId, name: 'Smoke Org', ownerId: uid, isPersonal: false });
  await Workspace.collection.insertOne({ workspaceNumber: 9001, organizationId: orgId, userId: uid, name: 'Smoke WS' });

  // A backdated day of events → rolled up, so the Daily chart shows a bar.
  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
  const back = (event, n) => Array.from({ length: n }, () => ({
    event, userId: uid, workspaceNumber: 9001, organizationId: orgId,
    impersonatedBy: null, payload: {}, createdAt: yesterday, updatedAt: yesterday,
  }));
  await ObservationEvent.collection.insertMany([
    ...back('editor_opened', 3), ...back('ai_chat_message_sent', 5), ...back('keyword_search', 2),
  ]);
  const { runDailyRollup } = require(path.join(BACKEND, 'src/services/observationRollupService'));
  const rolled = await runDailyRollup({ days: 3 });

  const mint = (userId, email, sessionId) => jwt.sign(
    { userId: String(userId), email, roles: [], sessionId: String(sessionId), tokenVersion: 0 },
    process.env.ACCESS_TOKEN_SECRET, { algorithm: 'HS256', expiresIn: '12h' },
  );
  const out = {
    userToken: mint(uid, 'smoke-user@test.dev', sess),
    adminToken: mint(aid, 'smoke-admin@test.dev', asess),
    userId: 990001, adminId: 990002, workspaceNumber: 9001,
    orgId: String(orgId), rolledRows: rolled.rows,
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(out, null, 2));
  console.log(`SMOKE BACKEND READY on :4599 — rolled ${rolled.rows} rollup rows; tokens in ${SESSION_FILE}`);
  // Stay alive until killed.
})().catch((e) => { console.error('SMOKE SERVER CRASHED:', e); process.exit(1); });
