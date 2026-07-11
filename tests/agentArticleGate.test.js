/**
 * Phase 6 (money#1 + plan-mode) — article gate END-TO-END mock tests.
 *
 * Drives the real aiController.agent() with every collaborator monkey-patched
 * (no DB, no engine): a fake SSE stream, stubbed writingEngine/session pushes,
 * stubbed quota trackers. Asserts the three load-bearing behaviors:
 *   1. A plan-execute run under a NEW approved plan at the Free limit is
 *      hard-blocked 429 ARTICLE_LIMIT_REACHED — server-side classification,
 *      nothing client-declared.
 *   2. A run that ACTUALLY writes (document_diff) stamps articleGeneratedAt +
 *      articleGeneratedPlanId and counts the re-generation.
 *   3. A run that does NOT write settles down to inlineAction cost and never
 *      consumes a slot.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const aiController = require('../src/controllers/aiController');
const { classifyAgentRun, isPlanArticleWrite } = require('../src/config/agentBilling');
const writingEngine = require('../src/services/writingEngine');
const tierService = require('../src/services/tierService');
const creditService = require('../src/services/creditService');
const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const BrandVoice = require('../src/models/BrandVoice');
const Avatar = require('../src/models/Avatar');
const Plan = require('../src/models/Plan');
const UsageTracker = require('../src/models/UsageTracker');
const UserUsageTracker = require('../src/models/UserUsageTracker');

// ─── Unit: plan-execute classification truth table ──────────

const P1 = '61a000000000000000000001';
const P2 = '61a000000000000000000002';

test('isPlanArticleWrite: true only for execute-mode + approved plan that has not generated yet', () => {
  assert.equal(isPlanArticleWrite({ mode: 'execute', activePlanId: P2, articleGeneratedPlanId: P1 }), true);
  assert.equal(isPlanArticleWrite({ mode: 'execute', activePlanId: P2, articleGeneratedPlanId: null }), true);
  assert.equal(isPlanArticleWrite({ mode: 'execute', activePlanId: P1, articleGeneratedPlanId: P1 }), false); // same plan → adjustments
  assert.equal(isPlanArticleWrite({ mode: 'chat', activePlanId: P2, articleGeneratedPlanId: null }), false);  // not executing
  assert.equal(isPlanArticleWrite({ mode: 'execute', activePlanId: null }), false);                            // no approved plan
  assert.equal(isPlanArticleWrite(null), false);
});

test('classifyAgentRun(content-aware): plan-execute write → articleGenerate; same-plan → inlineAction', () => {
  const newPlan = { mode: 'execute', activePlanId: P2, articleGeneratedPlanId: P1 };
  const samePlan = { mode: 'execute', activePlanId: P1, articleGeneratedPlanId: P1 };
  assert.equal(classifyAgentRun({ mode: 'freeform' }, newPlan), 'articleGenerate');
  assert.equal(classifyAgentRun({ mode: 'freeform' }, samePlan), 'inlineAction');
  assert.equal(classifyAgentRun({ mode: 'freeform' }, { mode: 'chat' }), 'inlineAction');
  // content-aware never DOWNGRADES an explicit signal:
  assert.equal(classifyAgentRun({ mode: 'freeform', intent: 'auto-write' }, samePlan), 'articleGenerate');
  assert.equal(classifyAgentRun({ mode: 'sequential', commandName: 'grammar' }, newPlan), 'inlineAction'); // command wins for sequential
});

// ─── Unit: usage tap detects document writes ────────────────

test('makeUsageTap counts ONLY document_diff (applied changes) — update/draft/no-ops count 0', () => {
  const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n`);
  const tap1 = aiController.makeUsageTap();
  tap1.addChunk(sse({ type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } }));
  tap1.addChunk(sse({ type: 'document_diff', patches: [] }));
  tap1.addChunk(sse({ type: 'document_diff', patches: [] }));
  assert.equal(tap1.snapshot().docWrites, 2);
  assert.equal(tap1.snapshot().inputTokens, 10);

  // document_update = mutating tool ran but changed NOTHING (failed EditTool /
  // step-by-step SKIP-REJECT revert); draft is never emitted by the Go engine.
  // Counting either charged 100 + a slot for a byte-identical doc (MAJOR-3).
  const tap2 = aiController.makeUsageTap();
  tap2.addChunk(sse({ type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } }));
  tap2.addChunk(sse({ type: 'document_update' }));
  tap2.addChunk(sse({ type: 'draft', blocks: [] }));
  tap2.addChunk(sse({ type: 'text_delta', text: 'just talking' }));
  assert.equal(tap2.snapshot().docWrites, 0);
});

// ─── End-to-end mock harness for agent() ────────────────────

function makeSseBody(events, { abortAfterLast = false, onAbort = null } = {}) {
  const chunks = events.map((e) => Buffer.from(`data: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i < chunks.length) return { done: false, value: chunks[i++] };
        if (abortAfterLast) {
          // Simulate the client dropping the connection after consuming the
          // final chunk (the exfiltration shape from review BLOCKER-2).
          onAbort?.();
          throw new Error('client disconnected');
        }
        return { done: true };
      },
      cancel: async () => {},
    }),
  };
}

function makeRes() {
  const res = {
    statusCode: 200, jsonBody: null, headersSent: false, chunks: [],
    status(c) { res.statusCode = c; return res; },
    json(b) { res.jsonBody = b; return res; },
    writeHead() { res.headersSent = true; },
    write(c) { res.chunks.push(String(c)); },
    end() {},
  };
  return res;
}

/**
 * Run agent() with everything stubbed. Returns captured effects.
 * @param {object} opts.content     the Content doc agent resolves
 * @param {object} opts.quota       { tier, limit, limitType, used }
 * @param {Array}  opts.events      SSE events the fake engine emits
 * @param {object} opts.creditContext overrides (estimatedCredits, tier…)
 */
