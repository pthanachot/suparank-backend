const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { isAdminEmail, adminEmailSet } = require('../src/utils/adminEmails');

// The five Railway env slots the gate reads. Admin identity is env-only (Phase 2).
const SLOTS = ['ADMIN_EMAILS', 'ADMIN_EMAILS_2', 'ADMIN_EMAILS_3', 'ADMIN_EMAILS_4', 'ADMIN_EMAILS_5'];

let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const s of SLOTS) {
    savedEnv[s] = process.env[s];
    delete process.env[s];
  }
});

afterEach(() => {
  for (const s of SLOTS) {
    if (savedEnv[s] === undefined) delete process.env[s];
    else process.env[s] = savedEnv[s];
  }
});

describe('adminEmails — five env slots', () => {
  it('grants admin for an email in each of the 5 slots', () => {
    process.env.ADMIN_EMAILS = 'one@x.com';
    process.env.ADMIN_EMAILS_2 = 'two@x.com';
    process.env.ADMIN_EMAILS_3 = 'three@x.com';
    process.env.ADMIN_EMAILS_4 = 'four@x.com';
    process.env.ADMIN_EMAILS_5 = 'five@x.com';
    for (const e of ['one@x.com', 'two@x.com', 'three@x.com', 'four@x.com', 'five@x.com']) {
      assert.equal(isAdminEmail(e), true, `${e} should be admin`);
    }
    assert.equal(adminEmailSet().size, 5);
  });

  it('normalizes case and surrounding whitespace', () => {
    process.env.ADMIN_EMAILS_3 = '  Admin@Example.COM  ';
    assert.equal(isAdminEmail('admin@example.com'), true);
    assert.equal(isAdminEmail('ADMIN@EXAMPLE.COM'), true);
  });

  it('keeps each slot comma-tolerant (backward compatible with the old single var)', () => {
    process.env.ADMIN_EMAILS = 'a@x.com, b@x.com';
    assert.equal(isAdminEmail('a@x.com'), true);
    assert.equal(isAdminEmail('b@x.com'), true);
  });

  it('ignores blank and missing slots', () => {
    process.env.ADMIN_EMAILS = '';
    process.env.ADMIN_EMAILS_4 = '   ';
    assert.equal(adminEmailSet().size, 0);
    assert.equal(isAdminEmail('nobody@x.com'), false);
  });

  it('returns false for non-listed emails and falsy input', () => {
    process.env.ADMIN_EMAILS = 'real@x.com';
    assert.equal(isAdminEmail('fake@x.com'), false);
    assert.equal(isAdminEmail(''), false);
    assert.equal(isAdminEmail(null), false);
    assert.equal(isAdminEmail(undefined), false);
  });

  // The impersonation guard (impersonationService.js) refuses a target via the
  // same isAdminEmail(), so an email added to ANY slot is automatically an
  // invalid impersonation target — no separate DB-backed test needed here.
  it('recognizes a slot-3 admin the impersonation guard will refuse', () => {
    process.env.ADMIN_EMAILS_3 = 'protected@x.com';
    assert.equal(isAdminEmail('protected@x.com'), true);
  });
});
