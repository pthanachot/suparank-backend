'use strict';

/**
 * Phase 14 — the permanent cross-cutting invariant suite (the v4.1 sign-off
 * guardrail). Consolidates the 8 invariants + the three-table reconciliation +
 * per-tier smokes into ONE place that expresses the v4.1 contract. Detailed
 * cell-by-cell tables live in rbacPolicy/creditCostsTable/configTiersV41 tests;
 * this file asserts the INVARIANTS and the cross-table relationships those tests
 * don't (notably invariant #1's exact action↔permission map).
 *
 * Pure: static config + source scans only. No DB, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { POLICY } = require('../src/middleware/permissions.policy');
const { CREDIT_COSTS, ACTIVE_ACTIONS, FIXED_BUNDLE_ACTIONS } = require('../src/config/creditCosts');
const { resolveCredits, FREE_SAMPLE_POOL_CREDITS, MARKUP_CLASSES } = require('../src/config/creditRules');
const { CREDIT_ACTION_TO_PERMISSION } = require('../src/config/creditActionPermissions');
const { tierToPreset } = require('../src/config/modelPreset');
const { TIERS } = require('../src/scripts/configTiers');

const tier = (k) => TIERS.find((t) => t.tier === k);

// Live (non-roadmap) POLICY actions flagged credit:true.
const LIVE_CREDIT_POLICY_ACTIONS = Object.keys(POLICY).filter((a) => POLICY[a].credit && !POLICY[a].roadmap);
// Roadmap POLICY actions flagged credit:true (gate defined, never billed).
const ROADMAP_CREDIT_POLICY_ACTIONS = Object.keys(POLICY).filter((a) => POLICY[a].credit && POLICY[a].roadmap);
const CASH_POLICY_ACTIONS = Object.keys(POLICY).filter((a) => POLICY[a].cash);

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 1 — every LIVE credit action ↔ EXACTLY ONE permission
// ════════════════════════════════════════════════════════════════════════

test('inv1: the map covers exactly the ACTIVE credit actions (total, no extras)', () => {
  const mapped = Object.keys(CREDIT_ACTION_TO_PERMISSION).sort();
  assert.deepStrictEqual(mapped, [...ACTIVE_ACTIONS].sort(),
    'CREDIT_ACTION_TO_PERMISSION must map exactly the active creditCosts actions');
});

test('inv1: each active action maps to exactly one real, LIVE policy action', () => {
  for (const [action, perm] of Object.entries(CREDIT_ACTION_TO_PERMISSION)) {
    assert.strictEqual(typeof perm, 'string', `${action} → permission must be a single string`);
    assert.ok(POLICY[perm], `${action} → "${perm}" is not a POLICY action`);
    assert.ok(!POLICY[perm].roadmap, `${action} is LIVE but gated by roadmap/inert permission "${perm}"`);
  }
});

test('inv1: the gating permission grants at least the editor role (a "doer" gate)', () => {
  // A credit-spending action must be performable by someone who edits — never a
  // viewer-only permission.
  for (const [action, perm] of Object.entries(CREDIT_ACTION_TO_PERMISSION)) {
    const roles = POLICY[perm].roles;
    assert.ok(roles.owner || roles.admin || roles.editor, `${action} gate "${perm}" grants no doer role`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// THREE-TABLE RECONCILIATION (Table 2 creditCosts ↔ Table 3 policy)
// ════════════════════════════════════════════════════════════════════════

test('reconcile: every LIVE credit:true policy action is an actual gate (no orphan gate)', () => {
  const usedGates = new Set(Object.values(CREDIT_ACTION_TO_PERMISSION));
  for (const perm of LIVE_CREDIT_POLICY_ACTIONS) {
    assert.ok(usedGates.has(perm), `policy credit action "${perm}" gates no active credit cost (orphan)`);
  }
});

test('reconcile: every active action markupClass exists in creditRules.MARKUP_CLASSES', () => {
  for (const action of ACTIVE_ACTIONS) {
    const cls = CREDIT_COSTS[action].markupClass;
    assert.ok(MARKUP_CLASSES[cls], `${action} references unknown markupClass "${cls}"`);
  }
});

test('reconcile: route wiring grounds the map for every direct-rc action', () => {
  // For actions whose route uses rc('<creditCostsKey>', …) directly (not via an
  // estimator that re-resolves the key), the requirePermission on that same route
  // line must match the map — proving the map reflects real enforcement, not intent.
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const src = ['workspaceRoutes.js', 'keywordRoutes.js', 'brandVoiceRoutes.js', 'aiTrackerRoutes.js']
    .map((f) => fs.readFileSync(path.join(routesDir, f), 'utf8'))
    .join('\n');
  const lines = src.split('\n').filter((l) => !l.trim().startsWith('//'));

  const DIRECT = ['reScore', 'importUrl', 'internalLinks', 'briefOutline', 'imageGenerate',
    'contentAudit', 'keywordLookup', 'promptResearch', 'trackerRefreshSingle', 'brandVoiceTest', 'avatarTest'];
  for (const action of DIRECT) {
    const perm = CREDIT_ACTION_TO_PERMISSION[action];
    const line = lines.find((l) => l.includes(`rc('${action}'`));
    assert.ok(line, `no direct rc('${action}') route line found`);
    assert.ok(line.includes(`requirePermission('${perm}')`),
      `route for ${action} does not gate with the mapped permission "${perm}"`);
  }
});

// ─── Cost reachability: every ACTIVE action is actually charged somewhere ───
// inv1 forces the map to cover ACTIVE_ACTIONS, and the route-grounding test above
// proves the DIRECT-rc actions enforce their mapped permission. Neither proves an
// active cost is REACHABLE — an action can be active:true, mapped, and yet billed
// by no code path (a permanent revenue leak the suite would otherwise certify
// green). This scans the backend source for each active action's literal at a
// charge site and asserts the set of UNREACHABLE active actions is EXACTLY the
// documented allow-list. Self-correcting: wiring fullDocRewrite (or orphaning a
// new action) breaks this until KNOWN_UNWIRED is updated.
//
// KNOWN_UNWIRED — active:true in Table 2 but intentionally charged by no route.
//   EMPTY by design: the one prior entry, fullDocRewrite, was resolved to
//   active:false (deferred — the /rewrite full-regenerate action is unshipped;
//   full-doc rewrites bill fullDocPass/articleGenerate). So EVERY active action
//   must now be charged at a real code site — no orphan costs. If a future action
//   is added active:true without a charge site, this test fails until it is either
//   wired or added here with a written justification.
const KNOWN_UNWIRED = new Set([]);

test('inv-reach: every active action is charged at a real code site (orphan-cost guard)', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  // Files that DEFINE actions (not charge them) — excluded so a literal there
  // does not count as a charge site.
  const DEFINITION_FILES = new Set(['creditCosts.js', 'creditActionPermissions.js']);

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js') && !DEFINITION_FILES.has(entry.name)) files.push(full);
    }
  })(srcDir);
  const corpus = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const unreachable = ACTIVE_ACTIONS.filter(
    (a) => !corpus.includes(`'${a}'`) && !corpus.includes(`"${a}"`),
  ).sort();
  assert.deepStrictEqual(unreachable, [...KNOWN_UNWIRED].sort(),
    `orphan-cost drift: active actions charged nowhere = ${JSON.stringify(unreachable)}, ` +
    `expected exactly the KNOWN_UNWIRED allow-list ${JSON.stringify([...KNOWN_UNWIRED])}`);
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 2 — every CASH action is Owner-only
// ════════════════════════════════════════════════════════════════════════

test('inv2: every cash action grants ONLY owner', () => {
  assert.ok(CASH_POLICY_ACTIONS.length >= 4, 'expected the 4 known cash actions');
  for (const action of CASH_POLICY_ACTIONS) {
    assert.deepStrictEqual(POLICY[action].roles,
      { owner: true, admin: false, editor: false, viewer: false, client: false },
      `cash action "${action}" must be owner-only`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 3 — no privilege escalation (monotonicity: admin ≥ editor ≥ viewer ≥ client)
// ════════════════════════════════════════════════════════════════════════

test('inv3: role capability is monotonic (a lower role never exceeds a higher one)', () => {
  for (const [action, entry] of Object.entries(POLICY)) {
    const { admin, editor, viewer, client } = entry.roles;
    // editorOptIn actions are Admin-default with an explicit per-workspace grant
    // to a single editor; the static table still keeps editor ≤ admin.
    assert.ok(!editor || admin, `${action}: editor set but admin unset`);
    assert.ok(!viewer || editor, `${action}: viewer set but editor unset`);
    assert.ok(!client || viewer, `${action}: client set but viewer unset`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 4 — deducted credits == creditCosts.js (via the runtime resolver)
// ════════════════════════════════════════════════════════════════════════

test('inv4: resolveCredits(paid) equals the creditCosts base for every active action', () => {
  const paid = { tier: 'standard' };
  for (const action of ACTIVE_ACTIONS) {
    const spec = CREDIT_COSTS[action];
    const expected = typeof spec.variable === 'function' ? spec.variable(paid) : spec.credits; // units default 1
    assert.strictEqual(resolveCredits(action, paid), expected, `${action} deducted cost drift`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 5 — Free = fixed zero-credit bundles + one-time 200-credit sample
// ════════════════════════════════════════════════════════════════════════

test('inv5: Free fixed-bundle actions resolve to 0 credits (Option B)', () => {
  assert.deepStrictEqual([...FIXED_BUNDLE_ACTIONS].sort(), ['articleGenerate', 'contentAudit', 'keywordLookup']);
  for (const action of FIXED_BUNDLE_ACTIONS) {
    assert.strictEqual(resolveCredits(action, { tier: 'free' }), 0, `${action} must be 0 for Free`);
    // …but the SAME action costs the full amount on a paid tier.
    assert.ok(resolveCredits(action, { tier: 'standard' }) > 0, `${action} must be > 0 for paid`);
  }
});

test('inv5: the one-time Free sample pool is 200 credits, and Free has no monthly pool', () => {
  assert.strictEqual(FREE_SAMPLE_POOL_CREDITS, 200);
  assert.strictEqual(tier('free').creditsPerMonth, 0, 'Free must have no recurring credit pool');
});

test('inv5: Free count-gated bundles use lifetime limit types', () => {
  const free = tier('free');
  assert.strictEqual(free.articleLimitType, 'lifetime');
  assert.strictEqual(free.keywordLimitType, 'lifetime');
  assert.strictEqual(free.auditLimitType, 'lifetime');
  assert.strictEqual(free.aiTrackerPromptLimitType, 'lifetime');
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 6 — caps are ceilings; the credit pool is a separate meter
// ════════════════════════════════════════════════════════════════════════

test('inv6: every tier carries entitlement caps AND a separate credit pool', () => {
  for (const t of TIERS) {
    assert.strictEqual(typeof t.creditsPerMonth, 'number', `${t.tier} creditsPerMonth`);
    // caps are number (finite ceiling) or null (unlimited) — never undefined.
    for (const cap of ['maxArticlesPerMonth', 'maxKeywordLookupsPerMonth', 'maxAuditsPerMonth', 'maxAiTrackerPromptsPerMonth']) {
      const v = t[cap];
      assert.ok(v === null || typeof v === 'number', `${t.tier}.${cap} must be number|null`);
    }
    // paid tiers fund à-la-carte via a recurring pool; Free does not.
    if (t.tier !== 'free') assert.ok(t.creditsPerMonth > 0, `${t.tier} must have a recurring pool`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 7 — model choice is tier-aware (Free budget / paid base)
// ════════════════════════════════════════════════════════════════════════

test('inv7: Free → budget preset, every paid tier → base preset', () => {
  assert.strictEqual(tierToPreset('free'), 'budget');
  for (const t of ['standard', 'professional', 'agency']) {
    assert.strictEqual(tierToPreset(t), '', `${t} must use the base model preset`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 8 — no credit cost is LIVE for a non-existent (roadmap) feature
// ════════════════════════════════════════════════════════════════════════

test('inv8: inactive (roadmap/unbuilt) actions are never billable — resolveCredits throws', () => {
  const inactive = Object.keys(CREDIT_COSTS).filter((a) => !CREDIT_COSTS[a].active);
  assert.ok(inactive.length > 0, 'expected some roadmap/inactive actions');
  for (const action of inactive) {
    assert.throws(() => resolveCredits(action, { tier: 'standard' }), /not active/, `${action} must not be billable`);
  }
});

test('inv8: roadmap credit policy gates map to NO active cost (inert)', () => {
  const usedGates = new Set(Object.values(CREDIT_ACTION_TO_PERMISSION));
  for (const perm of ROADMAP_CREDIT_POLICY_ACTIONS) {
    assert.ok(!usedGates.has(perm), `roadmap gate "${perm}" is wired to an active credit cost`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// PER-TIER SMOKE — each tier resolves to its Table-1 entitlements end-to-end
// ════════════════════════════════════════════════════════════════════════

test('per-tier smoke: tier config + preset + representative cost line up', () => {
  const expected = {
    free: { creditsPerMonth: 0, maxArticlesPerMonth: 3, supportTier: 'docs', preset: 'budget' },
    standard: { creditsPerMonth: 3000, maxArticlesPerMonth: 20, supportTier: 'email24h', preset: '' },
    professional: { creditsPerMonth: 10000, maxArticlesPerMonth: 50, supportTier: 'priority12h', preset: '' },
    agency: { creditsPerMonth: 30000, maxArticlesPerMonth: 300, supportTier: 'slack', preset: '' },
  };
  for (const [name, exp] of Object.entries(expected)) {
    const cfg = tier(name);
    assert.ok(cfg, `missing tier ${name}`);
    assert.strictEqual(cfg.creditsPerMonth, exp.creditsPerMonth, `${name} creditsPerMonth`);
    assert.strictEqual(cfg.maxArticlesPerMonth, exp.maxArticlesPerMonth, `${name} maxArticlesPerMonth`);
    assert.strictEqual(cfg.supportTier, exp.supportTier, `${name} supportTier`);
    assert.strictEqual(tierToPreset(name), exp.preset, `${name} preset`);
    // an article costs 0 on Free (bundle) and 100 on paid.
    assert.strictEqual(resolveCredits('articleGenerate', { tier: name }), name === 'free' ? 0 : 100, `${name} article cost`);
  }
});
