/**
 * Multi-admin (5 env slots) end-to-end verification.
 *
 * Boots the REAL adminRoutes behind authenticateToken against a throwaway local
 * mongod, sets ADMIN_EMAILS + ADMIN_EMAILS_2..5 to five distinct emails, seeds a
 * user per slot (+ a non-admin and a role-only user), and asserts over real HTTP:
 *   1. every slot grants admin (GET /settings/admins → 200)
 *   2. a non-admin is 403, no token is 401
 *   3. userLookup bootstrap: env admins valid, a role-only account is 403 (env-only)
 *   4. isAdminEmail recognizes all 5 slots (the impersonation guard uses this)
 *   5. the retired add/remove route is 410 even for an admin
 *
 * Run: mongod on :27100, then `node tests/manual/multiAdminVerify.js`
 */
const PORT = 4997;
const DB = 'mongodb://127.0.0.1:27100/multi_admin_verify_' + process.pid;
process.env.MONGODB_URI = DB;
process.env.ACCESS_TOKEN_SECRET = 'multi-admin-verify-secret';
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
delete process.env.IMPERSONATION_ENABLED;
// Five distinct admin slots — the whole point of the test.
process.env.ADMIN_EMAILS = 'slot1@x.co';
process.env.ADMIN_EMAILS_2 = 'slot2@x.co';
process.env.ADMIN_EMAILS_3 = 'slot3@x.co';
process.env.ADMIN_EMAILS_4 = 'slot4@x.co';
process.env.ADMIN_EMAILS_5 = 'slot5@x.co';

const mongoose = require('mongoose');
const express = require('express');
const User = require('../../src/models/User');
const adminRoutes = require('../../src/routes/adminRoutes');
const { generateAccessToken } = require('../../src/utils/jwt');
const { isAdminEmail } = require('../../src/utils/adminEmails');

let pass = 0, fail = 0;
const fails = [];
const ok = (n) => { pass++; console.log('  ✓', n); };
const bad = (n, d) => { fail++; fails.push(`${n} → ${d}`); console.log('  ✗', n, '—', d); };

async function call(method, path, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  return res.status;
}

(async () => {
  await mongoose.connect(DB);
  await mongoose.connection.dropDatabase();

  const mk = (userId, email, roles = ['member']) =>
    User.create({ userId, email, name: email, status: 'active', roles, tokenVersion: 0 });

  const admins = [];
  for (let i = 1; i <= 5; i++) admins.push(await mk(900000 + i, `slot${i}@x.co`));
  const nonAdmin = await mk(900010, 'nobody@x.co');
  const roleOnly = await mk(900011, 'roleonly@x.co', ['admin', 'super_admin']);

  const tok = (u) => generateAccessToken({ _id: u._id, email: u.email, roles: u.roles, tokenVersion: 0 }, undefined);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));

  console.log('\n── 1. Each of the 5 env slots grants admin (GET /settings/admins → 200) ──');
  for (let i = 0; i < 5; i++) {
    const s = await call('GET', '/api/admin/settings/admins', tok(admins[i]));
    s === 200 ? ok(`slot${i + 1} admin → 200`) : bad(`slot${i + 1} admin`, `got ${s}, expected 200`);
  }

  console.log('── 2. A non-admin is blocked, a missing token is 401 ──');
  {
    const s = await call('GET', '/api/admin/settings/admins', tok(nonAdmin));
    s === 403 ? ok('non-admin → 403') : bad('non-admin', `got ${s}, expected 403`);
    const s2 = await call('GET', '/api/admin/settings/admins', null);
    s2 === 401 ? ok('no token → 401') : bad('no token', `got ${s2}, expected 401`);
  }

  console.log('── 3. Bootstrap userLookup: env admins valid, role-only rejected (env-only) ──');
  {
    const s = await call('POST', '/api/admin/user-lookup', tok(admins[2])); // slot 3
    s === 200 ? ok('slot3 admin → user-lookup 200') : bad('slot3 user-lookup', `got ${s}, expected 200`);
    const s2 = await call('POST', '/api/admin/user-lookup', tok(roleOnly));
    s2 === 403 ? ok('role-only (not in env) → user-lookup 403') : bad('role-only user-lookup', `got ${s2}, expected 403 (env-only)`);
  }

  console.log('── 4. isAdminEmail recognizes all 5 slots (impersonation guard uses this) ──');
  for (let i = 1; i <= 5; i++) {
    isAdminEmail(`slot${i}@x.co`) ? ok(`isAdminEmail slot${i} → true`) : bad(`isAdminEmail slot${i}`, 'false');
  }
  isAdminEmail('nobody@x.co') === false ? ok('isAdminEmail non-admin → false') : bad('isAdminEmail non-admin', 'true');

  console.log('── 5. Retired mutation route is 410 for an admin ──');
  {
    const s = await call('POST', '/api/admin/settings/admins', tok(admins[0]));
    s === 410 ? ok('POST /settings/admins → 410 (retired)') : bad('retired route', `got ${s}, expected 410`);
  }

  console.log(`\n════  ${pass} passed, ${fail} failed  ════`);
  if (fails.length) fails.forEach((f) => console.log('  ❌ ' + f));

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
