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
const imageStorage = require('../src/services/imageStorage');
const systemSettings = require('../src/services/systemSettingsService');
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

// ─── Phase 3: image spend is metered ────────────────────────

test('makeUsageTap captures image spend from the terminal image_usage event', () => {
  const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n`);
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 100, output_tokens: 50 }, model: 'google/gemini-2.5-flash' }));
  tap.addChunk(sse({ type: 'image_usage', fullText: JSON.stringify({ images: 3, model: 'google/gemini-2.5-flash-image' }) }));

  const s = tap.snapshot();
  assert.equal(s.images, 3);
  assert.equal(s.imageModel, 'google/gemini-2.5-flash-image');
  // The TEXT model is untouched — images are priced on their own ledger row,
  // because passing an image count alongside a text model would price them at
  // that model's flat rate (usually absent ⇒ $0).
  assert.equal(s.model, 'google/gemini-2.5-flash');
  assert.equal(s.inputTokens, 100);
});

test('makeUsageTap reports zero images for a run that generated none', () => {
  const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n`);
  const tap = aiController.makeUsageTap();
  tap.addChunk(sse({ type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } }));
  // The completion carries a count too, but it predates the post-agent image
  // pass — reading it as well would double-count. Only image_usage counts.
  tap.addChunk(sse({ type: 'complete', completion: { stopReason: 'done', images: 2 } }));
  assert.equal(tap.snapshot().images, 0);
});

test('a malformed image_usage payload does not eat the events after it', () => {
  const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n`);
  const tap = aiController.makeUsageTap();
  // Asserting only "images === 0" here would pass even with the inner
  // try/catch deleted — 0 is the value either way. What actually needs
  // pinning is that a throw doesn't abort the rest of the line loop.
  tap.addChunk(Buffer.concat([
    sse({ type: 'image_usage', fullText: 'not json' }),
    sse({ type: 'usage', usage: { input_tokens: 7, output_tokens: 3 } }),
    sse({ type: 'image_usage', fullText: JSON.stringify({ images: 2, model: 'google/gemini-2.5-flash-image' }) }),
  ]));
  const s = tap.snapshot();
  assert.equal(s.inputTokens, 7, 'events after a malformed payload must still be parsed');
  assert.equal(s.images, 2, 'a later valid image_usage must still land');
});

test('image counts are clamped — no Infinity or negative can reach the ledger', () => {
  const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n`);
  // 1e999 parses to Infinity; unclamped it multiplies into costUsd and makes
  // every $sum over that window Infinity permanently.
  const inf = aiController.makeUsageTap();
  inf.addChunk(Buffer.from(`data: {"type":"image_usage","fullText":"{\\"images\\":1e999}"}\n`));
  assert.equal(inf.snapshot().images, 0);

  const neg = aiController.makeUsageTap();
  neg.addChunk(sse({ type: 'image_usage', fullText: JSON.stringify({ images: -5 }) }));
  assert.equal(neg.snapshot().images, 0, 'a negative count would credit the org');

  const huge = aiController.makeUsageTap();
  huge.addChunk(sse({ type: 'image_usage', fullText: JSON.stringify({ images: 1e9 }) }));
  assert.equal(huge.snapshot().images, 500, 'absurd counts clamp to a sane ceiling');
});

// A run stopped mid-generation must NOT be refunded once images exist.
//
// Slash commands generate every image BEFORE embedding any, so "no document
// write yet" was true for a run that had already bought eight images: hitting
// Stop refunded the credits in full while the provider had really billed us.
// The engine now reports the running image total per turn (not only at the
// end), so the count survives the abort that kills the stream.
test('a stopped run that already generated images is NOT refunded', async () => {
  const { captured } = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    body: { goal: 'illustrate it', mode: 'sequential', commandName: 'image' },
    disabledCommands: [], // /image ships off on price; enable it for this test
    creditContext: { estimatedCredits: 10 },
    events: [
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 50 } },
      // Per-turn report: images bought, nothing embedded yet.
      { type: 'image_usage', fullText: JSON.stringify({ images: 3, model: 'google/gemini-2.5-flash-image' }) },
    ],
    abortAfterLast: true, // the user hits Stop here
  });
  assert.equal(captured.refunded, 0,
    'images are unrecoverable spend — a stop after generating them must not refund');
});

