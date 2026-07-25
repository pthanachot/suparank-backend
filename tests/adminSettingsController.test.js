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
// Admin identity is env-only (Phase 2) across all five Railway slots.
const SLOTS = ['ADMIN_EMAILS', 'ADMIN_EMAILS_2', 'ADMIN_EMAILS_3', 'ADMIN_EMAILS_4', 'ADMIN_EMAILS_5'];
const REAL_SLOTS = Object.fromEntries(SLOTS.map((s) => [s, process.env[s]]));

after(() => {
  User.find = realFind;
  User.exists = realExists;
  for (const s of SLOTS) {
    if (REAL_SLOTS[s] === undefined) delete process.env[s];
    else process.env[s] = REAL_SLOTS[s];
  }
});

beforeEach(() => {
  state.settings.adminEmails = [];
  state.updateCalls = [];
  for (const s of SLOTS) delete process.env[s];
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

describe('listAdmins (env-only, read-only)', () => {
  it('lists every env slot as a locked env admin, deduped, with isYou', async () => {
    process.env.ADMIN_EMAILS = 'root@suparank.ai, Shared@x.com';
    process.env.ADMIN_EMAILS_2 = 'shared@x.com'; // duplicate across slots collapses
    process.env.ADMIN_EMAILS_4 = 'extra@x.com';
    const res = mockRes();
    await controller.listAdmins(asAdmin('extra@x.com'), res);
    assert.equal(res.statusCode, 200);
    const byEmail = Object.fromEntries(res.body.admins.map((a) => [a.email, a]));
    assert.equal(res.body.admins.length, 3, 'shared@x.com must not appear twice');
    assert.equal(byEmail['root@suparank.ai'].locked, true);
    assert.equal(byEmail['root@suparank.ai'].source, 'env');
    assert.equal(byEmail['shared@x.com'].source, 'env');
    assert.equal(byEmail['extra@x.com'].isYou, true);
  });

  it('ignores the deprecated DB adminEmails list entirely', async () => {
    process.env.ADMIN_EMAILS = 'env@x.com';
    state.settings.adminEmails = ['legacy-db@x.com'];
    const res = mockRes();
    await controller.listAdmins(asAdmin('env@x.com'), res);
    const emails = res.body.admins.map((a) => a.email);
    assert.deepEqual(emails, ['env@x.com']);
    assert.ok(!emails.includes('legacy-db@x.com'), 'DB list must no longer appear');
  });

  it('no longer exposes add/remove handlers', () => {
    assert.equal(typeof controller.addAdmin, 'undefined');
    assert.equal(typeof controller.removeAdmin, 'undefined');
  });
});
