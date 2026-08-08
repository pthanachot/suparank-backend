/**
 * The email document shell (Phase 2).
 *
 * Before this, every template was a bare `<div style="max-width:...;margin:0
 * auto">`. That fails in two ways that matter:
 *
 *   1. `margin:0 auto` does not centre in Outlook's Word rendering engine, so
 *      the whole email sat left-aligned against the window.
 *   2. The templates set text colours with NO background anywhere. A
 *      dark-mode client that inverts the canvas but not the inline colour
 *      renders #111827 text on a near-black card.
 *
 * The shell fixes both: a 100%-width outer table with an mso-conditional fixed
 * inner table, explicit background-color on both, and the color-scheme metas
 * that opt out of auto-inversion where clients honour them.
 *
 * The compatibility constraint these tests exist to protect: an override row
 * saved BEFORE Phase 2 is a full bare-div document. Wrapping happens at
 * template-definition time, not at resolution, precisely so those keep
 * rendering untouched. See the wrapTemplate docblock.
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
  SYSTEM_TRIGGERS,
  ORIGINAL_DEFAULT_TEMPLATES,
  getTemplateForTrigger,
} = require('../src/controllers/emailPortalController');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const flagService = require('../src/services/flagService');

flagService.isFlagLive = async () => false;
TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
TriggerableEmailTemplate.findOneAndUpdate = async () => null;

const WIDTH = 600;
const ALL = Object.entries(ORIGINAL_DEFAULT_TEMPLATES);

describe('document structure', () => {
  it('every template is a complete HTML document', () => {
    for (const [id, tpl] of ALL) {
      assert.ok(tpl.html.startsWith('<!DOCTYPE'), `${id}: no doctype`);
      assert.match(tpl.html, /<html[ >]/, `${id}: no <html>`);
      assert.match(tpl.html, /<head>/, `${id}: no <head>`);
      assert.match(tpl.html, /<body[ >]/, `${id}: no <body>`);
      assert.ok(tpl.html.trimEnd().endsWith('</html>'), `${id}: unterminated`);
    }
  });

  it('every template has balanced tags', () => {
    for (const [id, tpl] of ALL) {
      for (const tag of ['div', 'table', 'tr', 'td', 'html', 'body', 'head']) {
        const open = (tpl.html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
        const close = (tpl.html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
        assert.equal(open, close, `${id}: unbalanced <${tag}> (${open} open, ${close} close)`);
      }
    }
  });

  it('no template still uses the old centring div', () => {
    // `margin:0 auto` is the exact thing Outlook ignores. If it comes back,
    // the email is left-aligned there again.
    for (const [id, tpl] of ALL) {
      assert.doesNotMatch(tpl.html, /margin:0 auto/, `${id}: bare centring div returned`);
    }
  });
});

describe('Outlook', () => {
  it('centres via a table, not a margin', () => {
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, /<td align="center"/, `${id}: no centring cell`);
    }
  });

  it('declares the namespaces its mso blocks depend on', () => {
    // <o:OfficeDocumentSettings> is meaningless without xmlns:o, and Outlook
    // then ignores the 96-DPI pin — the whole reason that block exists. It
    // shipped without the declaration first time round. xmlns:v is declared
    // alongside it because Phase 3's VML button needs it.
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, /xmlns:o="urn:schemas-microsoft-com:office:office"/, `${id}: no xmlns:o`);
      assert.match(tpl.html, /xmlns:v="urn:schemas-microsoft-com:vml"/, `${id}: no xmlns:v`);
      assert.match(tpl.html, /<o:PixelsPerInch>96<\/o:PixelsPerInch>/, `${id}: no DPI pin`);
    }
  });

  it('pins a hard pixel width inside an mso conditional', () => {
    // Outlook ignores max-width, so the fixed-width table has to be fed to it
    // explicitly. Both halves of the conditional must be present or the
    // document is malformed in Outlook only — invisible everywhere else.
    for (const [id, tpl] of ALL) {
      assert.match(
        tpl.html,
        new RegExp(`<!--\\[if mso\\]><table role="presentation" width="${WIDTH}"`),
        `${id}: no mso width table`
      );
      assert.match(tpl.html, /<!\[endif\]-->/, `${id}: unclosed mso conditional`);
      const opens = (tpl.html.match(/<!--\[if mso\]>/g) || []).length;
      const closes = (tpl.html.match(/<!\[endif\]-->/g) || []).length;
      assert.equal(opens, closes, `${id}: ${opens} mso opens vs ${closes} closes`);
    }
  });
});

describe('dark mode', () => {
  it('declares both colour-scheme metas', () => {
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, /<meta name="color-scheme" content="light"/, `${id}: no color-scheme`);
      assert.match(
        tpl.html,
        /<meta name="supported-color-schemes" content="light"/,
        `${id}: no supported-color-schemes`
      );
    }
  });

  it('sets an explicit background on the body and both tables', () => {
    // The actual dark-mode fix. Metas are advisory; explicit surfaces are what
    // stop dark text landing on a dark card when a client inverts anyway.
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, /<body style="[^"]*background-color:#F7F8FA/, `${id}: body has no bg`);
      assert.match(tpl.html, /background-color:#FFFFFF/, `${id}: card has no bg`);
    }
  });
});

describe('width', () => {
  it(`every template is ${WIDTH}px — no 480 or 640 survivors`, () => {
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, new RegExp(`max-width:${WIDTH}px`), `${id}: wrong max-width`);
      assert.doesNotMatch(tpl.html, /max-width:480px/, `${id}: 480px survivor`);
      assert.doesNotMatch(tpl.html, /max-width:640px/, `${id}: 640px survivor`);
    }
  });

  it('degrades to full width on a phone', () => {
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, /@media only screen and \(max-width:600px\)/, `${id}: no media query`);
    }
  });
});

describe('override compatibility', () => {
  // The reason wrapping happens at definition time. These are the rows that
  // exist in production right now.
  const LEGACY_OVERRIDE =
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">' +
    '<h1>An agency wrote this before Phase 2</h1></div>';

  it('a pre-Phase-2 override still resolves and is NOT double-wrapped', async () => {
    TriggerableEmailTemplate.findOne = () => ({
      lean: async () => ({ triggerId: 'welcome', defaultHtml: LEGACY_OVERRIDE, defaultSubject: 'Hi' }),
    });
    const tpl = await getTemplateForTrigger('welcome');
    assert.equal(tpl.html, LEGACY_OVERRIDE, 'legacy override was altered');
    assert.doesNotMatch(tpl.html, /<!DOCTYPE/, 'legacy override got a shell it never asked for');
    TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
  });

  it('falls back to the shelled default when no override exists', async () => {
    const tpl = await getTemplateForTrigger('welcome');
    assert.ok(tpl.html.startsWith('<!DOCTYPE'), 'default lost its shell');
  });

  it('stays inside the tenant editor 50 000-char cap', () => {
    // tenantEmailTemplateController.MAX_HTML_LENGTH. An agency has to be able
    // to save an edited copy of what we ship them.
    const { EXCLUDED_TRIGGERS } = require('../src/controllers/tenantEmailTemplateController');
    for (const trigger of SYSTEM_TRIGGERS) {
      if (EXCLUDED_TRIGGERS.has(trigger.id)) continue;
      const size = ORIGINAL_DEFAULT_TEMPLATES[trigger.id].html.length;
      assert.ok(size < 50000, `${trigger.id}: ${size} chars exceeds the tenant cap`);
    }
  });
});
