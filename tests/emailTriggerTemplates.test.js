/**
 * Tests for the triggerable-email template contract:
 *  1. every SYSTEM_TRIGGER has a default template,
 *  2. templates only use placeholders declared in the trigger's `variables`,
 *  3. the data keys each application call site sends cover the declared
 *     variables exactly (drift here ships literal {{placeholders}} to users),
 *  4. applyCustomTemplate substitutes fully and clears `data`.
 *
 * emailService and the TriggerableEmailTemplate model are faked — no SMTP,
 * no database.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Fake emailService BEFORE requiring the controller — the real module builds
// SMTP transports and fires a verify() at load.
require.cache[require.resolve('../src/utils/emailService')] = {
  exports: {
    sendEmail: async () => ({}),
    sendVerificationCodeEmail: async () => ({}),
    sendPasswordResetCodeEmail: async () => ({}),
  },
};

const {
  SYSTEM_TRIGGERS,
  ORIGINAL_DEFAULT_TEMPLATES,
  applyCustomTemplate,
} = require('../src/controllers/emailPortalController');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');

// No DB: template lookups fall back to the hardcoded defaults
TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
TriggerableEmailTemplate.findOneAndUpdate = async () => null;

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function placeholdersIn(text) {
  const found = new Set();
  let m;
  while ((m = PLACEHOLDER_RE.exec(text || '')) !== null) found.add(m[1]);
  return found;
}

// The exact data keys each application call site sends. If a call site
// changes its keys, update BOTH the sender and this table — the tests below
// prove the keys cover the template.
const CALLER_DATA_KEYS = {
  welcome: ['userName', 'loginUrl'], // authController.sendWelcomeEmail
  verify_email: ['code', 'expiresIn'], // authController.sendVerificationCode
  password_reset: ['code', 'expiresIn'], // authController.forgotPassword
  payment_confirmation: ['userName', 'planName', 'amount', 'nextBillingDate'], // webhook handlePaymentSucceeded
  subscription_canceled: ['userName', 'planName', 'endDate'], // webhook handleSubscriptionDeleted
  payment_failed: ['userName', 'planName', 'retryDate', 'updatePaymentUrl'], // webhook handlePaymentFailed
  credits_low: ['userName', 'remainingCredits', 'planName'], // creditService.maybeNotifyLowBalance
  feedback_submitted: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt'], // feedbackController
  contact_submitted: ['userName', 'userEmail', 'subject', 'category', 'message', 'submittedAt'], // contactController
  // scan_completed's rich payload is asserted structurally below, not key-by-key
};

describe('trigger/template registry', () => {
  it('every system trigger has a default template', () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      assert.ok(ORIGINAL_DEFAULT_TEMPLATES[trigger.id], `missing default template for ${trigger.id}`);
    }
  });

  it('the removed broadcast triggers are gone from both registries', () => {
    const ids = SYSTEM_TRIGGERS.map((t) => t.id);
    for (const removed of ['feature_announcement', 'usage_tips']) {
      assert.ok(!ids.includes(removed), `${removed} should not be in SYSTEM_TRIGGERS`);
      assert.ok(!ORIGINAL_DEFAULT_TEMPLATES[removed], `${removed} should have no default template`);
    }
  });

  it('templates only use placeholders declared in the trigger variables', () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      const tpl = ORIGINAL_DEFAULT_TEMPLATES[trigger.id];
      const used = new Set([...placeholdersIn(tpl.subject), ...placeholdersIn(tpl.html)]);
      for (const name of used) {
        assert.ok(
          trigger.variables.includes(name),
          `${trigger.id}: template uses {{${name}}} which is not a declared variable`
        );
      }
    }
  });
});

describe('caller data keys cover the templates', () => {
  for (const [triggerId, keys] of Object.entries(CALLER_DATA_KEYS)) {
    it(`${triggerId}: sender keys substitute every placeholder`, () => {
      const tpl = ORIGINAL_DEFAULT_TEMPLATES[triggerId];
      assert.ok(tpl, `no template for ${triggerId}`);
      const used = new Set([...placeholdersIn(tpl.subject), ...placeholdersIn(tpl.html)]);
      for (const name of used) {
        assert.ok(
          keys.includes(name),
          `${triggerId}: template needs {{${name}}} but the call site does not send it`
        );
      }
    });
  }

  it('scan_completed: declared variables cover every placeholder', () => {
    const trigger = SYSTEM_TRIGGERS.find((t) => t.id === 'scan_completed');
    const tpl = ORIGINAL_DEFAULT_TEMPLATES.scan_completed;
    const used = new Set([...placeholdersIn(tpl.subject), ...placeholdersIn(tpl.html)]);
    for (const name of used) {
      assert.ok(trigger.variables.includes(name), `scan_completed: {{${name}}} undeclared`);
    }
  });
});

describe('applyCustomTemplate', () => {
  it('substitutes fully — no literal {{placeholders}} survive', async () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      const data = Object.fromEntries(trigger.variables.map((v) => [v, `VAL_${v}`]));
      const opts = { to: 'x@example.com', data };
      await applyCustomTemplate(trigger.id, opts);
      assert.ok(opts.subject, `${trigger.id}: subject not populated`);
      assert.ok(opts.html, `${trigger.id}: html not populated`);
      assert.equal(placeholdersIn(opts.subject).size, 0, `${trigger.id}: unresolved placeholder in subject`);
      assert.equal(placeholdersIn(opts.html).size, 0, `${trigger.id}: unresolved placeholder in html`);
      assert.equal(opts.data, undefined, `${trigger.id}: data should be deleted after substitution`);
    }
  });

  it('handles null/undefined variable values without printing "undefined"', async () => {
    const opts = { to: 'x@example.com', data: { userName: null, loginUrl: undefined } };
    await applyCustomTemplate('welcome', opts);
    assert.ok(!opts.html.includes('undefined'), 'null/undefined must render as empty string');
    assert.ok(!opts.html.includes('null'), 'null/undefined must render as empty string');
  });

  it('leaves options untouched for an unknown trigger (caller falls back)', async () => {
    const opts = { to: 'x@example.com', data: { a: 1 } };
    await applyCustomTemplate('no_such_trigger', opts);
    assert.equal(opts.subject, undefined);
    assert.deepEqual(opts.data, { a: 1 });
  });
});
