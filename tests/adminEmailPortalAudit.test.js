/**
 * Phase 9 — Email portal audit.
 *
 * sendBulkEmails sends to exactly the provided recipients and honors the global
 * email kill-switch; sendTestEmail is isolated to the single test address;
 * updateDefaultTemplate only edits known triggers. emailService + settings are
 * faked via require-cache injection (the controller destructures `sendEmail` at
 * load, so it must be faked before the controller is required) — no DB, no SMTP.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Fakes installed BEFORE the controller is required ──
const sent = [];
const settingsState = { emailNotificationsEnabled: true };

require.cache[require.resolve('../src/utils/emailService')] = {
  exports: {
    sendEmail: async (opts) => { sent.push(opts); },
    sendVerificationCodeEmail: async () => {},
    sendPasswordResetCodeEmail: async () => {},
  },
};
require.cache[require.resolve('../src/services/systemSettingsService')] = {
  exports: {
    getSettings: () => settingsState,
    updateSettings: async () => settingsState,
    loadSettings: async () => settingsState,
    onSettingsChange: () => {},
    DEFAULTS: {},
  },
};

const controller = require('../src/controllers/emailPortalController');
const EmailSendLog = require('../src/models/EmailSendLog');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const EmailTemplate = require('../src/models/EmailTemplate');

const realLog = EmailSendLog.create;
const realTrig = TriggerableEmailTemplate.findOneAndUpdate;
const realDel = EmailTemplate.findByIdAndDelete;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

beforeEach(() => {
  sent.length = 0;
  settingsState.emailNotificationsEnabled = true;
  EmailSendLog.create = async () => ({});
  TriggerableEmailTemplate.findOneAndUpdate = async () => ({});
});
afterEach(() => {
  EmailSendLog.create = realLog;
  TriggerableEmailTemplate.findOneAndUpdate = realTrig;
  EmailTemplate.findByIdAndDelete = realDel;
});

describe('sendBulkEmails — recipients + global gate', () => {
  const call = async (body) => {
    const res = mockRes();
    await controller.sendBulkEmails({ body, user: { email: 'admin@x.co' } }, res);
    return res;
  };

  it('sends exactly one email per provided recipient', async () => {
    const res = await call({ subject: 'Hi', htmlContent: '<p>x</p>', recipients: ['a@x.co', 'b@x.co'] });
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((s) => s.to), ['a@x.co', 'b@x.co']);
  });

  it('409s (and sends nothing) when email notifications are disabled system-wide', async () => {
    settingsState.emailNotificationsEnabled = false;
    const res = await call({ subject: 'Hi', htmlContent: '<p>x</p>', recipients: ['a@x.co'] });
    assert.equal(res.statusCode, 409);
    assert.equal(sent.length, 0);
  });

  it('400s a missing subject/content/recipients', async () => {
    assert.equal((await call({ subject: '', htmlContent: 'x', recipients: ['a@x.co'] })).statusCode, 400);
    assert.equal((await call({ subject: 's', htmlContent: 'x', recipients: [] })).statusCode, 400);
  });
});

describe('sendTestEmail — isolated to one address', () => {
  it('sends only to the test address, prefixed [TEST]', async () => {
    const res = mockRes();
    await controller.sendTestEmail(
      { body: { subject: 'Hi', htmlContent: '<p>x</p>', testEmail: 'me@x.co' }, user: { email: 'admin@x.co' } },
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'me@x.co');
    assert.ok(sent[0].subject.startsWith('[TEST]'));
  });
});

describe('updateDefaultTemplate — only known triggers', () => {
  it('404s an unknown trigger id (cannot create arbitrary transactional templates)', async () => {
    const res = mockRes();
    await controller.updateDefaultTemplate({ params: { triggerId: 'not-a-real-trigger' }, body: { html: '<p>x</p>' } }, res);
    assert.equal(res.statusCode, 404);
  });
});

describe('deleteTemplate — 404 on missing (LOW-9.5)', () => {
  it('404s when the template does not exist', async () => {
    EmailTemplate.findByIdAndDelete = async () => null;
    const res = mockRes();
    await controller.deleteTemplate({ params: { id: 'nope' } }, res);
    assert.equal(res.statusCode, 404);
  });

  it('200s when it existed', async () => {
    EmailTemplate.findByIdAndDelete = async () => ({ _id: 'x' });
    const res = mockRes();
    await controller.deleteTemplate({ params: { id: 'x' } }, res);
    assert.equal(res.statusCode, 200);
  });
});