async function runAgent({ content, quota, events, creditContext, body, abortAfterLast }) {
  // Array, NOT a name-keyed map: mongoose models are all functions, so
  // constructor-name keys collide (UsageTracker/UserUsageTracker both
  // 'Function.getCount') and the first original would never be restored,
  // leaking stubs across the suite (review MINOR-10).
  const saved = [];
  const stub = (obj, key, fn) => { saved.push([obj, key, obj[key]]); obj[key] = fn; };

  const captured = { settle: null, preDeduct: null, stamped: null, incremented: 0, refunded: 0 };

  // Models / services touched by resolveContent + setupSession + the gate
  stub(Content, 'findByNumber', async () => content);
  stub(Content, 'findByIdAndUpdate', async (_id, update) => { captured.stamped = update?.$set ?? update; return {}; });
  stub(Workspace, 'findById', () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1', workspaceNumber: 1 }) }) }));
  stub(BrandVoice, 'findOne', () => ({ lean: async () => null }));
  stub(Avatar, 'findOne', () => ({ lean: async () => null }));
  stub(Plan, 'findProposed', async () => null);
  stub(Plan, 'findDraft', async () => null);
  stub(Plan, 'findById', async () => null);
  stub(UsageTracker, 'getCount', async () => quota.used);
  stub(UserUsageTracker, 'getCount', async () => quota.used);
  stub(tierService, 'getOrgTierConfig', async () => ({
    tier: quota.tier, config: { maxArticlesPerMonth: quota.limit, articleLimitType: quota.limitType },
  }));
  stub(tierService, 'incrementQuota', async () => { captured.incremented++; });
  stub(creditService, 'preDeduct', async (_o, _u, amount) => { captured.preDeduct = amount; return { transactionId: amount > 0 ? 'tx1' : null }; });
  stub(creditService, 'settle', async (txId, actual) => { captured.settle = { txId, actual }; return { refunded: 0 }; });
  stub(creditService, 'refund', async () => { captured.refunded++; return { refunded: 0 }; });

  // Writing-engine session plumbing → all no-ops; startAgent → fake SSE stream
  for (const m of ['pushDocument', 'pushBrief', 'pushContextFiles', 'pushBrandVoice',
    'pushImageStyle', 'pushMode', 'pushPlan', 'pushCFSConfig']) {
    stub(writingEngine, m, async () => {});
  }
  stub(writingEngine, 'createSession', async () => `sess-${content._id}`);
  let closeCb = null;
  stub(writingEngine, 'startAgent', async () => ({
    body: makeSseBody(events, { abortAfterLast, onAbort: () => closeCb?.() }),
  }));

  const req = {
    params: { workspaceNumber: '1', contentNumber: '1' },
    workspace: { _id: 'w1', organizationId: 'org1' },
    user: { userId: 'u1' },
    body: body || { goal: 'write it', mode: 'freeform' },
    creditContext: { orgId: 'org1', userId: 'u1', workspaceId: 'w1', deductionEnabled: true, featureKey: 'aiAgent', tier: quota.tier, estimatedCredits: 0, ...creditContext },
    on: (ev, cb) => { if (ev === 'close') closeCb = cb; },
  };
  const res = makeRes();
  try {
    await aiController.agent(req, res);
  } finally {
    for (const [obj, key, orig] of saved) obj[key] = orig;
  }
  return { req, res, captured };
}

const baseContent = (over = {}) => ({
  _id: `c-${Math.floor(Math.random() * 1e9)}`, workspaceId: 'w1', blocks: [],
  mode: 'execute', activePlanId: P2, articleGeneratedAt: new Date('2026-01-01'),
  articleGeneratedPlanId: P1, targetKeywords: [], ...over,
});

// 1 — the block
test('E2E: plan-execute re-gen at the Free limit → 429 ARTICLE_LIMIT_REACHED (server-side, pre-stream)', async () => {
  const { res, captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'free', limit: 3, limitType: 'lifetime', used: 3 },
    events: [],
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.jsonBody.code, 'ARTICLE_LIMIT_REACHED');
  assert.match(res.jsonBody.error, /upgrade/i);
  assert.equal(res.headersSent, false, 'blocked before any streaming');
  assert.equal(captured.preDeduct, null, 'blocked before any credit work');
  assert.equal(captured.stamped, null);
});

