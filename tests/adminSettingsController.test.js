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

  // disabledAgentCommands is the runtime kill-switch for slash commands
  // (Phase 2). Names are validated against the server command registry so a
  // typo can't look like it disabled something.
  it('accepts a valid disabledAgentCommands list, [] and null', async () => {
    assert.equal((await put({ disabledAgentCommands: ['image', 'auto-optimize'] })).statusCode, 200);
    assert.deepEqual(state.updateCalls[0], { disabledAgentCommands: ['image', 'auto-optimize'] });

    assert.equal((await put({ disabledAgentCommands: [] })).statusCode, 200);
    assert.deepEqual(state.updateCalls[1], { disabledAgentCommands: [] });

    assert.equal((await put({ disabledAgentCommands: null })).statusCode, 200);
    assert.deepEqual(state.updateCalls[2], { disabledAgentCommands: null });
  });

  it('rejects unknown, non-string and prototype-chain command names', async () => {
    assert.equal((await put({ disabledAgentCommands: ['nope'] })).statusCode, 400);
    assert.equal((await put({ disabledAgentCommands: [42] })).statusCode, 400);
    assert.equal((await put({ disabledAgentCommands: 'image' })).statusCode, 400);
    // A bare TABLE[c] lookup would accept these as real command names.
    assert.equal((await put({ disabledAgentCommands: ['constructor'] })).statusCode, 400);
    assert.equal((await put({ disabledAgentCommands: ['toString'] })).statusCode, 400);
    assert.equal(state.updateCalls.length, 0);
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

// ── Settings GET: what the admin console needs to render ───────
//
// Command availability used to be a build-time constant, so the console has no
// list of its own. It renders whatever this endpoint reports, which is the
// point: the same registry the PUT validates against, so the UI can never
// offer a toggle the API then rejects as unknown — nor hide one that is
// switched off in production and would otherwise be unreachable from here.
describe('getSystemSettings — admin console payload', () => {
  async function get() {
    const res = mockRes();
    await controller.getSystemSettings(asAdmin(), res);
    return res;
  }

  it('returns the settings document', async () => {
    const res = await get();
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.settings, 'settings must still be returned');
  });

  it('lists every command the PUT would accept', async () => {
    const { COMMAND_TOOLS } = require('../src/config/agentBilling');
    const res = await get();
    assert.deepEqual(
      [...res.body.knownAgentCommands].sort(),
      Object.keys(COMMAND_TOOLS).sort(),
      'the console renders this list — a command missing here cannot be toggled at all',
    );
  });

  it('every advertised command actually validates on PUT', async () => {
    // The two halves of the contract, checked against each other rather than
    // against a copied literal: offering a name the PUT rejects would give the
    // operator a toggle that always errors.
    const res = await get();
    const put = mockRes();
    await controller.updateSystemSettings(
      { ...asAdmin(), body: { disabledAgentCommands: res.body.knownAgentCommands } },
      put,
    );
    assert.equal(put.statusCode, 200, `PUT rejected its own advertised list: ${put.body?.error}`);
  });

  it('reports which commands are off by DEFAULT, not just which are off', async () => {
    // `disabledAgentCommands: null` means "use the default". Without this the
    // console would show an empty selection and report /image as enabled when
    // it is not.
    const { DEFAULT_DISABLED_AGENT_COMMANDS } = require('../src/config/agentBilling');
    const res = await get();
    assert.deepEqual(
      [...res.body.defaultDisabledAgentCommands].sort(),
      [...DEFAULT_DISABLED_AGENT_COMMANDS].sort(),
    );
    assert.ok(res.body.defaultDisabledAgentCommands.includes('image'),
      '/image ships off; a console that showed it on would be lying about production');
  });

  it('the default set is itself a subset of the known commands', async () => {
    // A default naming a command the registry does not have would render a
    // toggle for something that cannot exist.
    const res = await get();
    for (const name of res.body.defaultDisabledAgentCommands) {
      assert.ok(res.body.knownAgentCommands.includes(name),
        `default-disabled "${name}" is not a known command`);
    }
  });
});

// ── Provenance for the command kill-switch ─────────────────────
//
// Enabling /image makes a money-spending command available to every workspace
// at once, with no deploy and no per-tenant rollout. "Who turned this on, and
// when" therefore has to survive in the audit trail — it is the only record,
// since the setting itself stores just the resulting array.
describe('command-availability changes are audited', () => {
  const adminAudit = require('../src/services/adminAuditService');

  it('records the command patch, not just that settings changed', async () => {
    const calls = [];
    const real = adminAudit.fromReq;
    adminAudit.fromReq = (req, entry) => { calls.push({ email: req.user?.email, entry }); };
    try {
      const res = mockRes();
      await controller.updateSystemSettings(
        { ...asAdmin('operator@suparank.ai'), body: { disabledAgentCommands: ['alt-text'] } },
        res,
      );
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1, 'a command change must leave an audit entry');
      assert.equal(calls[0].email, 'operator@suparank.ai');
      assert.deepEqual(
        calls[0].entry.meta.patch.disabledAgentCommands,
        ['alt-text'],
        'the audit must carry WHICH commands, or it cannot answer who enabled /image',
      );
    } finally {
      adminAudit.fromReq = real;
    }
  });

  it('a rejected change is not audited as if it happened', async () => {
    const calls = [];
    const real = adminAudit.fromReq;
    adminAudit.fromReq = (req, entry) => { calls.push(entry); };
    try {
      const res = mockRes();
      await controller.updateSystemSettings(
        { ...asAdmin(), body: { disabledAgentCommands: ['not-a-real-command'] } },
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.equal(calls.length, 0, 'a 400 must not leave an audit trail suggesting a change landed');
    } finally {
      adminAudit.fromReq = real;
    }
  });
});
