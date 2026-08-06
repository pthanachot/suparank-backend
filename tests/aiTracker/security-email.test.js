/**
 * Phase 8 — scan-summary email XSS, END-TO-END through executeScan's B14
 * build (the F4-23 fix under real fire, not just the htmlEscape unit).
 *
 * Attacker-controlled fields: prompt text (≤500 chars, no content
 * validation) and competitor names (extracted from AI responses — i.e.
 * prompt-injectable, F3-07 surface). Both are seeded with live payloads;
 * the captured email HTML must contain only escaped forms.
 *
 * Uses the emailHtmlEscaping.test.js require.cache pattern: the template
 * and transport layers are stubbed BEFORE the controller loads, so the
 * html we capture is exactly what the controller built.
 *
 * Run: node --test tests/aiTracker/security-email.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');

const SRC = path.join(__dirname, '../../src');
const sentEmails = [];

// Stub the template layer as a pass-through and capture the transport —
// MUST precede the controller require chain.
// Behaves like the REAL default template: raw {{var}} substitution with no
// escaping of its own (emailHtmlEscaping.test.js pattern). That is precisely
// what makes this a valid XSS test — any unescaped value the controller
// passes lands as live markup here.
const TEMPLATE_HTML = [
  '<h1>{{trackerName}} — {{domain}}</h1>',
  '<table>{{platformRows}}</table>',
  '<table>{{promptRows}}</table>',
  '<table>{{competitorRows}}</table>',
  '<div>{{actionRows}}</div>',
].join('');

const tplPath = require.resolve(path.join(SRC, 'controllers/emailPortalController.js'));
require.cache[tplPath] = {
  id: tplPath, filename: tplPath, loaded: true,
  exports: {
    applyCustomTemplate: async (_triggerId, emailOptions) => {
      if (!emailOptions.data) return;
      emailOptions.html = Object.entries(emailOptions.data).reduce(
        (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? '')),
        TEMPLATE_HTML,
      );
      delete emailOptions.data;
    },
  },
};
const mailPath = require.resolve(path.join(SRC, 'utils/emailService.js'));
require.cache[mailPath] = {
  id: mailPath, filename: mailPath, loaded: true,
  exports: { sendEmail: async (o) => { sentEmails.push(o); return true; } },
};

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PERPLEXITY_API_KEY;

const User = require('../../src/models/User');
const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

const PROMPT_PAYLOAD = '<style>body{background:red}</style><img src=x onerror=alert(1)> {{userName}} best tools';
const COMPETITOR_PAYLOAD = "<script>alert('comp')</script>EvilCo";

const chatgptFixture = {
  output: [{
    type: 'message', role: 'assistant',
    content: [{
      type: 'output_text',
      text: `EmailSafe is a solid choice [emailsafe.com](https://emailsafe.com/a). ${COMPETITOR_PAYLOAD} also competes here.`,
      annotations: [{ type: 'url_citation', url: 'https://emailsafe.com/a' }],
    }],
  }],
  usage: { input_tokens: 60, output_tokens: 40 },
};

const kimiFixture = {
  choices: [{
    message: {
      content: JSON.stringify({
        brands: ['EmailSafe', COMPETITOR_PAYLOAD],
        citationUrls: ['https://emailsafe.com/a'],
        sentiment: { label: 'positive', score: 80 },
      }),
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 150, completion_tokens: 40 },
};

before(async () => {
  await db.connect();
  await db.clear();
  vendorMock.install();
}, { timeout: 300_000 });

after(async () => {
  vendorMock.uninstall();
  await db.disconnect();
});

describe('scan-summary email is XSS-safe end-to-end (F4-23)', () => {
  it('malicious prompt text and competitor names arrive fully escaped', { timeout: 60_000 }, async () => {
    const user = await User.create({
      userId: 998_000_001,
      email: 'owner@emailsafe.test',
      password: 'Pw!23456789',
      name: 'Email Owner',
      verified: true,
    });
    const ws = await Workspace.create({
      workspaceNumber: 998201, userId: user._id, organizationId: null, name: 'Email WS',
    });
    const tracker = await AiTracker.create({
      workspaceId: ws._id, domain: 'emailsafe.com', name: 'Email Monitor',
      defaultModels: ['chatgpt'], scanStatus: 'pending',
    });
    await AiTrackerPrompt.create({
      trackerId: tracker._id, prompt: PROMPT_PAYLOAD, models: ['chatgpt'], frequency: 'Weekly', active: true,
    });

    vendorMock.script({
      chatgpt: [{ ...vendorMock.jsonReply(chatgptFixture), repeat: true }],
      kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
    });

    await aiTrackerController.executeScan(tracker._id, user._id, { force: true, bill: false });

    assert.equal(sentEmails.length, 1, 'exactly one scan-summary email sent');
    const { html, to } = sentEmails[0];
    assert.equal(to, 'owner@emailsafe.test');
    assert.ok(html && html.length > 200, 'controller-built html present');

    // Raw payloads must be absent…
    assert.ok(!html.includes('<style>body'), 'raw <style> leaked into email html');
    assert.ok(!html.includes('<img src=x onerror'), 'raw onerror img leaked');
    assert.ok(!html.includes("<script>alert('comp')</script>"), 'raw script from competitor name leaked');
    // …their escaped forms present (the prompt row renders the prompt text).
    assert.ok(html.includes('&lt;style&gt;'), 'escaped prompt payload should appear in the prompt rows');
    assert.ok(html.includes('&lt;script&gt;') || html.includes('EvilCo'), 'escaped competitor name should appear');
    // Template braces stay inert data (the template layer is a no-op here;
    // the brace text must survive escaped-or-literal, never substituted).
    assert.ok(!/\bundefined\b/.test(html), 'no template-substitution artifacts');
  });
});
