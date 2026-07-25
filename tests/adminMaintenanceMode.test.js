/**
 * Phase 10 — maintenance-mode gate.
 *
 * When maintenance is ON, non-exempt product routes 503 while admins retain
 * /api/auth + /api/admin (so they can always log in and toggle it off). Path-
 * based, not role-based. systemSettingsService.getSettings monkey-patched.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const systemSettingsService = require('../src/services/systemSettingsService');
const gate = require('../src/middleware/maintenanceGate');

const realGet = systemSettingsService.getSettings;
afterEach(() => { systemSettingsService.getSettings = realGet; });

function run(url) {
  let nexted = false;
  const res = {
    statusCode: null,
    status(c) { this.statusCode = c; return this; },
    json() { return this; },
  };
  gate({ originalUrl: url }, res, () => { nexted = true; });
  return { nexted, status: res.statusCode };
}

describe('maintenanceGate', () => {
  it('passes everything when maintenance is OFF', () => {
    systemSettingsService.getSettings = () => ({ maintenanceMode: false });
    assert.equal(run('/api/workspaces/1/content-summary').nexted, true);
  });

  describe('when maintenance is ON', () => {
    beforeEach(() => { systemSettingsService.getSettings = () => ({ maintenanceMode: true }); });

    it('503s a non-exempt product route (and does not call next)', () => {
      const r = run('/api/workspaces/1/content-summary');
      assert.equal(r.status, 503);
      assert.equal(r.nexted, false);
    });

    it('lets admins through /api/admin — the un-lock escape hatch', () => {
      assert.equal(run('/api/admin/settings').nexted, true);
    });

    it('lets login through /api/auth', () => {
      assert.equal(run('/api/auth/login').nexted, true);
    });

    it('lets /api/internal and /health through', () => {
      assert.equal(run('/api/internal/skills').nexted, true);
      assert.equal(run('/health').nexted, true);
    });
  });
});
