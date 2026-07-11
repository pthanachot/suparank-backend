/**
 * Phase 2 (v4.1 plan) — RBAC policy table + CI guard.
 *
 * Proves:
 *  A. The policy table compiles and satisfies its structural invariants
 *     (every action fully specified; monotonicity; cash ⟹ owner-only).
 *  B. can() matches Table 3 at representative cells, and fails closed on
 *     unknown actions/roles.
 *  C. The CI guard flags a deliberately UN-GATED credit/cash route and
 *     passes a properly gated one.
 *
 * No DB, no network — the policy is pure code.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLES,
  POLICY,
  can,
  CREDIT_CASH_ACTIONS,
  mustBeGated,
  scanSourceForGate,
} = require('../src/middleware/permissions.policy');

// ═══════════════════════════════════════════════════════════════════════
// A. Structural invariants — the policy table is well-formed
// ═══════════════════════════════════════════════════════════════════════

test('every action fully specifies all 5 roles as booleans + a resource', () => {
  for (const [action, entry] of Object.entries(POLICY)) {
    assert.ok(entry.resource, `${action}: missing resource`);
    for (const role of ROLES) {
      assert.equal(typeof entry.roles[role], 'boolean', `${action}.${role} must be boolean`);
    }
  }
});

test('monotonicity: client ⟹ viewer ⟹ editor ⟹ admin, for every action', () => {
  for (const [action, { roles }] of Object.entries(POLICY)) {
    if (roles.client) assert.ok(roles.viewer, `${action}: client but not viewer`);
    if (roles.viewer) assert.ok(roles.editor, `${action}: viewer but not editor`);
    if (roles.editor) assert.ok(roles.admin, `${action}: editor but not admin`);
  }
});

test('owner can do everything except ownerNA actions', () => {
  for (const [action, entry] of Object.entries(POLICY)) {
    if (entry.ownerNA) {
      assert.equal(entry.roles.owner, false, `${action}: ownerNA but owner=true`);
    } else {
      assert.equal(entry.roles.owner, true, `${action}: owner should be able (or set ownerNA)`);
    }
  }
});

test('INVARIANT: every cash action is Owner-only', () => {
  const cash = Object.entries(POLICY).filter(([, e]) => e.cash);
  assert.ok(cash.length >= 4, 'expected the known cash actions');
  for (const [action, { roles }] of cash) {
    assert.equal(roles.owner, true, `${action}: cash but owner=false`);
    for (const role of ['admin', 'editor', 'viewer', 'client']) {
      assert.equal(roles[role], false, `${action}: cash action allows ${role}`);
    }
  }
});

test('the four known cash actions are present and owner-only', () => {
  for (const a of ['billing.manage', 'members.addPaidSeat', 'workspace.createBeyondPlan', 'tracker.buyPromptPack']) {
    assert.ok(POLICY[a], `missing cash action ${a}`);
    assert.equal(POLICY[a].cash, true, `${a} should be cash`);
  }
});

test('credit actions cover the real AI spenders', () => {
  for (const a of ['ai.generate', 'ai.audit', 'keywords.search', 'brandVoice.manage', 'tracker.refreshOne', 'tracker.refreshAll']) {
    assert.equal(POLICY[a]?.credit, true, `${a} should be a credit action`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// A2. FULL cell pin — every action's role vector, SPEC-ORACLE.
//     Catches any single flipped flag anywhere in the table (the spot-checks
//     in section B only cover ~15 of 225 cells). Letters = roles that are TRUE:
//     O=owner A=admin E=editor V=viewer C=client (client = restricted viewer).
//
//     CRITICAL: this map is transcribed DIRECTLY from GEO-PRICING-v4.md Table 3
//     (the SSOT), NOT copied from POLICY. If a cell here disagrees with POLICY,
//     the DEFAULT assumption is that POLICY is wrong — fix the policy, not this
//     fixture. Only edit a cell here when Table 3 itself changes, and cite the
//     spec line. (This test exists precisely because a mirror-of-policy fixture
//     silently passed while keywords.deleteHistory was mis-set to OAE.)
// ═══════════════════════════════════════════════════════════════════════

const EXPECTED = {
  'workspace.create': 'OA',
  'workspace.createBeyondPlan': 'O',
  'workspace.settings': 'OA',
  'workspace.delete': 'O',
  'workspace.creditSubLimits': 'OA',
  'workspace.allocatePooledSlots': 'OA',
  'members.view': 'OAE',
  'members.invite': 'OA',
  'members.addPaidSeat': 'O',
  'members.changeRole': 'OA',
  'content.view': 'OAEVC',
  'content.edit': 'OAE',
  'content.comment': 'OAEVC',
  'content.trash': 'OAE',
  'content.permanentDelete': 'OA',
  'content.restoreVersion': 'OAE',
  'ai.generate': 'OAE',
  'ai.audit': 'OAE',
  'ai.viewResults': 'OAEVC',
  'brandVoice.manage': 'OA',
  'brandVoice.use': 'OAE',
  'tracker.view': 'OAEVC',
  'tracker.managePrompts': 'OAE',
  'tracker.refreshOne': 'OAE',
  'tracker.refreshAll': 'OA',
  'tracker.manageMonitor': 'OA',
  'tracker.addRecurringSlot': 'OA',
  'tracker.buyPromptPack': 'O',
  'keywords.search': 'OAE',
  'keywords.viewHistory': 'OAEVC',
  'keywords.deleteHistory': 'OA',   // Table 3 L177: Delete history = Y·Y·–·– (Editor excluded)
  'sites.connect': 'OA',
  'sites.viewDashboards': 'OAEV',
  'publishing.publish': 'OA',       // editor only via opt-in (tested separately)
  'publishing.approveQueue': 'OA',
  'report.generate': 'OAE',
  'report.scheduleBranded': 'OA',
  'whitelabel.settings': 'OA',
  'billing.manage': 'O',
  'billing.requestTopup': 'AE',     // owner intentionally excluded (ownerNA)
  'credits.viewBalance': 'OAE',
  'analytics.view': 'OA',
  'byok.manage': 'OA',
  'apiTokens.manage': 'OA',
  'account.transferOwnership': 'O',
};

const LETTER = { O: 'owner', A: 'admin', E: 'editor', V: 'viewer', C: 'client' };

test('FULL cell pin: every POLICY action matches its Table-3 vector', () => {
  // No drift in either direction between EXPECTED and POLICY.
  assert.deepEqual(
    Object.keys(POLICY).sort(),
    Object.keys(EXPECTED).sort(),
    'POLICY and EXPECTED action sets differ'
  );
  for (const [action, letters] of Object.entries(EXPECTED)) {
    const allowed = new Set([...letters].map((l) => LETTER[l]));
    for (const role of ['owner', 'admin', 'editor', 'viewer', 'client']) {
      const want = allowed.has(role);
      // base grid (ignore editor opt-in, which is a ctx lift, not a base grant)
      assert.equal(
        can(role, action),
        want,
        `${action}.${role}: expected ${want}, got ${can(role, action)}`
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════
// B. can() matches Table 3
// ═══════════════════════════════════════════════════════════════════════

test('can() — representative Table-3 cells', () => {
  // Tracker granularity: the whole reason this table exists.
  assert.equal(can('editor', 'tracker.refreshOne'), true);
  assert.equal(can('editor', 'tracker.refreshAll'), false); // Admin+ only
  assert.equal(can('admin', 'tracker.refreshAll'), true);
  assert.equal(can('editor', 'tracker.manageMonitor'), false);
  assert.equal(can('owner', 'tracker.buyPromptPack'), true);
  assert.equal(can('admin', 'tracker.buyPromptPack'), false); // cash → owner only

  // Content: editor may trash but not permanently delete.
  assert.equal(can('editor', 'content.trash'), true);
  assert.equal(can('editor', 'content.permanentDelete'), false);
  assert.equal(can('admin', 'content.permanentDelete'), true);

  // Keywords: editor may search + view history, but NOT delete licensed history.
  assert.equal(can('editor', 'keywords.search'), true);
  assert.equal(can('editor', 'keywords.viewHistory'), true);
  assert.equal(can('editor', 'keywords.deleteHistory'), false); // Admin+ only

  // Brand voice: create is Admin+, use is Editor+.
  assert.equal(can('editor', 'brandVoice.manage'), false);
  assert.equal(can('editor', 'brandVoice.use'), true);

  // Billing: owner-only; request-top-up is Admin/Editor and NOT owner.
  assert.equal(can('owner', 'billing.manage'), true);
  assert.equal(can('admin', 'billing.manage'), false);
  assert.equal(can('owner', 'billing.requestTopup'), false); // ownerNA
  assert.equal(can('editor', 'billing.requestTopup'), true);

  // Viewer/client read access.
  assert.equal(can('viewer', 'content.comment'), true);
  assert.equal(can('client', 'content.view'), true);
  assert.equal(can('client', 'members.view'), false);
  assert.equal(can('viewer', 'ai.generate'), false);
});

test('can() — editor opt-in for publishing honors ctx', () => {
  assert.equal(can('editor', 'publishing.publish'), false);
  assert.equal(can('editor', 'publishing.publish', { optIn: true }), true);
  assert.equal(can('viewer', 'publishing.publish', { optIn: true }), false); // opt-in only lifts editor
});

test('can() — fails closed', () => {
  assert.equal(can('nobody', 'content.view'), false);          // unknown role → false
  assert.throws(() => can('owner', 'does.not.exist'), /unknown action/); // typo → throws loudly
});

// ═══════════════════════════════════════════════════════════════════════
// C. CI guard — an un-gated credit/cash route fails
// ═══════════════════════════════════════════════════════════════════════

// Two fixture route sources. The gated one wires requirePermission(action);
// the un-gated one only resolves the workspace and calls the controller.
const GATED_ROUTE = `
  router.post('/:workspaceNumber/keywords/search',
    rwr, requirePermission('keywords.search'), rq('keywordsSearched'),
    keywordController.search);
`;
const UNGATED_ROUTE = `
  router.post('/:workspaceNumber/keywords/search',
    rwr, rq('keywordsSearched'),
    keywordController.search);   // <-- BUG: no requirePermission gate
`;

test('CI guard: a properly gated credit route passes', () => {
  assert.equal(mustBeGated('keywords.search'), true);
  assert.equal(scanSourceForGate(GATED_ROUTE, 'keywords.search'), true);
});

test('CI guard: a deliberately UN-GATED credit route is flagged (would fail CI)', () => {
  const action = 'keywords.search';
  assert.equal(mustBeGated(action), true, 'credit action must be gated');
  const isGated = scanSourceForGate(UNGATED_ROUTE, action);
  assert.equal(isGated, false, 'guard must detect the missing gate');
  // This is exactly the assertion the real CI guard makes over route files:
  assert.ok(
    !isGated,
    `CI GUARD FAILURE (simulated): credit/cash action "${action}" is not gated by requirePermission('${action}')`
  );
});

test('CI guard: a commented-out gate does NOT count as gated', () => {
  const commented = `
    router.post('/:workspaceNumber/keywords/search',
      rwr,
      // requirePermission('keywords.search'),  <-- disabled during debugging
      keywordController.search);
  `;
  assert.equal(scanSourceForGate(commented, 'keywords.search'), false);
});

test('CI guard: gate survives a multi-line middleware chain', () => {
  const multiline = `
    router.post('/x',
      rwr,
      requirePermission(
        'keywords.search'
      ),
      handler);
  `;
  assert.equal(scanSourceForGate(multiline, 'keywords.search'), true);
});

test('CI guard: no false-positive on a substring action', () => {
  // 'content.view' must not match a gate on 'content.viewResults'-like ids.
  const src = `router.get('/x', requirePermission('content.viewResults'), h);`;
  assert.equal(scanSourceForGate(src, 'content.view'), false);
});

test('CREDIT_CASH_ACTIONS is the full must-gate set', () => {
  assert.ok(CREDIT_CASH_ACTIONS.length >= 10, `only ${CREDIT_CASH_ACTIONS.length} must-gate actions`);
  for (const a of ['ai.generate', 'keywords.search', 'billing.manage', 'members.addPaidSeat', 'tracker.refreshAll']) {
    assert.ok(CREDIT_CASH_ACTIONS.includes(a), `${a} missing from CREDIT_CASH_ACTIONS`);
  }
});
