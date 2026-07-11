/**
 * Phase 6 (money#1) — agent-run billing classification + article count-gate.
 *
 * AT-1 (PRIMARY): the honest write path — auto-write intent / unknown command —
 * classifies articleGenerate and HARD-BLOCKS past the article allowance,
 * regardless of credit balance. AT-2 (backstop): spoofing down lands on finite
 * pools; unknown commands land on the expensive, count-gated action.
 *
 * Conformance: every agent-invoking slash command in the frontend registry MUST
 * have a billing classification — this test parses registry.ts from the monorepo
 * and fails CI when a new command ships unclassified.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { COMMAND_BILLING, classifyAgentRun } = require('../src/config/agentBilling');
const { CREDIT_COSTS } = require('../src/config/creditCosts');
const { resolveCredits } = require('../src/config/creditRules');
const tierService = require('../src/services/tierService');
const UsageTracker = require('../src/models/UsageTracker');
const UserUsageTracker = require('../src/models/UserUsageTracker');
const aiController = require('../src/controllers/aiController');

// ─── Classification ─────────────────────────────────────────

test('AT-1a: honest write paths classify articleGenerate', () => {
  assert.equal(classifyAgentRun({ mode: 'freeform', intent: 'auto-write' }), 'articleGenerate');
  assert.equal(classifyAgentRun({ intent: 'auto-write' }), 'articleGenerate'); // mode defaults freeform
  // Default-to-expensive: sequential without/with unknown command
  assert.equal(classifyAgentRun({ mode: 'sequential' }), 'articleGenerate');
  assert.equal(classifyAgentRun({ mode: 'sequential', commandName: 'tighten-intro' }), 'articleGenerate');
});

test('known slash commands classify as their mapped edit-pass action', () => {
  assert.equal(classifyAgentRun({ mode: 'sequential', commandName: 'auto-optimize' }), 'fullDocPass');
  assert.equal(classifyAgentRun({ mode: 'sequential', commandName: 'grammar' }), 'inlineAction');
  assert.equal(classifyAgentRun({ mode: 'sequential', commandName: 'image' }), 'imageGenerate');
});

test('plain freeform (chat-style) classifies inlineAction', () => {
  assert.equal(classifyAgentRun({ mode: 'freeform' }), 'inlineAction');
  assert.equal(classifyAgentRun({}), 'inlineAction');
});

test('every COMMAND_BILLING value is a valid ACTIVE creditCosts action', () => {
  for (const [cmd, action] of Object.entries(COMMAND_BILLING)) {
    assert.ok(CREDIT_COSTS[action], `${cmd} → ${action} exists`);
    assert.equal(CREDIT_COSTS[action].active, true, `${cmd} → ${action} is active`);
    assert.doesNotThrow(() => resolveCredits(action, { tier: 'professional' }));
  }
});

// ─── Registry conformance (anti-drift CI guard) ─────────────

test('CONFORMANCE: every agent-invoking slash command in the frontend registry is classified', () => {
  const registryPath = path.resolve(
    __dirname, '../../suparank/components/editor/commands/registry.ts'
  );
  const src = fs.readFileSync(registryPath, 'utf8');

  // Parse command objects: capture name + whether the entry has agentGoal /
  // action / chatMode. Object entries are `{ name: "x", ... }` at one level.
  const entries = [];
  const nameRe = /name:\s*"([^"]+)"/g;
  let m;
  while ((m = nameRe.exec(src)) !== null) {
    // Slice this entry: from the name to the next `name:` (or EOF).
    const start = m.index;
    const next = src.indexOf('name: "', nameRe.lastIndex);
    const chunk = src.slice(start, next === -1 ? src.length : next);
    entries.push({
      name: m[1],
      hasAgentGoal: /agentGoal:/.test(chunk),
      hasAction: /\baction:\s*"/.test(chunk),
      isChatMode: /chatMode:\s*true/.test(chunk),
    });
  }
  assert.ok(entries.length >= 10, `registry parse sanity (found ${entries.length} commands)`);

  const agentInvoking = entries.filter((e) => e.hasAgentGoal && !e.hasAction && !e.isChatMode);
  assert.ok(agentInvoking.length >= 5, 'found agent-invoking commands');

  const unclassified = agentInvoking.filter((e) => !COMMAND_BILLING[e.name]).map((e) => e.name);
  assert.deepEqual(unclassified, [],
    `New slash command(s) shipped without a billing classification in ` +
    `backend/src/config/agentBilling.js: ${unclassified.join(', ')}. ` +
    `Add each to COMMAND_BILLING (falls back to articleGenerate=100+count-gate at runtime).`);

  // And no zombie entries: everything classified still exists in the registry
  // (or is intentionally absent — keep the map honest).
  const registryNames = new Set(entries.map((e) => e.name));
  const zombies = Object.keys(COMMAND_BILLING).filter((c) => !registryNames.has(c));
  assert.deepEqual(zombies, [], `COMMAND_BILLING entries with no registry command: ${zombies.join(', ')}`);
});

// ─── AT-1: article count-gate (mocked models) ───────────────

function mockQuota({ tier, limit, limitType, used }) {
  const saved = {
    tier: tierService.getOrgTierConfig,
    org: UsageTracker.getCount,
    user: UserUsageTracker.getCount,
  };
  tierService.getOrgTierConfig = async () => ({
    tier, config: { maxArticlesPerMonth: limit, articleLimitType: limitType },
  });
  UsageTracker.getCount = async () => used;
  UserUsageTracker.getCount = async () => used;
  return () => {
    tierService.getOrgTierConfig = saved.tier;
    UsageTracker.getCount = saved.org;
    UserUsageTracker.getCount = saved.user;
  };
}

const reqStub = { creditContext: { orgId: 'org1' }, user: { userId: 'u1' } };

test('AT-1b: Free re-generation at the 3-lifetime limit hard-blocks with friendly copy', async () => {
  const restore = mockQuota({ tier: 'free', limit: 3, limitType: 'lifetime', used: 3 });
  try {
    const gate = await aiController.checkArticleAllowance(reqStub, { articleGeneratedAt: new Date() });
    assert.equal(gate.blocked, true);
    assert.equal(gate.payload.code, 'ARTICLE_LIMIT_REACHED');
    assert.match(gate.payload.error, /free plan/i);
    assert.match(gate.payload.error, /upgrade/i);        // links the conversion moment
    assert.equal(gate.payload.upgradeUrl, '/pricing');
    assert.deepEqual(gate.payload.quota.used, 3);
  } finally { restore(); }
});

test('AT-1c: Free re-generation under the limit is allowed and counts on commit', async () => {
  const restore = mockQuota({ tier: 'free', limit: 3, limitType: 'lifetime', used: 2 });
  try {
    const gate = await aiController.checkArticleAllowance(reqStub, { articleGeneratedAt: new Date() });
    assert.equal(gate.blocked, false);
    assert.equal(gate.isFirstGen, false);
    assert.equal(gate.quotaCtx.isUserLevel, true); // lifetime → user-level counter
    assert.equal(gate.quotaCtx.counterKey, 'articlesCreated');
  } finally { restore(); }
});

test('AT-1d: FIRST generation on a doc never blocks and never checks the counter', async () => {
  const restore = mockQuota({ tier: 'free', limit: 3, limitType: 'lifetime', used: 999 });
  try {
    const gate = await aiController.checkArticleAllowance(reqStub, { articleGeneratedAt: null });
    assert.equal(gate.blocked, false);
    assert.equal(gate.isFirstGen, true); // creation already counted this doc
  } finally { restore(); }
});

test('AT-1e: paid monthly limit blocks with reset-cycle copy (counts silently, no Free warning)', async () => {
  const restore = mockQuota({ tier: 'professional', limit: 50, limitType: 'monthly', used: 50 });
  try {
    const gate = await aiController.checkArticleAllowance(reqStub, { articleGeneratedAt: new Date() });
    assert.equal(gate.blocked, true);
    assert.match(gate.payload.error, /resets next billing cycle/i);
    assert.equal(gate.payload.quota.limitType, 'monthly');
  } finally { restore(); }
});

// ─── AT-2: spoof backstop (pricing only — bounded, not free) ─

test('AT-2: spoofing down lands on finite-pool pricing; unknown lands on the gated action', () => {
  // Spoofed edit-command: pays 25 from Free's finite 200 sample pool → ≤8 runs lifetime.
  assert.equal(resolveCredits(classifyAgentRun({ mode: 'sequential', commandName: 'humanize' }),
    { tier: 'free' }), 25);
  // Unknown command: articleGenerate → Free 0-credit BUT count-gated (AT-1), paid 100.
  const unknown = classifyAgentRun({ mode: 'sequential', commandName: 'spoofed-cmd' });
  assert.equal(unknown, 'articleGenerate');
  assert.equal(resolveCredits(unknown, { tier: 'professional' }), 100);
});