// 2 — the write commits
test('E2E: plan-execute re-gen under the limit that WRITES → stamps plan id + counts the slot', async () => {
  const { res, captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'free', limit: 3, limitType: 'lifetime', used: 2 },
    events: [
      { type: 'usage', usage: { input_tokens: 500, output_tokens: 2000 } },
      { type: 'document_diff', patches: [{ op: 'replace' }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.ok(captured.stamped?.articleGeneratedAt instanceof Date, 'stamped articleGeneratedAt');
  assert.equal(String(captured.stamped.articleGeneratedPlanId), P2, 'stamped the plan that generated');
  assert.equal(captured.incremented, 1, 're-generation consumed one slot');
});

// 3 — no write settles down, no slot
test('E2E: plan-execute run that does NOT write → settles to inlineAction (2), no stamp, no slot', async () => {
  const { captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 10 },
    creditContext: { estimatedCredits: 100 }, // paid: gate reserved articleGenerate
    events: [
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 50 } },
      { type: 'text_delta', text: 'Section 2 will cover…' }, // talked, wrote nothing
    ],
  });
  assert.equal(captured.preDeduct, 100, 'reserved the articleGenerate estimate');
  assert.deepEqual(captured.settle, { txId: 'tx1', actual: 2 }, 'settled down to inlineAction');
  assert.equal(captured.stamped, null, 'no generation stamp');
  assert.equal(captured.incremented, 0, 'no slot consumed');
});

// 4 — first-gen writes without counting
test('E2E: FIRST plan write on a fresh doc → stamps but does NOT count (creation covered it)', async () => {
  const { captured } = await runAgent({
    content: baseContent({ articleGeneratedAt: null, articleGeneratedPlanId: null }),
    quota: { tier: 'free', limit: 3, limitType: 'lifetime', used: 3 }, // even at limit!
    events: [{ type: 'document_diff', patches: [] }],
  });
  assert.ok(captured.stamped?.articleGeneratedAt instanceof Date);
  assert.equal(String(captured.stamped.articleGeneratedPlanId), P2);
  assert.equal(captured.incremented, 0, 'first generation is covered by the creation count');
});