test('a stopped run that generated nothing is still refunded', async () => {
  const { captured } = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    body: { goal: 'illustrate it', mode: 'sequential', commandName: 'image' },
    disabledCommands: [], // /image ships off on price; enable it for this test
    creditContext: { estimatedCredits: 10 },
    events: [{ type: 'usage', usage: { input_tokens: 100, output_tokens: 50 } }],
    abortAfterLast: true,
  });
  assert.equal(captured.refunded, 1,
    'stopping before anything was bought or written must still refund');
});

// getEngineCapabilities is stubbed out by the runAgent harness, so
// without these its parse, its cache and its failure path never execute — a
// rename of the engine's `image_storage` field would leave every test green
// while the guard silently stopped refusing anything.
test('getEngineCapabilities: parses, caches, and fails soft', async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  try {
    // Parses the engine's field.
    writingEngine.__resetEngineCapsCache();
    globalThis.fetch = async () => { fetches++; return { ok: true, json: async () => ({ image_storage: 'b2' }) }; };
    assert.deepEqual(await writingEngine.getEngineCapabilities(), { imageStorage: 'b2' });
    assert.equal(fetches, 1);

    // Second call inside the TTL does not re-fetch.
    await writingEngine.getEngineCapabilities();
    assert.equal(fetches, 1, 'a cached read must not hit the engine again');

    // A throw yields UNKNOWN (null), and is cached — a flapping engine must
    // not be hammered once per request.
    writingEngine.__resetEngineCapsCache();
    fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('ECONNREFUSED'); };
    assert.deepEqual(await writingEngine.getEngineCapabilities(), { imageStorage: null });
    await writingEngine.getEngineCapabilities();
    assert.equal(fetches, 1, 'the unknown result must be cached too');

    // A non-ok response is also unknown, never a guess.
    writingEngine.__resetEngineCapsCache();
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ image_storage: 'b2' }) });
    assert.deepEqual(await writingEngine.getEngineCapabilities(), { imageStorage: null });
  } finally {
    globalThis.fetch = realFetch;
    writingEngine.__resetEngineCapsCache();
  }
});

// ─── Phase 6: per-user in-flight concurrency cap ────────────
//
// The shadow guard is per DOCUMENT, so one user could hold a run on every
// document they own — N engine sessions, N image budgets, N credit holds —
// with only a per-IP request-RATE limit (which counts starts, not in-flight
// work, and is shared behind a NAT) in the way.

// Seeds the in-flight registry directly — that map IS what the cap counts,
// and holding real runs open would fight the harness's stub save/restore
// (a run that never ends never restores its stubs).
function seedInFlightRuns(userId, n) {
  for (let i = 0; i < n; i++) {
    aiController.activeAgentRuns.set(`held-${userId}-${i}`, {
      sessionId: `s-${i}`, markdownBefore: '', startedAt: Date.now(),
      revertIntent: false, abort: () => {}, runId: `r-${i}`, userId,
    });
  }
}

test('per-user cap: refuses past the limit, and the refusal costs nothing', async () => {
  seedInFlightRuns('u1', 3); // other documents, so the shadow guard isn't what refuses
  try {
    const { res, captured } = await runAgent({
      content: baseContent({ mode: 'draft', activePlanId: null }),
      quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
      body: { goal: 'one more', mode: 'freeform' },
      events: [],
    });
    assert.equal(res.statusCode, 429, 'the 4th concurrent run for one user must be refused');
    assert.equal(res.jsonBody.code, 'TOO_MANY_RUNS');
    assert.equal(captured.preDeduct, null, 'refused before any credit work');
    assert.equal(captured.startAgent, null, 'the engine was never called');
    assert.equal(res.headersSent, false, 'refused before any streaming');
    // The refusal must reserve nothing, or one over-limit attempt would lock
    // that document out until the TTL sweep.
    assert.equal(aiController.activeAgentRuns.size, 3, 'a refused run reserves nothing');
  } finally {
    aiController.activeAgentRuns.clear();
  }
});

