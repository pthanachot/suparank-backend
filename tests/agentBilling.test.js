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

const {
  COMMAND_BILLING, COMMAND_TOOLS, COMMAND_IMAGE_PASS, DEFAULT_DISABLED_AGENT_COMMANDS,
  classifyAgentRun, resolveAgentRun, canonicalMode,
} = require('../src/config/agentBilling');
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
    const toolsMatches = [...chunk.matchAll(/allowedTools:\s*\[([^\]]*)\]/g)];
    entries.push({
      name: m[1],
      hasAgentGoal: /agentGoal:/.test(chunk),
      hasAction: /\baction:\s*"/.test(chunk),
      isChatMode: /chatMode:\s*true/.test(chunk),
      toolsCount: toolsMatches.length,
      allowedTools: toolsMatches[0]
        ? toolsMatches[0][1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? []
        : null,
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

  // Phase 2: per-command tool-whitelist parity. The backend OVERWRITES the
  // request's allowedTools from COMMAND_TOOLS, so a drifted mirror silently
  // changes what a command can do — parity is a hard requirement.
  for (const e of agentInvoking) {
    // Chunker sanity: the naive name→name slicing corrupts silently if a
    // prompt ever contains `name: "` or a second allowedTools — fail loudly.
    assert.equal(e.toolsCount, 1,
      `${e.name}: expected exactly one allowedTools in its registry chunk, found ${e.toolsCount} (chunk parser corrupted?)`);
    assert.deepEqual(COMMAND_TOOLS[e.name], e.allowedTools,
      `${e.name}: backend COMMAND_TOOLS drifted from the frontend registry`);
  }
  // No zombie tool entries either.
  const toolZombies = Object.keys(COMMAND_TOOLS).filter((c) => !registryNames.has(c));
  assert.deepEqual(toolZombies, [], `COMMAND_TOOLS entries with no registry command: ${toolZombies.join(', ')}`);

  // Phase 2: the server-side disabled default mirrors the frontend's compiled
  // default (NEXT_PUBLIC_DISABLED_COMMANDS fallback literal).
  // Anchored on the .split( that follows, so it matches the CODE and not a
  // doc comment quoting the same expression (which it did, silently reading
  // the ellipsis in prose as the default list).
  const feDefault = src.match(
    /process\.env\.NEXT_PUBLIC_DISABLED_COMMANDS \?\? "([^"]+)"\)\s*\n\s*\.split\(/
  );
  assert.ok(feDefault, 'found the frontend disabled-commands default literal');
  assert.deepEqual([...DEFAULT_DISABLED_AGENT_COMMANDS], feDefault[1].split(','),
    'DEFAULT_DISABLED_AGENT_COMMANDS drifted from the frontend registry default');
});

// ─── Phase 2: resolveAgentRun (server-side run gate) ────────

const planWriteContent = { mode: 'execute', activePlanId: 'p1', articleGeneratedPlanId: null };

test('resolveAgentRun: freeform never forwards tools, whatever the body claims', () => {
  const gate = resolveAgentRun(
    { mode: 'freeform', allowedTools: ['ImageGenTool', 'WriteTool'] }, null, []);
  assert.equal(gate.ok, true);
  assert.equal(gate.allowedTools, undefined);
});

test('resolveAgentRun: known command gets the SERVER whitelist — the body list is ignored', () => {
  // The underpay shape: cheap commandName + expensive tools in the body.
  const gate = resolveAgentRun(
    { mode: 'sequential', commandName: 'grammar', allowedTools: ['AskUserTool', 'ImageSearchTool', 'ImageGenTool', 'EditTool'] },
    null, []);
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.allowedTools, ['EditTool']);
});

test('resolveAgentRun: unknown sequential commandName is refused 400', () => {
  const gate = resolveAgentRun({ mode: 'sequential', commandName: 'spoofed-cmd' }, null, []);
  assert.deepEqual([gate.ok, gate.status, gate.code], [false, 400, 'UNKNOWN_COMMAND']);
});

