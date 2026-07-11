/**
 * Phase 1 (v4.1 plan) — AI cost ledger INTEGRATION mocks.
 *
 * Pushes fake provider responses / SSE streams through the REAL code paths
 * and asserts the exact ledger rows that come out the other side:
 *
 *  1. makeUsageTap (aiController)      — parses the Go engine's snake_case
 *     usage events, sums multi-turn agent usage, captures the serving model.
 *  2. collectStreamText (brandVoice)   — collects text AND records a
 *     voice_extraction-style row from the forwarded usage event, resolving
 *     org + tier from the workspace.
 *  3. streamAudit (contentController)  — full OpenRouter SSE mock including
 *     the stream_options.include_usage final chunk; asserts the audit row.
 *  4. runScan (aiTrackerScanEngine)    — full 4-platform scan with mocked
 *     provider APIs + Claude analyzer; asserts one search row per engine and
 *     one analyze row per response, all carrying org/tier context.
 *
 * All external I/O is monkey-patched (global.fetch, mongoose statics) per the
 * repo's test convention — no DB, no network.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const AiCostLedger = require('../src/models/AiCostLedger');
const Workspace = require('../src/models/Workspace');
const Content = require('../src/models/Content');
const tierService = require('../src/services/tierService');
const { makeUsageTap } = require('../src/controllers/aiController');
const { collectStreamText } = require('../src/controllers/brandVoiceController');
const { streamAudit } = require('../src/controllers/contentController');
const { runScan } = require('../src/services/aiTrackerScanEngine');

// ── Shared capture + patches ─────────────────────────────────────────────

let rows = [];
const real = {
  create: AiCostLedger.create,
  wsFindById: Workspace.findById,
  contentFindOneAndUpdate: Content.findOneAndUpdate,
  getOrgTierConfig: tierService.getOrgTierConfig,
  fetch: global.fetch,
};

beforeEach(() => {
  rows = [];
  AiCostLedger.create = async (doc) => { rows.push(doc); return { ...doc, _id: 'x' }; };
  Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org-from-ws' }) }) });
  Content.findOneAndUpdate = async () => ({});
  tierService.getOrgTierConfig = async () => ({ tier: 'professional', config: {} });
});

afterEach(() => {
  AiCostLedger.create = real.create;
  Workspace.findById = real.wsFindById;
  Content.findOneAndUpdate = real.contentFindOneAndUpdate;
  tierService.getOrgTierConfig = real.getOrgTierConfig;
  global.fetch = real.fetch;
});

/** Let fire-and-forget record() promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** Fake fetch Response whose body streams the given string chunks. */
function sseResponse(chunks, ok = true, status = 200) {
  let i = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
    text: async () => '',
    json: async () => ({}),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. makeUsageTap — the chat/agent SSE tap
// ═══════════════════════════════════════════════════════════════════════

test('usage tap: sums multi-turn snake_case usage events and keeps the last model', () => {
  const tap = makeUsageTap();
  // Turn 1 + turn 2 usage events exactly as the Go engine emits them,
  // plus noise events the tap must ignore.
  tap.addChunk(Buffer.from(
    'data: {"type":"text_delta","textDelta":"hello"}\n\n' +
    'data: {"type":"usage","usage":{"input_tokens":1000,"output_tokens":200},"model":"google/gemini-2.5-flash"}\n\n'
  ));
  tap.addChunk(Buffer.from(
    'data: {"type":"usage","usage":{"input_tokens":500,"output_tokens":100},"model":"google/gemini-2.5-flash"}\n\n' +
    'data: [DONE]\n\n'
  ));
  const s = tap.snapshot();
  assert.equal(s.inputTokens, 1500);
  assert.equal(s.outputTokens, 300);
  assert.equal(s.model, 'google/gemini-2.5-flash');
});

test('usage tap: survives an event split across chunk boundaries', () => {
  const tap = makeUsageTap();
  const ev = 'data: {"type":"usage","usage":{"input_tokens":42,"output_tokens":7},"model":"m"}\n\n';
  const mid = Math.floor(ev.length / 2);
  tap.addChunk(Buffer.from(ev.slice(0, mid)));
  tap.addChunk(Buffer.from(ev.slice(mid)));
  const s = tap.snapshot();
  assert.equal(s.inputTokens, 42);
  assert.equal(s.outputTokens, 7);
});

test('usage tap: accepts legacy camelCase fields', () => {
  const tap = makeUsageTap();
  tap.addChunk(Buffer.from('data: {"type":"usage","usage":{"inputTokens":10,"outputTokens":5}}\n\n'));
  const s = tap.snapshot();
  assert.equal(s.inputTokens, 10);
  assert.equal(s.outputTokens, 5);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. collectStreamText — brand-voice /api/rewrite consumer
// ═══════════════════════════════════════════════════════════════════════

test('collectStreamText: collects text and records usage with org+tier resolved from workspace', async () => {
  const response = sseResponse([
    'data: {"type":"text_delta","textDelta":"A concise "}\n\n',
    'data: {"type":"text_delta","textDelta":"style summary."}\n\n',
    'data: {"type":"usage","usage":{"input_tokens":800,"output_tokens":120},"model":"google/gemini-2.5-flash-lite"}\n\ndata: [DONE]\n\n',
  ]);

  const text = await collectStreamText(response, {
    action: 'voice_extraction',
    workspaceId: 'ws1',
    userId: 'u1',
    metadata: { avatarId: 'av1', source: 'file_upload' },
  });
  await settle();

  assert.equal(text, 'A concise style summary.');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.action, 'voice_extraction');
  assert.equal(row.model, 'google/gemini-2.5-flash-lite');
  assert.equal(row.tokensIn, 800);
  assert.equal(row.tokensOut, 120);
  assert.equal(row.organizationId, 'org-from-ws'); // resolved via Workspace.findById
  assert.equal(row.tier, 'professional');          // resolved via tierService
  assert.equal(row.metadata.avatarId, 'av1');
  // 800/1e6*0.10 + 120/1e6*0.40 = 0.000128
  assert.ok(Math.abs(row.costUsd - 0.000128) < 1e-9, `costUsd was ${row.costUsd}`);
});

test('collectStreamText: no costCtx → no ledger row (back-compat)', async () => {
  const response = sseResponse([
    'data: {"type":"text_delta","textDelta":"hi"}\n\n',
    'data: {"type":"usage","usage":{"input_tokens":10,"output_tokens":2}}\n\n',
  ]);
  const text = await collectStreamText(response);
  await settle();
  assert.equal(text, 'hi');
  assert.equal(rows.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. streamAudit — OpenRouter SSE with include_usage
// ═══════════════════════════════════════════════════════════════════════

test('streamAudit: records audit row from the include_usage final chunk', async () => {
  process.env.OPENROUTER_API_KEY = 'test'; // streamAudit 500s without a key
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    const auditJson = JSON.stringify({ overallScore: 82, summary: 'solid', criteria: [] });
    return sseResponse([
      // content split over two delta chunks
      `data: ${JSON.stringify({ choices: [{ delta: { content: auditJson.slice(0, 20) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: auditJson.slice(20) } }] })}\n\n`,
      // OpenRouter's final usage chunk: empty choices + usage (include_usage)
      'data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":567}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };

  const written = [];
  const req = { on() {}, creditContext: { orgId: 'org1' }, user: { userId: 'u1' }, workspace: { _id: 'ws1' } };
  const res = {
    writeHead() {}, write(d) { written.push(String(d)); }, end() {},
    status(c) { this._c = c; return this; }, json(b) { this._b = b; return this; },
  };

  await streamAudit(req, res, {
    prompt: 'audit this',
    contentHash: 'h1',
    contentId: { toString: () => 'c1' },
    dbField: 'audits',
    errorPrefix: 'AI audit failed',
    tierQuota: null,
  });
  await settle();

  // The request actually asked OpenRouter for usage
  assert.deepEqual(capturedBody.stream_options, { include_usage: true });
  // The client still received a complete event with the audit
  assert.ok(written.some((w) => w.includes('"type":"complete"')));
  // One audit ledger row with the real token counts, priced from the registry
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.action, 'audit');
  assert.equal(row.model, 'moonshotai/kimi-k2-0905');
  assert.equal(row.tokensIn, 1234);
  assert.equal(row.tokensOut, 567);
  assert.equal(row.organizationId, 'org1');
  assert.equal(row.tier, 'professional');
  assert.ok(row.costUsd > 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. runScan — full tracker scan across 4 mocked providers + analyzer
// ═══════════════════════════════════════════════════════════════════════

test('runScan: one search row per engine + one analyze row per response, all with ctx', async () => {
  process.env.CHATGPT_API_KEY = 'test';
  process.env.GEMINI_API_KEY = 'test';
  process.env.PERPLEXITY_API_KEY = 'test';
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.OPENROUTER_API_KEY = 'test'; // Phase 3: analyzer runs on Kimi via OpenRouter

  const analysisJson = JSON.stringify({
    mentioned: true, position: 1, cited: false, citationCount: 0,
    citedUrls: [], brandRanking: [], sentiment: 'neutral', sentimentScore: 50,
  });

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => '', headers: { get: () => null } });

    if (u.includes('api.openai.com/v1/responses')) {
      return jsonRes({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'suparank is a top pick [example.com](https://example.com/a)', annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      return jsonRes({
        candidates: [{ content: { parts: [{ text: 'suparank leads the field.' }] } }],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 40 },
      });
    }
    if (u.includes('api.perplexity.ai')) {
      return jsonRes({
        choices: [{ message: { content: 'suparank ranks well [example.com](https://example.com/b)' } }],
        citations: ['https://example.com/b'],
        usage: { prompt_tokens: 60, completion_tokens: 30 },
      });
    }
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(opts.body);
      if (body.tools) {
        // Claude web-search variant
        return jsonRes({
          content: [{ type: 'text', text: 'great tools include suparank', citations: [] }],
          usage: { input_tokens: 70, output_tokens: 35 },
        });
      }
      // (Anthropic no-tools path no longer used — analyzer moved to OpenRouter.)
      return jsonRes({ content: [{ type: 'text', text: analysisJson }], usage: { input_tokens: 0, output_tokens: 0 } });
    }
    if (u.includes('openrouter.ai')) {
      // Phase 3: the tracker analyzer now runs on Kimi via OpenRouter (OpenAI shape).
      return jsonRes({
        model: 'moonshotai/kimi-k2-0905',
        choices: [{ message: { content: analysisJson }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };

  const tracker = { domain: 'suparank.com', defaultModels: ['chatgpt', 'gemini', 'claude', 'perplexity'] };
  const prompts = [{ _id: 'p1', prompt: 'best seo tool' }];
  const ctx = { organizationId: 'org1', workspaceId: 'ws1', userId: 'u1', tier: 'agency', trackerId: 't1' };

  const result = await runScan(tracker, prompts, [], async () => {}, ctx);
  await settle();

  // Scan itself still works
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].platforms.filter((p) => !p.error).length, 4);

  // 4 search rows + 4 analyze rows
  const search = rows.filter((r) => r.metadata.step === 'search');
  const analyze = rows.filter((r) => r.metadata.step === 'analyze');
  assert.equal(search.length, 4, `search rows: ${JSON.stringify(search.map((r) => r.metadata.engine))}`);
  assert.equal(analyze.length, 4);
  // Phase 3: every analyze row is now Kimi via OpenRouter, not Anthropic Haiku.
  for (const a of analyze) {
    assert.equal(a.model, 'moonshotai/kimi-k2-0905', `analyze model: ${a.model}`);
    assert.equal(a.metadata.engine, 'kimi');
    assert.equal(a.tokensIn, 200);
    assert.equal(a.tokensOut, 20);
  }

  const byEngine = Object.fromEntries(search.map((r) => [r.metadata.engine, r]));
  assert.equal(byEngine.chatgpt.model, 'gpt-4o-mini');
  assert.equal(byEngine.chatgpt.tokensIn, 100);
  assert.equal(byEngine.gemini.model, 'gemini-2.5-flash-lite');
  assert.equal(byEngine.gemini.tokensOut, 40);
  assert.equal(byEngine.perplexity.model, 'sonar');
  assert.equal(byEngine.claude.model, 'claude-haiku-4-5-20251001');

  // Every row carries the scan context and a non-zero cost
  for (const r of rows) {
    assert.equal(r.action, 'tracker_scan');
    assert.equal(r.organizationId, 'org1');
    assert.equal(r.tier, 'agency');
    assert.equal(r.metadata.trackerId, 't1');
    assert.ok(r.costUsd > 0, `zero cost for ${r.model}`);
    assert.equal(r.unknownModel, false);
  }
});

test('runScan: no ctx (legacy/test callers) → scan works, nothing recorded', async () => {
  process.env.CHATGPT_API_KEY = '';
  process.env.PERPLEXITY_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = ''; // keep analyzer on fallback (env persists across tests)
  process.env.GEMINI_API_KEY = 'test';

  const analysisJson = JSON.stringify({ mentioned: false, brandRanking: [] });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => '', headers: { get: () => null } });
    if (u.includes('generativelanguage')) {
      return jsonRes({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    }
    if (u.includes('api.anthropic.com')) {
      return jsonRes({ content: [{ type: 'text', text: analysisJson }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };

  const tracker = { domain: 'x.com', defaultModels: ['gemini'] };
  await runScan(tracker, [{ _id: 'p1', prompt: 'q' }], [], async () => {}, undefined);
  await settle();
  assert.equal(rows.length, 0);
});