test('per-user cap: under the limit runs, and another user is unaffected', async () => {
  seedInFlightRuns('u1', 2); // one below the cap
  try {
    const mine = await runAgent({
      content: baseContent({ mode: 'draft', activePlanId: null }),
      quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
      body: { goal: 'third run', mode: 'freeform' },
      events: [{ type: 'document_diff', patches: [] }],
    });
    assert.equal(mine.res.statusCode, 200, 'the cap is a ceiling, not an off switch');
  } finally {
    aiController.activeAgentRuns.clear();
  }

  seedInFlightRuns('u1', 5); // well past the cap — but for a DIFFERENT user
  try {
    const theirs = await runAgent({
      content: baseContent({ mode: 'draft', activePlanId: null }),
      quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
      body: { goal: 'their run', mode: 'freeform' },
      events: [{ type: 'document_diff', patches: [] }],
      userId: 'someone-else',
    });
    assert.equal(theirs.res.statusCode, 200, 'the cap is per user, not global');
  } finally {
    aiController.activeAgentRuns.clear();
  }
});

// ─── Phase 5: durable image storage pre-flight ──────────────
//
// Without B2 the engine stores generated images in memory: served from its own
// host, gone within the hour. This tier decides, because it also knows whether
// the rescue exists (contentController re-hosts /api/images/ links to the
// backend's bucket on save). Refuse ONLY when neither side is durable.

test('image storage pre-flight: refuse only when neither engine nor backend can store', async () => {
  const savedEnabled = imageStorage.isEnabled;
  const cases = [
    { engine: 'b2', backend: false, refuse: false, why: 'engine storage is durable' },
    { engine: 'memory', backend: true, refuse: false, why: 'the backend re-hosts on save' },
    { engine: 'b2', backend: true, refuse: false, why: 'both durable' },
    { engine: 'memory', backend: false, refuse: true, why: 'every generated image would 404' },
    // A health blip must never look like "not durable" — that would refuse
    // legitimate work over a 1.5s timeout.
    { engine: null, backend: false, refuse: false, why: 'unknown engine state is not a refusal' },
  ];
  try {
    for (const c of cases) {
      imageStorage.isEnabled = () => c.backend;
      const { res, captured } = await runAgent({
        engineCaps: { imageStorage: c.engine },
        content: baseContent({ mode: 'draft', activePlanId: null }),
        quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
        // /image's server whitelist carries the image tools; the disabled list
        // is emptied so the command reaches the storage check.
        body: { goal: 'add pictures', mode: 'sequential', commandName: 'image' },
        events: [{ type: 'document_diff', patches: [] }],
        disabledCommands: [],
      });
      const label = `engine=${c.engine} backend=${c.backend} (${c.why})`;
      if (c.refuse) {
        assert.equal(res.statusCode, 503, `${label} must refuse`);
        assert.equal(res.jsonBody.code, 'IMAGE_STORAGE_UNAVAILABLE', label);
        assert.equal(captured.preDeduct, null, `${label}: refused before any credit work`);
        assert.equal(captured.startAgent, null, `${label}: the engine was never called`);
      } else {
        assert.notEqual(res.statusCode, 503, `${label} must NOT refuse`);
        assert.ok(captured.startAgent, `${label}: the run should have started`);
      }
    }
  } finally {
    imageStorage.isEnabled = savedEnabled;
  }
});

test('image storage pre-flight: a text-only command never consults storage', async () => {
  const savedEnabled = imageStorage.isEnabled;
  imageStorage.isEnabled = () => false;
  try {
    const { res, captured } = await runAgent({
      content: baseContent({ mode: 'draft', activePlanId: null }),
      quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
      body: { goal: 'fix typos', mode: 'sequential', commandName: 'grammar' },
      events: [{ type: 'document_diff', patches: [] }],
      engineCaps: { imageStorage: 'memory' },
    });
    assert.equal(res.statusCode, 200);
    // Counted by the harness, so this stays honest even though the harness
    // owns the stub — a test-local flag would be silently overwritten.
    assert.equal(captured.engineCapsCalls, 0,
      '/grammar cannot produce an image, so it must not pay for a health lookup or be refused by it');
  } finally {
    imageStorage.isEnabled = savedEnabled;
  }
});

