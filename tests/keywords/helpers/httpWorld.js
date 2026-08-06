/**
 * Phase C3 — a REAL HTTP harness for the keyword routes.
 *
 * Everything in the Phase-B tier called controllers directly with a
 * hand-built req, which proves the handlers right but proves nothing about
 * the middleware chain in front of them. This mounts the ACTUAL
 * keywordRoutes.js on an Express app and drives it over a real socket, so a
 * request passes authenticateToken → resolveWorkspaceWithRole →
 * requireFeature('keywords') → requirePermission/rp → requireQuota →
 * requireCredits → handler exactly as production does.
 *
 * That is what makes the K1 regression here meaningful: if someone deletes
 * the gate from the route, this fails — the controller test would not.
 */

const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret';

const User = require('../../../src/models/User');
const Organization = require('../../../src/models/Organization');
const OrgMember = require('../../../src/models/OrgMember');
const Workspace = require('../../../src/models/Workspace');
const Permission = require('../../../src/models/Permission');
const FeatureFlag = require('../../../src/models/FeatureFlag');
const permissions = require('../../../src/middleware/permissions');

const ROLES = ['owner', 'admin', 'editor', 'viewer', 'client'];

/** The legacy Permission grid rows the keyword routes consult (rp('keywords', ...)). */
const KEYWORD_PERMISSION_GRID = [
  // role,      resource,   action,  allowed
  ['owner', 'keywords', 'read', true],
  ['admin', 'keywords', 'read', true],
  ['editor', 'keywords', 'read', true],
  ['viewer', 'keywords', 'read', true],
  ['client', 'keywords', 'read', true],
  ['owner', 'keywords', 'use', true],
  ['admin', 'keywords', 'use', true],
  ['editor', 'keywords', 'use', true],
  ['viewer', 'keywords', 'use', false],
  ['client', 'keywords', 'use', false],
];

/** Seed the permission grid + feature flag the routes require. */
async function seedGrid() {
  await Permission.deleteMany({ resource: 'keywords' });
  await Permission.insertMany(
    KEYWORD_PERMISSION_GRID.map(([role, resource, action, allowed]) => ({ role, resource, action, allowed })),
  );
  await FeatureFlag.deleteMany({ key: 'keywords' });
  await FeatureFlag.create({
    key: 'keywords',
    displayName: 'Keyword Research',
    enabled: true,
    implemented: true,
  });
  // Both caches are 5-minute TTL — stale entries across tests would silently
  // grant or deny the wrong thing (the PRIMITIVES §8 trap).
  permissions.clearPermissionCache();
}

// Monotonic across the whole file so re-seeding in beforeEach never collides
// with the unique indexes on Organization.slug / User.userId / User.email.
let wsCounter = 981000;
let userCounter = 981000;
let orgCounter = 981000;

/**
 * Seed a complete tenant reachable over HTTP.
 * `role` is the requesting user's role in the org: 'owner' makes them the
 * org owner; anything else creates an OrgMember with that role.
 */
async function seedHttpTenant(tag, { role = 'owner' } = {}) {
  const ownerId = new mongoose.Types.ObjectId();
  const org = await Organization.create({
    name: `Org ${tag}`,
    ownerId,
    slug: `org-${tag.toLowerCase()}-${orgCounter++}`,
  });

  const userNum = userCounter++;
  const user = await User.create({
    _id: role === 'owner' ? ownerId : new mongoose.Types.ObjectId(),
    userId: userNum,
    email: `${tag.toLowerCase()}-${userNum}@test.local`,
    password: 'hashed-not-used',
    name: `User ${tag}`,
    status: 'active',
    tokenVersion: 0,
  });

  if (role !== 'owner') {
    // The org still needs a real owner user for resolveWorkspaceRole.
    const ownerNum = userCounter++;
    await User.create({
      _id: ownerId,
      userId: ownerNum,
      email: `owner-${tag.toLowerCase()}-${ownerNum}@test.local`,
      password: 'hashed-not-used',
      name: `Owner ${tag}`,
      status: 'active',
      tokenVersion: 0,
    });
    await OrgMember.create({
      organizationId: org._id,
      ownerId,
      userId: user._id,
      email: user.email,
      role,
      status: 'active',
      accessScope: 'all',
    });
  }

  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: ownerId,
    organizationId: org._id,
    name: `Workspace ${tag}`,
  });

  const token = jwt.sign(
    { userId: user._id.toString(), email: user.email, tokenVersion: 0 },
    process.env.ACCESS_TOKEN_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );

  return { org, orgId: org._id, user, userId: user._id, ws, token, role };
}

/** Mount the REAL router exactly as src/index.js does. */
function startServer() {
  const keywordRoutes = require('../../../src/routes/keywordRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/workspace', keywordRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Issue a real HTTP request against the mounted router. */
function request(server, method, path, { token, body } = {}) {
  const addr = server.address();
  const payload = body ? JSON.stringify(body) : null;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: addr.address, port: addr.port, path, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { _raw: raw }; }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { seedHttpTenant, seedGrid, startServer, request, ROLES, KEYWORD_PERMISSION_GRID };
