/**
 * D2 — the "default template updated" signal.
 *
 * Decision D2 is that an override row is the tenant's (or admin's) content and
 * is NEVER rewritten when the built-in defaults change. The cost of that is a
 * silent divergence: an agency who customised a template in 2026-07 keeps
 * sending the pre-alignment email — no logo, no shell, no brand colour — with
 * nothing in the UI to tell them. This flag is the only thing that closes the
 * loop, so its edge cases matter more than its happy path.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require.cache[require.resolve('../src/utils/emailService')] = {
  exports: {
    sendEmail: async () => ({}),
    sendVerificationCodeEmail: async () => ({}),
    sendPasswordResetCodeEmail: async () => ({}),
  },
};

const {
  isOverrideStale,
  DEFAULTS_REVISED_AT,
  ORIGINAL_DEFAULT_TEMPLATES,
} = require('../src/controllers/emailPortalController');

const before = new Date(DEFAULTS_REVISED_AT.getTime() - 86400000);
const after = new Date(DEFAULTS_REVISED_AT.getTime() + 86400000);
const override = (updatedAt) => ({ defaultHtml: '<p>mine</p>', defaultSubject: 'S', updatedAt });

describe('isOverrideStale', () => {
  it('flags an override saved before the defaults were revised', () => {
    assert.equal(isOverrideStale(override(before)), true);
  });

  it('does not flag one saved after', () => {
    assert.equal(isOverrideStale(override(after)), false);
  });

  it('does not flag one saved at the exact revision instant', () => {
    // `<` not `<=`: a row written the same millisecond is current.
    assert.equal(isOverrideStale(override(DEFAULTS_REVISED_AT)), false);
  });

  it('flags an override with no timestamp at all', () => {
    // Rows predating `timestamps: true` are older than any revision we track.
    assert.equal(isOverrideStale({ defaultHtml: '<p>mine</p>' }), true);
  });

  it('does not flag when there is no override row', () => {
    assert.equal(isOverrideStale(null), false);
    assert.equal(isOverrideStale(undefined), false);
  });

  it('does not flag a stats-only row', () => {
    // getTemplateForTrigger upserts a row per send to hold triggerCount and
    // lastTriggered. Those carry no content, so there is nothing to be out of
    // date — flagging them would show "Outdated" on every untouched template.
    assert.equal(
      isOverrideStale({ triggerId: 'welcome', triggerCount: 42, updatedAt: before }),
      false
    );
    assert.equal(
      isOverrideStale({ defaultSubject: null, defaultHtml: null, updatedAt: before }),
      false
    );
  });

  it('flags a subject-only override', () => {
    assert.equal(isOverrideStale({ defaultSubject: 'Just the subject', updatedAt: before }), true);
  });

  it('accepts a date-like string, as Mongo lean() returns', () => {
    assert.equal(isOverrideStale(override(before.toISOString())), true);
    assert.equal(isOverrideStale(override(after.toISOString())), false);
  });
});

describe('the revision date', () => {
  it('is not in the future', () => {
    // A future date would mark every override stale forever, including ones
    // saved from the current defaults.
    assert.ok(DEFAULTS_REVISED_AT.getTime() <= Date.now(), 'DEFAULTS_REVISED_AT is in the future');
  });

  it('covers the four-phase alignment work', () => {
    // The whole point of this date: overrides older than the alignment work
    // miss the logo, the shell and the brand button. If the defaults gain any
    // of those and the date is not bumped, the signal silently stops working.
    const { html } = ORIGINAL_DEFAULT_TEMPLATES.welcome;
    assert.match(html, /\{\{logoUrl\}\}/, 'defaults lost the brand header');
    assert.match(html, /<!DOCTYPE/, 'defaults lost the shell');
    assert.ok(
      DEFAULTS_REVISED_AT >= new Date('2026-08-08T00:00:00.000Z'),
      'defaults were revised after this date without bumping DEFAULTS_REVISED_AT'
    );
  });
});
