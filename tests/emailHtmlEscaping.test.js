// Guards against HTML injection into the emails our own team reads.
//
// The hazard: applyCustomTemplate substitutes `data` into a template with a
// raw String(value) replace and no escaping. Both `contact_submitted` and
// `feedback_submitted` have entries in ORIGINAL_DEFAULT_TEMPLATES, and
// getTemplateForTrigger falls back to those, so a template ALWAYS resolves for
// these triggers. The template path is therefore the live path, and any
// unescaped user value in `data` lands as markup in the support inbox.
//
// Escaping cannot be done centrally inside applyCustomTemplate because
// aiTrackerController passes `<tr>` fragments on purpose. See
// src/utils/htmlEscape.js. These tests pin the per-caller escaping instead.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const sent = [];

// A template that behaves like the real default: raw {{var}} substitution.
const TEMPLATE = {
  subject: '[{{brandName}}] {{feature}}{{subject}}',
  html: '<p>{{userName}}{{userEmail}} {{message}}{{comment}} {{feature}}</p>',
};

const tplPath = require.resolve(path.join(SRC, 'controllers/emailPortalController.js'));
require.cache[tplPath] = {
  id: tplPath,
  filename: tplPath,
  loaded: true,
  exports: {
    applyCustomTemplate: async (triggerId, emailOptions) => {
      if (!emailOptions.data) return;
      const sub = (str) =>
        Object.entries(emailOptions.data).reduce(
          (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? '')),
          str
        );
      emailOptions.subject = sub(TEMPLATE.subject);
      emailOptions.html = sub(TEMPLATE.html);
      delete emailOptions.data;
    },
  },
};

const mailPath = require.resolve(path.join(SRC, 'utils/emailService.js'));
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: { sendEmail: async (o) => { sent.push(o); return true; } },
};

// contactController looks the sender's name up; feedbackController writes a row.
const userPath = require.resolve(path.join(SRC, 'models/User.js'));
require.cache[userPath] = {
  id: userPath,
  filename: userPath,
  loaded: true,
  exports: {
    findById: () => ({ select: () => ({ lean: async () => ({ profile: { name: 'Real User' } }) }) }),
  },
};

const fbPath = require.resolve(path.join(SRC, 'models/Feedback.js'));
require.cache[fbPath] = {
  id: fbPath,
  filename: fbPath,
  loaded: true,
  exports: { create: async (doc) => doc },
};

const { submitContact } = require(path.join(SRC, 'controllers/contactController.js'));
const { submitFeedback } = require(path.join(SRC, 'controllers/feedbackController.js'));

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

const XSS = '<script>alert(1)</script>';
const IMG = '<img src=x onerror=alert(1)>';

const { htmlEscape, htmlUnescape, subjectSafe, headerSafe } = require(path.join(SRC, 'utils/htmlEscape.js'));

test('htmlUnescape reverses htmlEscape exactly', () => {
  for (const s of ['plain', "it's", 'a & b', '<tag>', '"q"', '5 &lt; 10', '&amp;']) {
    assert.strictEqual(htmlUnescape(htmlEscape(s)), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test('headerSafe strips real CR/LF', () => {
  assert.ok(!/[\r\n]/.test(headerSafe('a\r\nb')));
  assert.strictEqual(subjectSafe(htmlEscape('a')), 'a');
});

test('authenticated contact form escapes user HTML on the template path', async () => {
  sent.length = 0;
  const res = mockRes();
  await submitContact(
    { body: { subject: XSS, category: 'General', message: IMG }, user: { userId: 'u1', email: 'user@example.com' } },
    res
  );
  assert.strictEqual(res.statusCode, 201);
  const html = sent[0].html;
  assert.ok(!html.includes('<script>'), 'raw script tag reached the support email');
  assert.ok(!html.includes('<img'), 'raw img tag reached the support email');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&lt;img'), 'expected escaped markup');
});

test('feedback form escapes user HTML on the template path', async () => {
  sent.length = 0;
  const res = mockRes();
  await submitFeedback(
    { body: { feature: XSS, rating: 4, comment: IMG }, user: { userId: 'u1', email: 'user@example.com' } },
    res
  );
  const html = sent[0].html;
  assert.ok(!html.includes('<script>'), 'raw script tag reached the support email');
  assert.ok(!html.includes('<img'), 'raw img tag reached the support email');
});

test('the subject line reads naturally, without entities', async () => {
  // Regression: escaping for the HTML body also lands in the Subject, because
  // applyCustomTemplate substitutes one data bag into both. Apostrophes and
  // ampersands are everywhere in real support subjects, so "I can't log in"
  // must not reach the inbox as "I can&#39;t log in".
  for (const [subject, expected] of [
    ["I can't log in", "I can't log in"],
    ['Sales & Billing', 'Sales & Billing'],
    ['A "quoted" phrase', 'A "quoted" phrase'],
  ]) {
    sent.length = 0;
    const res = mockRes();
    await submitContact(
      { body: { subject, message: 'm' }, user: { userId: 'u1', email: 'user@example.com' } },
      res
    );
    assert.ok(sent[0].subject.includes(expected), `subject was ${JSON.stringify(sent[0].subject)}`);
  }
});

test('decoding the subject cannot smuggle a header break', async () => {
  sent.length = 0;
  const res = mockRes();
  await submitContact(
    { body: { subject: 'A&#13;&#10;Bcc: victim@example.com', message: 'm' }, user: { userId: 'u1', email: 'user@example.com' } },
    res
  );
  assert.ok(!/[\r\n]/.test(sent[0].subject), 'CR/LF reached the Subject header');
  // Numeric entities are deliberately NOT decoded: htmlUnescape only reverses
  // the five named entities htmlEscape produces.
  assert.ok(sent[0].subject.includes('&#13;&#10;'), 'numeric entity should survive as literal text');
});

test('subject decoding does not weaken the body', async () => {
  sent.length = 0;
  const res = mockRes();
  await submitContact(
    { body: { subject: 'S', message: XSS }, user: { userId: 'u1', email: 'user@example.com' } },
    res
  );
  assert.ok(!sent[0].html.includes('<script>'), 'body escaping was undone by the subject decode');
});

test('escaping happens exactly once', async () => {
  sent.length = 0;
  const res = mockRes();
  await submitContact(
    { body: { subject: 'S', message: '5 < 10 & fine' }, user: { userId: 'u1', email: 'user@example.com' } },
    res
  );
  assert.ok(sent[0].html.includes('&lt; 10 &amp; fine'));
  assert.ok(!sent[0].html.includes('&amp;amp;'), 'value was double-escaped');
});
