/**
 * Phase 8 — unsafe citation URLs through the FULL scan pipeline.
 *
 * Every layer that carries URLs gets poisoned: ChatGPT's url_citation
 * annotations, Perplexity's citations array, Claude's web_search_result and
 * block citations, and the analyzer's own citationUrls echo. The stored
 * PlatformResults must contain zero unsafe URLs in citedUrls AND zero
 * unsafe schemes embedded into aiResponse markdown (the Claude embed path).
 *
 * Run: node --test tests/aiTracker/security-citations.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');
const vendorMock = require('./helpers/vendorMock');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.PERPLEXITY_API_KEY = 'test-key';
delete process.env.GEMINI_API_KEY;

const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../../src/models/AiTrackerScan');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

const UNSAFE = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'http://10.0.0.8/internal',
  'http://169.254.169.254/latest/meta-data',
  'http://localhost:4001/admin',
  'https://mongo.internal/dump',
];
const SAFE = 'https://citesafe.com/article';

const chatgptFixture = {
  output: [{
    type: 'message', role: 'assistant',
    content: [{
      type: 'output_text',
      text: `CiteSafe covers this well [citesafe.com](${SAFE}).`,
      annotations: [
        { type: 'url_citation', url: SAFE },
        ...UNSAFE.map((u) => ({ type: 'url_citation', url: u })),
      ],
    }],
  }],
  usage: { input_tokens: 50, output_tokens: 30 },
};

const perplexityFixture = {
  choices: [{ message: { content: `CiteSafe again [citesafe.com](${SAFE}).` } }],
  citations: [SAFE, ...UNSAFE],
  related_questions: [],
  usage: { prompt_tokens: 40, completion_tokens: 20 },
};

const claudeFixture = {
  content: [
    {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', url: SAFE },
        ...UNSAFE.map((u) => ({ type: 'web_search_result', url: u })),
      ],
    },
    {
      type: 'text',
      text: 'CiteSafe leads this space.',
      citations: [{ type: 'web_search_result_location', url: SAFE }, ...UNSAFE.map((u) => ({ url: u }))],
    },
  ],
  usage: { input_tokens: 60, output_tokens: 25 },
};

// The analyzer echoes back EVERYTHING it saw — the F3-08 gate must filter.
const kimiFixture = {
  choices: [{
    message: {
      content: JSON.stringify({
        brands: ['CiteSafe'],
        citationUrls: [SAFE, ...UNSAFE],
        sentiment: { label: 'positive', score: 80 },
      }),
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 200, completion_tokens: 60 },
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

describe('unsafe citation URLs never survive the pipeline', () => {
  it('chatgpt + perplexity + claude poisoned at every layer → stored results are clean', { timeout: 60_000 }, async () => {
    const ws = await Workspace.create({
      workspaceNumber: 998101,
      userId: new mongoose.Types.ObjectId(),
      organizationId: null,
      name: 'Citations WS',
    });
    const tracker = await AiTracker.create({
      workspaceId: ws._id, domain: 'citesafe.com', name: 'Citations Monitor',
      defaultModels: ['chatgpt', 'claude', 'perplexity'], scanStatus: 'pending',
    });
    await AiTrackerPrompt.create({
      trackerId: tracker._id, prompt: 'citation safety probe',
      models: ['chatgpt', 'claude', 'perplexity'], frequency: 'Weekly', active: true,
    });

    vendorMock.script({
      chatgpt: [vendorMock.jsonReply(chatgptFixture)],
      perplexity: [vendorMock.jsonReply(perplexityFixture)],
      claude: [vendorMock.jsonReply(claudeFixture)],
      kimi: [{ ...vendorMock.jsonReply(kimiFixture), repeat: true }],
    });

    await aiTrackerController.executeScan(tracker._id, null, { force: true, bill: false });

    const scan = await AiTrackerScan.findOne({ trackerId: tracker._id }).lean();
    assert.equal(scan.status, 'ready');
    const platforms = scan.results[0].platforms;
    assert.equal(platforms.length, 3, 'all three poisoned platforms completed');

    for (const p of platforms) {
      assert.equal(p.error, false, `${p.platformId} completed cleanly`);
      // 1. Stored citedUrls: zero unsafe survivors, the safe one intact.
      for (const u of p.citedUrls) {
        assert.ok(
          !UNSAFE.some((bad) => u.includes(bad.replace(/^https?:\/\//, '').slice(0, 12)) || u === bad),
          `${p.platformId}: unsafe URL stored in citedUrls: ${u}`,
        );
      }
      assert.ok(p.citedUrls.includes(SAFE), `${p.platformId}: the legitimate citation survived`);
      // 2. Embedded answer text: no unsafe scheme reachable via markdown link.
      assert.ok(!/\]\(javascript:/i.test(p.aiResponse), `${p.platformId}: javascript: embedded in aiResponse`);
      assert.ok(!/\]\(data:/i.test(p.aiResponse), `${p.platformId}: data: embedded in aiResponse`);
      assert.ok(!p.aiResponse.includes('169.254.169.254'), `${p.platformId}: metadata endpoint embedded`);
    }
  });
});
