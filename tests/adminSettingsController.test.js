/**
 * Tests for adminSettingsController — settings PUT validation and the
 * admin-accounts guardrails (env-locked floor, last-admin, self-removal
 * confirmation). systemSettingsService is faked via require-cache injection;
 * the User model is monkey-patched. No database.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Fake settings service (installed BEFORE requiring the controller) ──
const state = {
  settings: {
    maintenanceMode: false,
    emailNotificationsEnabled: true,
    rateLimit: { windowMs: null, max: null },
    adminEmails: [],
    backup: { directory: null, retentionCount: 7 },
  },
  updateCalls: [],
};

require.cache[require.resolve('../src/services/systemSettingsService')] = {
  exports: {
    getSettings: () => state.settings,
    updateSettings: async (patch) => {
      state.updateCalls.push(patch);
      return state.settings;
    },
    loadSettings: async () => state.settings,
    onSettingsChange: () => {},
    DEFAULTS: {},
  },
};

const controller = require('../src/controllers/adminSettingsController');
const User = require('../src/models/User');

const realFind = User.find;
const realExists = User.exists;
const REAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

after(() => {
  User.find = realFind;
  User.exists = realExists;
  if (REAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = REAL_ADMIN_EMAILS;
});

beforeEach(() => {
  state.settings.adminEmails = [];
  state.updateCalls = [];
  process.env.ADMIN_EMAILS = 'root@suparank.ai';
  User.find = () => ({ select: () => ({ lean: async () => [] }) });
  User.exists = async () => true;
});

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const asAdmin = (email = 'root@suparank.ai') => ({ user: { email } });

// ── Settings PUT validation ────────────────────────────────────

describe('updateSystemSettings validation', () => {
  async function put(body) {
    const req = { ...asAdmin(), body };
    const res = mockRes();
    await controller.updateSystemSettings(req, res);
    return res;
  }

  it('rejects non-boolean maintenanceMode', async () => {
    assert.equal((await put({ maintenanceMode: 'yes' })).statusCode, 400);
  });

  it('rejects windowMs below 1000ms and non-integers', async () => {
    assert.equal((await put({ rateLimit: { windowMs: 500 } })).statusCode, 400);
    assert.equal((await put({ rateLimit: { windowMs: 1.5 } })).statusCode, 400);
  });

  it('rejects max below 1', async () => {
    assert.equal((await put({ rateLimit: { max: 0 } })).statusCode, 400);
  });

  it('rejects retentionCount outside 1..100 and empty directory strings', async () => {
    assert.equal((await put({ backup: { retentionCount: 0 } })).statusCode, 400);
    assert.equal((await put({ backup: { retentionCount: 101 } })).statusCode, 400);
    assert.equal((await put({ backup: { directory: '   ' } })).statusCode, 400);
  });

  it('rejects an empty patch', async () => {
    assert.equal((await put({})).statusCode, 400);
  });

  it('accepts nulls (reset to defaults) and writes dot-path patches', async () => {
    const res = await put({ rateLimit: { windowMs: null, max: 200 }, backup: { directory: null } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(state.updateCalls[0], {
      'rateLimit.windowMs': null,
      'rateLimit.max': 200,
      'backup.directory': null,
    });
  });

  it('silently ignores adminEmails in the general PUT (dedicated endpoints own it)', async () => {
    const res = await put({ adminEmails: ['evil@x.com'], maintenanceMode: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(state.updateCalls[0], { maintenanceMode: true });
  });
});

// ── Admin accounts ─────────────────────────────────────────────

describe('listAdmins', () => {
  it('dedupes env/db overlap, flags locked and isYou', async () => {
    process.env.ADMIN_EMAILS = 'root@suparank.ai, Shared@x.com';
    state.settings.adminEmails = ['shared@x.com', 'extra@x.com'];
    const req = asAdmin('extra@x.com');
    const res = mockRes();
    await controller.listAdmins(req, res);
    assert.equal(res.statusCode, 200);
    const byEmail = Object.fromEntries(res.body.admins.map((a) => [a.email, a]));
    assert.equal(res.body.admins.length, 3, 'shared@x.com must not appear twice');
    assert.equal(byEmail['root@suparank.ai'].locked, true);
    assert.equal(byEmail['shared@x.com'].source, 'env');
    assert.equal(byEmail['extra@x.com'].locked, false);
    assert.equal(byEmail['extra@x.com'].isYou, true);
  });
});

describe('addAdmin', () => {
  async function add(email, actor = 'root@suparank.ai') {
    const req = { ...asAdmin(actor), body: { email } };
    const res = mockRes();
    await controller.addAdmin(req, res);
    return res;
  }

  it('rejects malformed emails', async () => {
    assert.equal((await add('not-an-email')).statusCode, 400);
    assert.equal((await add('')).statusCode, 400);
  });

  it('409s on duplicates (env or db, case-insensitive)', async () => {
    assert.equal((await add('ROOT@suparank.ai')).statusCode, 409);
    state.settings.adminEmails = ['dup@x.com'];
    assert.equal((await add('Dup@X.com')).statusCode, 409);
  });

  it('appends to the db list on success', async () => {
    state.settings.adminEmails = ['a@x.com'];
    const res = await add('New@X.com');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(state.updateCalls[0], { adminEmails: ['a@x.com', 'new@x.com'] });
  });
});

describe('removeAdmin guardrails', () => {
  async function remove(email, { actor = 'root@suparank.ai', confirm = false } = {}) {
    const req = {
      ...asAdmin(actor),
      params: { email },
      query: confirm ? { confirm: 'true' } : {},
    };
    const res = mockRes();
    await controller.removeAdmin(req, res);
    return res;
  }

  it('refuses to remove env-managed admins (403)', async () => {
    const res = await remove('root@suparank.ai');
    assert.equal(res.statusCode, 403);
    assert.equal(state.updateCalls.length, 0);
  });

  it('404s for unknown admins', async () => {
    assert.equal((await remove('ghost@x.com')).statusCode, 404);
  });

  it('blocks removing the last admin when the env floor is empty', async () => {
    process.env.ADMIN_EMAILS = '';
    state.settings.adminEmails = ['only@x.com'];
    const res = await remove('only@x.com', { actor: 'only@x.com', confirm: true });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /last admin/i);
  });

  it('requires ?confirm=true for self-removal', async () => {
    state.settings.adminEmails = ['me@x.com'];
    const denied = await remove('me@x.com', { actor: 'me@x.com' });
    assert.equal(denied.statusCode, 400);
    assert.match(denied.body.error, /confirm=true/);

    const allowed = await remove('me@x.com', { actor: 'me@x.com', confirm: true });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(state.updateCalls[0], { adminEmails: [] });
  });

  it('removes another db admin without ceremony', async () => {
    state.settings.adminEmails = ['a@x.com', 'b@x.com'];
    const res = await remove('a@x.com');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(state.updateCalls[0], { adminEmails: ['b@x.com'] });
  });
});
