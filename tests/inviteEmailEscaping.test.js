// Guards the invite email against being used as a phishing relay.
//
// This is the highest-severity escaping on the platform. The contact and
// feedback emails go to our own support inbox; an invite goes to an address the
// SENDER picks. `inviterName` (their profile name) and `orgName` (their org
// name) are free text they control, and applyCustomTemplate substitutes them
// with a raw String(value) replace.
//
// Unescaped, anyone on the free plan could put markup in their profile name,
// invite a stranger, and have our infrastructure deliver attacker-authored HTML
// in an email carrying our branding and passing SPF/DKIM. Beyond the phishing
// itself, doing that at volume gets the sending domain blacklisted, which takes
// password resets and receipts down with it.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const sent = [];

// Mirrors the real member_invite default template, including {{orgName}} in the
// subject, and the real raw-substitution behaviour.
const TEMPLATE = {
  subject: "You've been invited to join {{orgName}}",
  html: '<p>{{inviterName}} has invited you to join <strong>{{orgName}}</strong> as {{role}}.</p><a href="{{acceptUrl}}">Accept</a>',
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub(path.join(SRC, 'controllers/emailPortalController.js'), {
  applyCustomTemplate: async (triggerId, o) => {
    if (!o.data) return;
    const sub = (s) =>
      Object.entries(o.data).reduce(
        (a, [k, v]) => a.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? '')),
        s
      );
    o.subject = sub(TEMPLATE.subject);
    o.html = sub(TEMPLATE.html);
    delete o.data;
  },
});
stub(path.join(SRC, 'utils/emailService.js'), {
  sendEmail: async (o) => { sent.push(o); return true; },
});
stub(path.join(SRC, 'services/domainService.js'), {
  resolveBaseUrl: async () => 'https://app.suparank.ai',
});

// Persistence and audit are irrelevant here; keep them inert.
stub(path.join(SRC, 'models/Invite.js'), {
  deleteOne: async () => {},
  create: async (doc) => doc,
  hashToken: (t) => `hash:${t}`,
});
stub(path.join(SRC, 'models/Organization.js'), {});
stub(path.join(SRC, 'models/OrgMember.js'), {});
stub(path.join(SRC, 'models/WorkspaceMember.js'), {});
stub(path.join(SRC, 'models/Workspace.js'), {});
stub(path.join(SRC, 'models/User.js'), {});
stub(path.join(SRC, 'services/auditService.js'), {});

const inviteService = require(path.join(SRC, 'services/inviteService.js'));

const PAYLOAD = '</p><a href="https://evil.example/login">Verify your account</a><p>';

async function invite({ orgName = 'Acme', inviterName = 'Jo' } = {}) {
  sent.length = 0;
  await inviteService.createInvite({
    org: { _id: 'org1', name: orgName },
    email: 'victim@example.com',
    role: 'editor',
    accessScope: 'org',
    invitedBy: 'u1',
    inviterName,
  });
  return sent[0];
}

test('a malicious inviter name cannot inject markup into the invite email', async () => {
  const mail = await invite({ inviterName: PAYLOAD });
  assert.ok(!mail.html.includes('<a href="https://evil.example/login">'), 'attacker anchor reached the recipient');
  assert.ok(mail.html.includes('&lt;a href='), 'expected the payload to appear escaped');
});

test('a malicious org name cannot inject markup into the invite email', async () => {
  const mail = await invite({ orgName: PAYLOAD });
  assert.ok(!mail.html.includes('<a href="https://evil.example/login">'), 'attacker anchor reached the recipient');
});

test('the accept link is still a working URL after escaping', async () => {
  const mail = await invite();
  assert.ok(/href="https:\/\/app\.suparank\.ai\/accept-invite\?token=[a-f0-9]+"/.test(mail.html),
    `accept link was mangled: ${mail.html}`);
});

test('the subject reads naturally for an ordinary org name', async () => {
  // Regression: escaping for the body also lands in the subject, because the
  // default template puts {{orgName}} there. "Tom's Agency" must not arrive as
  // "Tom&#39;s Agency".
  const mail = await invite({ orgName: "Tom's Agency & Co" });
  assert.strictEqual(mail.subject, "You've been invited to join Tom's Agency & Co");
});

test('no CR/LF can reach the Subject header via the org name', async () => {
  const mail = await invite({ orgName: 'Acme\r\nBcc: victim2@example.com' });
  assert.ok(!/[\r\n]/.test(mail.subject), 'header injection was possible via org name');
});

test('the email still reaches the intended recipient', async () => {
  const mail = await invite();
  assert.strictEqual(mail.to, 'victim@example.com');
});
