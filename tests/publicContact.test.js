// Tests for the public (unauthenticated) contact endpoint.
//
// This is the only public endpoint that sends mail, so the cases that matter
// are the abuse ones: honeypot, validation-before-metering, HTML escaping of
// everything that reaches the notification email, and CR/LF stripping on
// values that reach a mail header.
//
// The controller's three collaborators (rate limiter, mailer, template
// resolver) are stubbed through require.cache so the controller itself runs
// for real without a database or SMTP server.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

// ── stubs, installed before the controller is required ──
const sent = [];
let rateLimitAllowed = true;
let rateLimitCalls = 0;
let rateLimitThrows = false;
let template = null;

const svcPath = require.resolve(path.join(SRC, 'services/publicToolsService.js'));
require.cache[svcPath] = {
  id: svcPath,
  filename: svcPath,
  loaded: true,
  exports: {
    consumeRateLimit: async () => {
      rateLimitCalls += 1;
      if (rateLimitThrows) throw new Error('MongoNetworkError: connection refused');
      return { allowed: rateLimitAllowed, remaining: 0 };
    },
  },
};

const mailPath = require.resolve(path.join(SRC, 'utils/emailService.js'));
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: {
    sendEmail: async (opts) => {
      sent.push(opts);
      return true;
    },
  },
};

// Mirrors the real applyCustomTemplate: raw {{var}} substitution, no escaping
// of its own. When `template` is null it leaves emailOptions alone, which is
// what makes the controller fall through to its built-in markup.
const tplPath = require.resolve(path.join(SRC, 'controllers/emailPortalController.js'));
require.cache[tplPath] = {
  id: tplPath,
  filename: tplPath,
  loaded: true,
  exports: {
    applyCustomTemplate: async (triggerId, emailOptions) => {
      if (!template || !emailOptions.data) return;
      const sub = (str) =>
        Object.entries(emailOptions.data).reduce(
          (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? '')),
          str
        );
      emailOptions.subject = sub(template.subject);
      emailOptions.html = sub(template.html);
      delete emailOptions.data;
    },
  },
};

const { submitPublicContact } = require(path.join(SRC, 'controllers/publicContactController.js'));

// ── harness ──
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

const VALID = { email: 'prospect@example.com', subject: 'Do you track Claude?', message: 'Asking before I pick a plan.' };

async function post(body) {
  const res = mockRes();
  await submitPublicContact({ body, ip: '203.0.113.9' }, res);
  return res;
}

function reset() {
  sent.length = 0;
  rateLimitAllowed = true;
  rateLimitCalls = 0;
  rateLimitThrows = false;
  template = null;
}

// ── validation ──

test('accepts a valid submission', async () => {
  reset();
  const res = await post(VALID);
  assert.strictEqual(res.statusCode, 201);
  assert.deepStrictEqual(res.body, { success: true });
  assert.strictEqual(sent.length, 1);
});

test('rejects a missing or malformed email', async () => {
  for (const email of [undefined, '', 'not-an-email', 'a@b', 'x'.repeat(201) + '@b.co']) {
    reset();
    const res = await post({ ...VALID, email });
    assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(email)}`);
  }
});

test('rejects an empty or oversized subject and message', async () => {
  reset();
  assert.strictEqual((await post({ ...VALID, subject: '  ' })).statusCode, 400);
  assert.strictEqual((await post({ ...VALID, subject: 'x'.repeat(201) })).statusCode, 400);
  assert.strictEqual((await post({ ...VALID, message: '  ' })).statusCode, 400);
  assert.strictEqual((await post({ ...VALID, message: 'x'.repeat(2001) })).statusCode, 400);
});

// ── abuse controls ──

test('honeypot submissions are rejected without sending mail', async () => {
  reset();
  const res = await post({ ...VALID, _hp: 'filled-by-a-bot' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(sent.length, 0);
});

test('invalid input never consumes the rate-limit allowance', async () => {
  // Validation must run BEFORE metering, or malformed requests from a shared
  // NAT address would burn a real visitor's daily quota.
  reset();
  await post({ ...VALID, email: 'nope' });
  assert.strictEqual(rateLimitCalls, 0);
});

test('a rate-limited request returns 429 and sends nothing', async () => {
  reset();
  rateLimitAllowed = false;
  const res = await post(VALID);
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(sent.length, 0);
});

test('a rate-limiter outage does not take contact down', async () => {
  // The rate limiter needs Mongo; sending the email does not. Since /help now
  // redirects here, this is the only contact route on the site, so a database
  // hiccup must not silence it: the visitor would have no way to reach us and
  // no way to report that it is broken. Fail open, log, still send.
  reset();
  rateLimitThrows = true;
  const res = await post(VALID);
  assert.strictEqual(res.statusCode, 201, 'a rate-limiter failure blocked a legitimate message');
  assert.strictEqual(sent.length, 1, 'the email was not sent');
});

// ── output safety ──

test('escapes HTML in the built-in email markup', async () => {
  reset();
  await post({ ...VALID, name: '<script>alert(1)</script>', message: '<img src=x onerror=alert(1)>' });
  const html = sent[0].html;
  assert.ok(!html.includes('<script>'), 'raw script tag leaked into the email');
  assert.ok(!html.includes('<img'), 'raw img tag leaked into the email');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('escapes HTML on the custom-template path too', async () => {
  // The regression this guards: applyCustomTemplate substitutes raw values into
  // admin-authored HTML. Escaping only inside the built-in markup would mean
  // creating a template silently reintroduces injection.
  reset();
  template = { subject: '{{subject}}', html: '<p>{{userName}}: {{message}}</p>' };
  await post({ ...VALID, name: '<script>alert(1)</script>', message: '<b>x</b>' });
  const html = sent[0].html;
  assert.ok(!html.includes('<script>'), 'raw script tag leaked through the template path');
  assert.ok(!html.includes('<b>x</b>'), 'raw markup leaked through the template path');
});

test('escapes exactly once, never twice', async () => {
  reset();
  await post({ ...VALID, message: '5 < 10 & fine' });
  assert.ok(sent[0].html.includes('&lt; 10 &amp; fine'));
  assert.ok(!sent[0].html.includes('&amp;amp;'), 'value was double-escaped');
});

test('strips CR and LF from anything reaching a mail header', async () => {
  reset();
  await post({ ...VALID, subject: 'Hi\r\nBcc: victim@example.com' });
  assert.ok(!/[\r\n]/.test(sent[0].subject), 'header injection was possible via subject');
  assert.ok(sent[0].subject.includes('Bcc: victim@example.com'), 'content should survive, folded onto one line');
});

test('replies to the sender and delivers to support', async () => {
  reset();
  await post(VALID);
  assert.strictEqual(sent[0].replyTo, VALID.email);
  assert.strictEqual(sent[0].to, 'support@suparank.ai');
});

test('an unknown category falls back to General', async () => {
  reset();
  await post({ ...VALID, category: 'Not-A-Real-Category' });
  assert.ok(sent[0].subject.includes('General'));
});