test('resolveAgentRun: a disabled command is refused 403, an enabled one is not', () => {
  const off = resolveAgentRun({ mode: 'sequential', commandName: 'image' }, null);
  assert.deepEqual([off.ok, off.status, off.code], [false, 403, 'COMMAND_DISABLED']);

  const on = resolveAgentRun({ mode: 'sequential', commandName: 'grammar' }, null);
  assert.equal(on.ok, true);
  assert.deepEqual(on.allowedTools, ['EditTool']);

  // Admin-ENABLED at runtime: /image runs with its exact registry whitelist
  // and no deploy. This is the switch that turns the command on once its
  // price and IMAGE_BUDGET_PER_RUN agree.
  const enabled = resolveAgentRun({ mode: 'sequential', commandName: 'image' }, null, []);
  assert.equal(enabled.ok, true);
  assert.deepEqual(enabled.allowedTools, ['AskUserTool', 'ImageSearchTool', 'ImageGenTool', 'EditTool']);
  assert.equal(enabled.imagePass, false, 'enabling the command must not enable the autonomous pass');
});

test('resolveAgentRun: no-command sequential is legal ONLY for the plan-approve write', () => {
  // The handleApprovePlan shape: sequential, no commandName, no allowedTools.
  const planWrite = resolveAgentRun({ mode: 'sequential' }, planWriteContent, []);
  assert.equal(planWrite.ok, true);
  assert.equal(planWrite.allowedTools, undefined); // engine-nil = whole-article governance

  // Same body without the server-side plan state: crafted request, refused.
  const crafted = resolveAgentRun({ mode: 'sequential' }, { mode: 'draft' }, []);
  assert.deepEqual([crafted.ok, crafted.status, crafted.code], [false, 400, 'UNKNOWN_COMMAND']);

  // A plan that already produced its article no longer opens the door.
  const spent = resolveAgentRun({ mode: 'sequential' },
    { mode: 'execute', activePlanId: 'p1', articleGeneratedPlanId: 'p1' }, []);
  assert.equal(spent.ok, false);
});

// commandName is caller-controlled and reaches the gate verbatim through the
// Next proxy. A bare TABLE[name] lookup resolves Object.prototype keys, and a
// bare .includes() compares non-strings by identity. Left open, these are the
// exact bypass this gate exists to close:
//   "constructor"  → whitelist = the Object function → JSON.stringify drops it
//                    → engine sees NO whitelist = unrestricted whole-article
//                    governance, while the billing classifier throws and the
//                    credit gate fails open (free run, no article slot).
//   ["image"]      → coerces to "image" on lookup, but !== "image" in the
//                    disabled list → walks through the 403 with ImageGenTool.
// resolveAgentRun and classifyAgentRun derive OPPOSITE defaults from `mode`
// ("not sequential ⇒ freeform" vs "not freeform ⇒ command"), so any value that
// is neither literal landed in the lenient half of both: billed as a slash
// command while skipping slash-command enforcement, then dispatched by the
// engine's exact-match comparison to the freeform agent.
test('canonicalMode: one reading of mode across both consumers', () => {
  assert.equal(canonicalMode(undefined), 'freeform');
  assert.equal(canonicalMode(null), 'freeform');
  assert.equal(canonicalMode(''), 'freeform');
  assert.equal(canonicalMode('freeform'), 'freeform');
  assert.equal(canonicalMode('sequential'), 'sequential');
  assert.equal(canonicalMode(' SEQUENTIAL '), 'sequential', 'casing/whitespace normalize, not divert');
  assert.equal(canonicalMode('Freeform'), 'freeform');
  assert.equal(canonicalMode('turbo'), null);
  assert.equal(canonicalMode(['sequential']), null);
  assert.equal(canonicalMode(7), null);
});

test('resolveAgentRun: a non-canonical mode cannot skip the command gate', () => {
  // Previously: "SEQUENTIAL" → gate said freeform (ok, no checks) while the
  // biller said sequential (command pricing).
  for (const mode of ['SEQUENTIAL', 'Sequential', ' sequential ']) {
    const gate = resolveAgentRun({ mode, commandName: 'auto-optimize' }, null);
    assert.equal(gate.ok, false, `${JSON.stringify(mode)} must still hit the disabled check`);
    assert.equal(gate.code, 'COMMAND_DISABLED');
  }
  // An unrecognized mode is refused rather than routed to a lenient default.
  const bogus = resolveAgentRun({ mode: 'turbo', commandName: 'grammar' }, null, []);
  assert.deepEqual([bogus.ok, bogus.status, bogus.code], [false, 400, 'UNKNOWN_MODE']);
  // And the two consumers now agree on what the run IS.
  assert.equal(resolveAgentRun({ mode: 'SEQUENTIAL', commandName: 'grammar' }, null, []).mode, 'sequential');
  assert.equal(classifyAgentRun({ mode: 'SEQUENTIAL', commandName: 'grammar' }), 'inlineAction');
});

