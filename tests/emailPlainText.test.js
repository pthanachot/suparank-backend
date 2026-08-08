/**
 * The text/plain alternative (Phase 4b) and the preheader (4a).
 *
 * Every email was HTML-only before this. A missing text/plain part is a
 * measurable spam-score penalty, and this domain also carries password resets
 * and receipts — the deliverability of the whole domain is what is at stake.
 *
 * The converter is deliberately narrow (utils/htmlToText): we control every
 * byte of the markup it sees. The cases below are the ones that actually bite
 * when hand-rolling one — CSS leaking out of <style>, Outlook conditional
 * comments duplicating content, and links losing their destination.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { htmlToText } = require('../src/utils/htmlToText');

// applyCustomTemplate is exercised through the real controller, with the mail
// transport and model stubbed the same way the other email tests do it.
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
  getTemplateForTrigger,
} = require('../src/controllers/emailPortalController');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');

const PLATFORM = { productName: 'SupaRank', supportEmail: 'support@suparank.ai', primaryColor: '#2B5BE8' };

beforeEach(() => {
  flagService.isFlagLive = async () => false;
  TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
  TriggerableEmailTemplate.findOneAndUpdate = async () => null;
  brandService.getPlatformBrand = async () => ({ ...PLATFORM });
  brandService.getBrandForOrg = async () => ({ brand: { ...PLATFORM } });
});

async function render(triggerId, data = {}) {
  const trigger = SYSTEM_TRIGGERS.find((t) => t.id === triggerId);
  const auto = ['brandName', 'supportEmail', 'logoUrl', 'primaryColor', 'preheader'];
  const bag = Object.fromEntries(
    trigger.variables.filter((v) => !auto.includes(v) && !(v in data)).map((v) => [v, `VAL_${v}`])
  );
  const opts = { to: 'x@example.com', data: { ...bag, ...data } };
  await applyCustomTemplate(triggerId, opts);
  return opts;
}

describe('htmlToText', () => {
  it('never leaks CSS out of the <style> block', () => {
    // The classic hand-rolled-converter bug: a bare tag-strip dumps the whole
    // reset stylesheet into the plain-text body as a wall of selectors.
    const text = htmlToText('<html><head><style>body{margin:0!important;}</style></head><body><p>Hi</p></body></html>');
    assert.equal(text, 'Hi');
    assert.doesNotMatch(text, /margin|important|body\{/);
  });

  it('drops Outlook conditional comments without duplicating their markup', () => {
    // A generic comment strip leaves the ghost table's content behind, so the
    // text part says everything twice.
    const text = htmlToText('<!--[if mso]><table><tr><td>GHOST<![endif]--><p>Real</p>');
    assert.equal(text, 'Real');
    assert.doesNotMatch(text, /GHOST/);
  });

  it('keeps link destinations, because the button is gone in plain text', () => {
    const text = htmlToText('<a href="https://app.test/verify?t=1">Verify Email</a>');
    assert.equal(text, 'Verify Email (https://app.test/verify?t=1)');
  });

  it('does not duplicate a link whose label is already the URL', () => {
    const text = htmlToText('<a href="https://a.test/x">https://a.test/x</a>');
    assert.equal(text, 'https://a.test/x');
  });

  it('leaves mailto and anchor links as their label', () => {
    assert.equal(htmlToText('<a href="mailto:a@b.test">a@b.test</a>'), 'a@b.test');
    assert.equal(htmlToText('<a href="#skip">Skip</a>'), 'Skip');
  });

  it('decodes entities last, so a decoded < is never parsed as a tag', () => {
    const text = htmlToText('<p>5 &lt; 10 &amp; fine</p>');
    assert.equal(text, '5 < 10 & fine');
  });

  it('does not swallow content after an escaped tag', () => {
    const text = htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt; and more</p>');
    assert.match(text, /alert\(1\)/);
    assert.match(text, /and more/);
  });

  it('separates table columns and rows', () => {
    const text = htmlToText('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>');
    assert.match(text, /A\tB/);
    assert.match(text, /C\tD/);
  });

  it('collapses runs of blank lines', () => {
    assert.doesNotMatch(htmlToText('<div></div><div></div><p>x</p><div></div>'), /\n\n\n/);
  });

  it('handles empty and nullish input', () => {
    assert.equal(htmlToText(''), '');
    assert.equal(htmlToText(null), '');
    assert.equal(htmlToText(undefined), '');
  });
});

describe('text part of the real templates', () => {
  it('every template converts to non-empty, tag-free, CSS-free text', async () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      const { html } = await render(trigger.id);
      const text = htmlToText(html);
      assert.ok(text.length > 20, `${trigger.id}: text part is empty`);
      assert.doesNotMatch(text, /<[a-z/]/i, `${trigger.id}: tags survived`);
      assert.doesNotMatch(text, /-webkit-|mso-hide|!important|border-collapse/, `${trigger.id}: CSS leaked`);
      assert.doesNotMatch(text, /\{\{\w+\}\}/, `${trigger.id}: unresolved placeholder`);
    }
  });

  it('leaves no undecoded entity in any template', async () => {
    // The bug this catches: htmlUnescape only knows the five entities
    // htmlEscape produces, but the templates hand-write typographic ones, so
    // the scan email's text part read "Hi Alex &mdash; northwind.com". Any new
    // entity added to a template fails here until htmlToText handles it.
    for (const trigger of SYSTEM_TRIGGERS) {
      const { html } = await render(trigger.id);
      const leftovers = htmlToText(html).match(/&[a-zA-Z]+;|&#x?[0-9a-fA-F]+;/g) || [];
      assert.deepEqual(leftovers, [], `${trigger.id}: undecoded ${leftovers.join(' ')}`);
    }
  });

  it('round-trips a literal entity a user typed', () => {
    // htmlEscape turns a typed "&" into "&amp;", so "&#60;" in a contact form
    // arrives as "&amp;#60;" and must read back as "&#60;", not as "<".
    // Numeric decoding therefore has to run BEFORE named decoding.
    assert.equal(htmlToText('<p>&amp;#60;</p>'), '&#60;');
    assert.equal(htmlToText('<p>&amp;mdash;</p>'), '&mdash;');
  });

  it('decodes characters above the 16-bit range', () => {
    // String.fromCharCode truncates to 16 bits and would mangle an emoji in a
    // prompt or a brand name into a stray surrogate.
    assert.equal(htmlToText('<p>&#128512;</p>'), '😀');
    assert.equal(htmlToText('<p>&#x1F600;</p>'), '😀');
  });

  it('leaves an out-of-range reference as literal text', () => {
    assert.equal(htmlToText('<p>&#99999999;</p>'), '&#99999999;');
  });

  it('keeps the action URL in emails whose whole point is a link', async () => {
    const { html } = await render('verify_email_link', { verifyUrl: 'https://app.test/v?t=abc' });
    assert.match(htmlToText(html), /https:\/\/app\.test\/v\?t=abc/);
  });

  it('omits the preheader — it is the snippet line, not body copy', async () => {
    const { html } = await render('welcome');
    const text = htmlToText(html);
    assert.doesNotMatch(text, /Your workspace is ready/, 'preheader duplicated into the body');
    // …and none of its invisible padding either.
    assert.doesNotMatch(text, /‌|͏/);
  });
});

describe('preheader', () => {
  it('every trigger declares one', () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      assert.ok(trigger.preheader, `${trigger.id}: no preheader copy`);
      assert.ok(trigger.preheader.length <= 90, `${trigger.id}: preheader too long for a snippet`);
    }
  });

  it('renders hidden, before any visible content', () => {
    for (const [id, tpl] of Object.entries(ORIGINAL_DEFAULT_TEMPLATES)) {
      assert.match(tpl.html, /<div class="sr-preheader"[^>]*display:none/, `${id}: preheader not hidden`);
      assert.match(tpl.html, /mso-hide:all/, `${id}: preheader would show in Outlook`);
      // Compared against the outer layout TABLE, not the `.sr-card` selector —
      // that class name appears earlier in the <head> media query.
      const preheaderAt = tpl.html.indexOf('sr-preheader');
      const bodyAt = tpl.html.indexOf('<body');
      const firstTableAt = tpl.html.indexOf('<table role="presentation" width="100%"');
      assert.ok(preheaderAt > bodyAt, `${id}: preheader is outside <body>`);
      assert.ok(preheaderAt < firstTableAt, `${id}: preheader comes after visible content`);
    }
  });

  it('resolves its own nested placeholders', async () => {
    // "{{inviterName}} has invited you to {{orgName}}" — these are resolved
    // explicitly, NOT by the main substitution loop, whose Object.entries order
    // would make it work only by luck.
    const { html } = await render('member_invite', { inviterName: 'Jordan', orgName: 'Northwind' });
    assert.match(html, /Jordan has invited you to Northwind\./);
    assert.doesNotMatch(html, /\{\{inviterName\}\}|\{\{orgName\}\}/);
  });

  it('never ships a literal placeholder into the snippet line', async () => {
    // Scoped to the preheader div. The BODY keeping an unresolved {{x}} when a
    // caller omits a declared key is pre-existing behaviour, guarded instead by
    // the CALLER_DATA_KEYS contract in emailTriggerTemplates.test.js. The
    // preheader is different: it is what the inbox shows before anyone opens
    // the mail, so a literal placeholder there is maximally visible.
    const opts = { to: 'x@example.com', data: { userName: 'A' } };
    await applyCustomTemplate('member_invite', opts);
    const snippet = opts.html.match(/<div class="sr-preheader"[^>]*>([\s\S]*?)<\/div>/)[1];
    assert.doesNotMatch(snippet, /\{\{\w+\}\}/, 'unresolved placeholder in the snippet line');
  });
});

describe('template resolution survives a database outage', () => {
  it('serves the hardcoded default when the override lookup throws', async () => {
    // The Phase 4c hardening. Previously one try/catch wrapped the whole
    // function, so a Mongo blip discarded the in-memory default too and every
    // caller fell through to its own unstyled duplicate of the email.
    TriggerableEmailTemplate.findOne = () => {
      throw new Error('MongoNetworkError: connection refused');
    };
    const tpl = await getTemplateForTrigger('welcome');
    assert.ok(tpl, 'resolution returned null on a DB error');
    assert.ok(tpl.html.startsWith('<!DOCTYPE'), 'lost the shell');
    assert.match(tpl.html, /\{\{logoUrl\}\}/, 'lost the brand header');
  });

  it('still returns null for an unknown trigger', async () => {
    assert.equal(await getTemplateForTrigger('no_such_trigger'), null);
  });

  it('a DB outage still produces a fully branded email end to end', async () => {
    TriggerableEmailTemplate.findOne = () => {
      throw new Error('MongoNetworkError: connection refused');
    };
    const opts = { to: 'x@example.com', data: { userName: 'Alex', loginUrl: 'https://app.test' } };
    await applyCustomTemplate('welcome', opts);
    assert.ok(opts.subject, 'no subject');
    assert.match(opts.html, /suparank-mark\.png/, 'no logo');
    assert.match(opts.html, /bgcolor="#2B5BE8"/, 'no brand button');
    assert.doesNotMatch(opts.html, /\{\{\w+\}\}/, 'unresolved placeholder');
  });
});