// ─── End-to-end mock harness for agent() ────────────────────

function makeSseBody(events, { abortAfterLast = false, onAbort = null, hold = null } = {}) {
  const chunks = events.map((e) => Buffer.from(`data: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i < chunks.length) return { done: false, value: chunks[i++] };
        // `hold` keeps the run registered (the entry is freed only after the
        // stream ends), which is what an in-flight run looks like.
        if (hold) await hold;
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
async function runAgent({ content, quota, events, creditContext, body, abortAfterLast, disabledCommands, holdStream, userId, engineCaps }) {
  // Array, NOT a name-keyed map: mongoose models are all functions, so
  // constructor-name keys collide (UsageTracker/UserUsageTracker both
  // 'Function.getCount') and the first original would never be restored,
  // leaking stubs across the suite (review MINOR-10).
  const saved = [];
  const stub = (obj, key, fn) => { saved.push([obj, key, obj[key]]); obj[key] = fn; };

  const captured = { settle: null, preDeduct: null, stamped: null, incremented: 0, refunded: 0, startAgent: null, engineCapsCalls: 0 };

  // The server-side disabled list the command gate reads. Overridable so a
  // test can drive a command that ships switched off (e.g. /image).
  if (disabledCommands) {
    const real = systemSettings.getSettings();
    stub(systemSettings, 'getSettings', () => ({ ...real, disabledAgentCommands: disabledCommands }));
  }

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
  // Durable-storage pre-flight. Stubbed by DEFAULT because without it an
  // image-capable run makes a REAL fetch to the engine's /health: the suite
  // then passes only because nothing is listening on :8090, and fails on any
  // machine actually running the engine. Override per-test with `engineCaps`.
  stub(writingEngine, 'getEngineCapabilities', async () => {
    captured.engineCapsCalls++;
    return engineCaps || { imageStorage: 'b2' };
  });
  let closeCb = null;
  stub(writingEngine, 'startAgent', async (sessionId, goal, targetScore, maxIterations, signal, allowedTools, mode, preset, imagePass) => {
    // Phase 2/4: the enforced whitelist, canonical mode and image-pass opt-in
    // are what actually reach the engine. Capturing them is how the wiring
    // (not just the pure gate) stays pinned.
    captured.startAgent = { allowedTools, mode, imagePass };
    return { body: makeSseBody(events, { abortAfterLast, onAbort: () => closeCb?.(), hold: holdStream }) };
  });

  const req = {
    params: { workspaceNumber: '1', contentNumber: '1' },
    workspace: { _id: 'w1', organizationId: 'org1' },
    user: { userId: userId || 'u1' },
    body: body || { goal: 'write it', mode: 'freeform' },
    creditContext: { orgId: 'org1', userId: 'u1', workspaceId: 'w1', deductionEnabled: true, featureKey: 'aiAgent', tier: quota.tier, estimatedCredits: 0, ...creditContext },
    on: (ev, cb) => { if (ev === 'close') closeCb = cb; },
  };
  const res = makeRes();
  try {
    await aiController.agent(req, res);
  } finally {
    // Reverse: if a key were ever stubbed twice in one run, forward order
    // would reinstall the stub instead of the original.
    for (let i = saved.length - 1; i >= 0; i--) {
      const [obj, key, orig] = saved[i];
      obj[key] = orig;
    }
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

// ─── Phase 2: server-side command enforcement (WIRING) ──────
//
// agentBilling.test.js covers resolveAgentRun as a pure function. These pin
// the wiring: that aiController actually calls it, refuses before any side
// effect, and forwards the SERVER whitelist + canonical mode to the engine.
// Deleting the gate from the controller leaves the pure-function tests green,
// so without these the enforcement can be removed without failing CI.

test('E2E: a disabled command is refused 403 before any credit or engine work', async () => {
  const { res, captured } = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    // Both /image and /auto-optimize ship disabled; either works here.
    body: { goal: 'optimize it', mode: 'sequential', commandName: 'auto-optimize' },
    events: [],
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.code, 'COMMAND_DISABLED');
  assert.equal(res.headersSent, false, 'refused before any streaming');
  assert.equal(captured.preDeduct, null, 'refused before any credit work');
  assert.equal(captured.startAgent, null, 'the engine was never called');
});

test('E2E: an unknown command is refused 400, and so is a prototype-chain name', async () => {
  for (const commandName of ['tighten-intro', 'constructor']) {
    const { res, captured } = await runAgent({
      content: baseContent({ mode: 'draft', activePlanId: null }),
      quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
      body: { goal: 'do a thing', mode: 'sequential', commandName },
      events: [],
    });
    assert.equal(res.statusCode, 400, `${commandName} must be refused`);
    assert.equal(res.jsonBody.code, 'UNKNOWN_COMMAND');
    assert.equal(captured.startAgent, null, `${commandName} must never reach the engine`);
  }
});

test('E2E: the engine receives the SERVER whitelist, not the body\'s', async () => {
  const { captured } = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    // The underpay shape: a 2-credit command carrying the image toolset.
    body: {
      goal: 'fix typos', mode: 'sequential', commandName: 'grammar',
      allowedTools: ['AskUserTool', 'ImageSearchTool', 'ImageGenTool', 'EditTool'],
    },
    events: [{ type: 'document_diff', patches: [] }],
  });
  assert.deepEqual(captured.startAgent.allowedTools, ['EditTool'],
    'the body\'s tool list must be ignored entirely');
  assert.equal(captured.startAgent.mode, 'sequential');
  // Phase 4: the autonomous image pass is opt-in per command, and no command
  // opts in — so the engine must never be asked for it.
  assert.equal(captured.startAgent.imagePass, false);
});

test('E2E: a non-canonical mode cannot skip the command gate', async () => {
  // "SEQUENTIAL" was billed as a slash command while routing around
  // slash-command enforcement, and the engine's exact-match dispatch then sent
  // it to the freeform agent.
  const { res, captured } = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    body: { goal: 'optimize it', mode: 'SEQUENTIAL', commandName: 'auto-optimize' },
    events: [],
  });
  assert.equal(res.statusCode, 403, 'casing must not dodge the disabled check');
  assert.equal(res.jsonBody.code, 'COMMAND_DISABLED');
  assert.equal(captured.startAgent, null);

  // An unrecognized mode is refused outright rather than silently treated as
  // freeform by one tier and sequential by another.
  const bogus = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    body: { goal: 'x', mode: 'turbo' },
    events: [],
  });
  assert.equal(bogus.res.statusCode, 400);
  assert.equal(bogus.res.jsonBody.code, 'UNKNOWN_MODE');
});

test('E2E: freeform forwards no tools, and the plan write keeps its nil whitelist', async () => {
  const freeform = await runAgent({
    content: baseContent({ mode: 'draft', activePlanId: null }),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    body: { goal: 'rewrite the intro', mode: 'freeform', allowedTools: ['ImageGenTool'] },
    events: [{ type: 'document_diff', patches: [] }],
  });
  assert.equal(freeform.captured.startAgent.allowedTools, undefined,
    'freeform must forward no tools even when the body sends some');
  assert.equal(freeform.captured.startAgent.mode, 'freeform');

  // handleApprovePlan's shape: sequential, no commandName, on a plan awaiting
  // its article. Must pass, and must reach the engine with NO whitelist —
  // engine-nil is the whole-article governance the plan write depends on.
  const planWrite = await runAgent({
    content: baseContent(),
    quota: { tier: 'professional', limit: 50, limitType: 'monthly', used: 1 },
    body: { goal: 'Write the full draft from the approved plan.', mode: 'sequential' },
    creditContext: { estimatedCredits: 100 },
    events: [{ type: 'document_diff', patches: [] }],
  });
  assert.equal(planWrite.res.statusCode, 200, 'the plan-approve write must not be refused');
  assert.equal(planWrite.captured.startAgent.allowedTools, undefined);
  assert.equal(planWrite.captured.startAgent.mode, 'sequential');
});