test('resolveAgentRun: returns a COPY of the whitelist, not the live registry array', () => {
  const gate = resolveAgentRun({ mode: 'sequential', commandName: 'grammar' }, null, []);
  gate.allowedTools.push('ImageGenTool');
  assert.deepEqual(COMMAND_TOOLS.grammar, ['EditTool'], 'the server registry must be unmutated');
});

test('resolveAgentRun: prototype-chain commandNames are NOT commands', () => {
  for (const evil of ['constructor', 'hasOwnProperty', 'toString', 'valueOf', '__proto__', 'isPrototypeOf']) {
    const gate = resolveAgentRun({ mode: 'sequential', commandName: evil }, null, []);
    assert.equal(gate.ok, false, `${evil} must not resolve as a command`);
    assert.equal(gate.status, 400, `${evil} must be refused 400, got ${gate.status}`);
  }
});

test('classifyAgentRun: prototype-chain commandNames price as articleGenerate, never a function', () => {
  for (const evil of ['constructor', 'toString', '__proto__']) {
    const action = classifyAgentRun({ mode: 'sequential', commandName: evil });
    assert.equal(typeof action, 'string', `${evil} must classify to a string action`);
    assert.equal(action, 'articleGenerate');
    // The estimator must not throw — a throw here disables credit deduction.
    assert.doesNotThrow(() => resolveCredits(action, { tier: 'professional' }));
  }
});

test('resolveAgentRun: non-string commandName cannot dodge the disabled check', () => {
  for (const evil of [['image'], { toString: () => 'image' }, 0, true]) {
    const gate = resolveAgentRun({ mode: 'sequential', commandName: evil }, null);
    assert.equal(gate.ok, false, `${JSON.stringify(evil)} must be refused`);
    assert.equal(gate.status, 400);
  }
});

// The autonomous post-agent image pass is a SECOND image pipeline (its own
// section picker, its own style, no per-image accept). It used to be inferred
// from the tool whitelist, which selected /image — the one command that
// already asks the user which sections and which style and generates the
// images itself. It is now opt-in per command, and nothing opts in.
test('resolveAgentRun: no command requests the post-agent image pass', () => {
  assert.equal(COMMAND_IMAGE_PASS.size, 0,
    'a command opting into auto-illustration is a deliberate act — document why here');

  // Survives deleting the size assertion above: a typo'd name would never
  // match COMMAND_IMAGE_PASS.has(name), so the command would silently run
  // without the pass it was meant to opt into — no 400, no warning, no log.
  for (const name of COMMAND_IMAGE_PASS) {
    assert.ok(Object.prototype.hasOwnProperty.call(COMMAND_TOOLS, name),
      `COMMAND_IMAGE_PASS has "${name}", which is not a known command — it would never match`);
  }

  for (const name of Object.keys(COMMAND_TOOLS)) {
    const gate = resolveAgentRun({ mode: 'sequential', commandName: name }, null, []);
    assert.equal(gate.imagePass, false, `/${name} must not request the image pass`);
  }
  // Including the command that holds the image tools: having them is not a
  // request to be auto-illustrated on top of its own work.
  const img = resolveAgentRun({ mode: 'sequential', commandName: 'image' }, null, []);
  assert.deepEqual(img.allowedTools, ['AskUserTool', 'ImageSearchTool', 'ImageGenTool', 'EditTool']);
  assert.equal(img.imagePass, false);
});

test('resolveAgentRun: plan-write billing is preserved (still articleGenerate)', () => {
  // The gate must not reprice the approve path — classifyAgentRun is untouched.
  assert.equal(classifyAgentRun({ mode: 'sequential' }, planWriteContent), 'articleGenerate');
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