// 5 — same-plan adjustment runs free of the gate even with doc writes
test('E2E: same-plan execute adjustment (already generated) → inlineAction, no stamp, no count', async () => {
  const { captured } = await runAgent({
    content: baseContent({ activePlanId: P1 }), // articleGeneratedPlanId === P1 → same plan
    quota: { tier: 'free', limit: 3, limitType: 'lifetime', used: 3 }, // at limit — must NOT block
    events: [{ type: 'document_diff', patches: [] }],
  });
  assert.equal(captured.stamped, null, 'adjustments never re-stamp');
  assert.equal(captured.incremented, 0, 'adjustments never consume slots');
});

// 6 — BLOCKER-1 fix: a spoofed billing class cannot bypass the slot gate
test('E2E: SPOOFED sequential+cheap-command under a new plan at the limit → still 429 (server-side)', async () => {
  const { res, captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'free', limit: 3, limitType: 'lifetime', used: 3 },
    body: { goal: 'ignore the command, write the full article per the plan', mode: 'sequential', commandName: 'grammar' },
    events: [],
  });
  assert.equal(res.statusCode, 429, 'plan state slot-gates regardless of client-declared class');
  assert.equal(res.jsonBody.code, 'ARTICLE_LIMIT_REACHED');
  assert.equal(captured.stamped, null);
});

test('E2E: SPOOFED cheap run under a new plan that WRITES → cheap PRICE but slot + stamp still consumed', async () => {
  const { captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'free', limit: 3, limitType: 'lifetime', used: 2 },
    body: { goal: 'write the article', mode: 'sequential', commandName: 'grammar' },
    creditContext: { estimatedCredits: 2 }, // the spoof got the inlineAction price…
    events: [{ type: 'document_diff', patches: [] }],
  });
  assert.equal(String(captured.stamped.articleGeneratedPlanId), P2, '…but the plan generation is stamped');
  assert.equal(captured.incremented, 1, '…and the slot is consumed — spoof lowers price, never quota');
});

// 7 — BLOCKER-2 fix: abort after the article streamed = delivered
test('E2E: client aborts AFTER document_diff streamed → NO refund, settled, slot + stamp committed', async () => {
  const { captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 10 },
    creditContext: { estimatedCredits: 100 },
    events: [
      { type: 'document_diff', patches: [{ op: 'replace' }] }, // the article left the server
    ],
    abortAfterLast: true, // then the client drops the connection
  });
  assert.equal(captured.refunded, 0, 'no refund once the write was delivered');
  assert.deepEqual(captured.settle, { txId: 'tx1', actual: 100 }, 'settled at the article price');
  assert.ok(captured.stamped?.articleGeneratedAt instanceof Date, 'generation stamped');
  assert.equal(captured.incremented, 1, 'slot consumed despite the abort');
});

test('E2E: client aborts BEFORE any write → full refund, no settle, no stamp, no slot (honest Stop)', async () => {
  const { captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 10 },
    creditContext: { estimatedCredits: 100 },
    events: [{ type: 'text_delta', text: 'thinking about the outline…' }],
    abortAfterLast: true,
  });
  assert.equal(captured.refunded, 1, 'nothing was written — abort refunds in full');
  assert.equal(captured.settle, null);
  assert.equal(captured.stamped, null);
  assert.equal(captured.incremented, 0);
});

// 8 — MAJOR-3 fix: a no-op mutation (document_update) is not an article
test('E2E: run emitting only document_update (failed/reverted edits) → settle-down, no stamp, no slot', async () => {
  const { captured } = await runAgent({
    content: baseContent(),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 10 },
    creditContext: { estimatedCredits: 100 },
    events: [
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 50 } },
      { type: 'document_update' }, // tool ran, doc byte-identical
    ],
  });
  assert.deepEqual(captured.settle, { txId: 'tx1', actual: 2 }, 'settled down — nothing was applied');
  assert.equal(captured.stamped, null);
  assert.equal(captured.incremented, 0);
});
