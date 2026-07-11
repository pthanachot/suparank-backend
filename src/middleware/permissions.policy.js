/**
 * permissions.policy.js — the DECLARATIVE RBAC policy table. This IS Table 3
 * of GEO-PRICING-v4.md, encoded as code and the single source of truth for
 * "which role may perform which action."
 *
 * Why this exists (v4.1 plan, Phase 2): the legacy system stores a coarse
 * `resource:action` grid in the DB `Permission` collection (seeded from
 * scripts/configPermissions.js) and checks it via requirePermission(resource,
 * action). v4 needs finer granularity — e.g. AI-Tracker "on-demand refresh"
 * (Editor+) vs "refresh-all" (Admin+) vs "buy prompt pack" (Owner-cash) all
 * fell under one coarse `aiTracker:*`. This module is the granular replacement.
 *
 * Design:
 *  - POLICY: action-id → per-role booleans + metadata (cash/credit/roadmap).
 *  - can(role, action, ctx): PURE function, no DB. Use in gates, tests, CI,
 *    and the Phase-19 invariant suite.
 *  - requirePermission(action): the NEW single-arg Express gate (applied to
 *    routes in Phase 10; not wired here).
 *  - Guard helpers (CREDIT_CASH_ACTIONS, mustBeGated, scanSourceForGate) back
 *    the CI guard that fails an un-gated credit/cash route.
 *
 * Roles (from WorkspaceMember/OrgMember): owner (implicit via Organization
 * .ownerId), admin, editor, viewer, client. 'client' = external agency-client
 * (white-label) — a restricted viewer scoped to their own workspace.
 *
 * Monotonicity invariant (enforced by tests): client ⟹ viewer ⟹ editor ⟹ admin
 * for every action. 'owner' is true for every action EXCEPT those flagged
 * ownerNA (e.g. request-top-up, which an owner never needs).
 *
 * Cash invariant (enforced by tests): every `cash: true` action is Owner-only.
 */

const ROLES = ['owner', 'admin', 'editor', 'viewer', 'client'];

// Shorthand role-vector builders keep the table readable and consistent.
// r(owner, admin, editor, viewer, client) — omitted trailing args default false.
function r(owner = false, admin = false, editor = false, viewer = false, client = false) {
  return { owner, admin, editor, viewer, client };
}

/**
 * POLICY — one entry per v4 Table-3 action.
 *
 * Fields:
 *  - roles:    { owner, admin, editor, viewer, client } booleans
 *  - resource: coarse legacy resource (bridges to the old Permission grid;
 *              lets Phase 10 reconcile with requirePermission(resource,action))
 *  - cash:     true → a real-money action; MUST be Owner-only
 *  - credit:   true → spends AI credits; MUST carry a permission gate
 *  - roadmap:  true → feature not built yet; gate defined but inert until it ships
 *  - ownerNA:  true → 'owner' intentionally false (action is meaningless for owner)
 *  - editorOptIn: true → editor is false by default but ctx.optIn may grant it
 *  - note:     human constraint the boolean grid can't express
 */
const POLICY = {
  // ─── Workspace ──────────────────────────────────────────────────────
  'workspace.create':             { roles: r(true, true),  resource: 'workspace' },
  'workspace.createBeyondPlan':   { roles: r(true),        resource: 'workspace', cash: true, roadmap: true, note: '+$29/mo extra workspace — billing flow is roadmap' },
  'workspace.settings':           { roles: r(true, true),  resource: 'workspace' },
  'workspace.delete':             { roles: r(true),        resource: 'workspace' },
  'workspace.creditSubLimits':    { roles: r(true, true),  resource: 'workspace', note: 'per-workspace credit ceilings' },
  'workspace.allocatePooledSlots':{ roles: r(true, true),  resource: 'workspace', note: 'Agency pooled prompt allocation; depends on recurring-slot mechanism (roadmap)' },

  // ─── Members (workspace-scoped) ─────────────────────────────────────
  'members.view':                 { roles: r(true, true, true),  resource: 'members' },
  'members.invite':               { roles: r(true, true),        resource: 'members', note: 'invite/remove within seat count, incl. free client viewers' },
  'members.addPaidSeat':          { roles: r(true),              resource: 'members', cash: true, note: '+$10/mo editor seat' },
  'members.changeRole':           { roles: r(true, true),        resource: 'members', note: 'Admin may grant ≤ Editor only (enforced in handler)' },

  // ─── Content ────────────────────────────────────────────────────────
  'content.view':                 { roles: r(true, true, true, true, true),  resource: 'content' },
  'content.edit':                 { roles: r(true, true, true),              resource: 'content', note: 'create + edit' },
  'content.comment':              { roles: r(true, true, true, true, true),  resource: 'content' },
  'content.trash':                { roles: r(true, true, true),              resource: 'content' },
  'content.permanentDelete':      { roles: r(true, true),                    resource: 'content', note: 'Editor may trash but NOT permanently delete' },
  'content.restoreVersion':       { roles: r(true, true, true),              resource: 'content' },

  // ─── AI & analysis (credit spend) ───────────────────────────────────
  'ai.generate':                  { roles: r(true, true, true),        resource: 'analysis', credit: true, note: 'article/brief/rewrite/chat/image/import-from-URL; stock-image search is free. Phase 6 must gate import here (it currently rides content.edit, which carries no credit flag)' },
  'ai.audit':                     { roles: r(true, true, true),        resource: 'analysis', credit: true, note: 'run audit / re-score' },
  'ai.viewResults':               { roles: r(true, true, true, true, true),  resource: 'analysis', note: 'client sees results behind white-label skin (preserves legacy)' },

  // ─── Brand voice ────────────────────────────────────────────────────
  'brandVoice.manage':            { roles: r(true, true),        resource: 'brandVoice', credit: true, note: 'create/edit voice & avatar; spends credits (extraction/avatar)' },
  'brandVoice.use':               { roles: r(true, true, true),  resource: 'brandVoice' },

  // ─── AI Tracker ─────────────────────────────────────────────────────
  'tracker.view':                 { roles: r(true, true, true, true, true),  resource: 'aiTracker', note: 'client sees their brand tracker (preserves legacy)' },
  'tracker.managePrompts':        { roles: r(true, true, true),        resource: 'aiTracker', note: 'manage prompts/competitors within slot allowance' },
  'tracker.refreshOne':           { roles: r(true, true, true),        resource: 'aiTracker', credit: true, note: 'on-demand single refresh (5 cr)' },
  'tracker.refreshAll':           { roles: r(true, true),              resource: 'aiTracker', credit: true, note: 'refresh-all (5 × n), shown pre-confirm' },
  'tracker.manageMonitor':        { roles: r(true, true),              resource: 'aiTracker', note: 'create/delete monitor (alert rules, tier-capped)' },
  'tracker.addRecurringSlot':     { roles: r(true, true),              resource: 'aiTracker', credit: true, roadmap: true, note: 'recurring credit-funded slot (150/25 per mo) — mechanism is roadmap' },
  'tracker.buyPromptPack':        { roles: r(true),                    resource: 'aiTracker', cash: true, roadmap: true, note: '$59/50 prompt pack — billing flow is roadmap' },

  // ─── Keywords ───────────────────────────────────────────────────────
  'keywords.search':              { roles: r(true, true, true),        resource: 'keywords', credit: true },
  'keywords.viewHistory':         { roles: r(true, true, true, true, true),  resource: 'keywords', note: 'client sees keyword history (preserves legacy)' },
  'keywords.deleteHistory':       { roles: r(true, true),              resource: 'keywords', note: 'Admin+ only — Editor may NOT delete licensed keyword history (Table 3: Y·Y·–·–)' },

  // ─── Sites & publishing ─────────────────────────────────────────────
  'sites.connect':                { roles: r(true, true),              resource: 'sites', note: 'connect site / GSC / CMS (OAuth)' },
  'sites.viewDashboards':         { roles: r(true, true, true, true),  resource: 'sites' },
  'publishing.publish':           { roles: r(true, true, false),       resource: 'sites', roadmap: true, editorOptIn: true, note: 'publish/schedule to CMS — Editor opt-in per workspace; CMS publishing is roadmap' },
  'publishing.approveQueue':      { roles: r(true, true),              resource: 'sites', roadmap: true, note: 'approve autopilot queue (per-workspace on Agency)' },

  // ─── White-label & client reports ───────────────────────────────────
  // report.generate + brand settings are LIVE (routes exist, gated O,A/E).
  // Branded-recurring reports and the client portal are roadmap; custom
  // domain / white-label email code exists but is behind DARK feature flags.
  'report.generate':              { roles: r(true, true, true),  resource: 'whiteLabel', note: 'generate a client report (route live; report BRANDING depth is roadmap)' },
  'report.scheduleBranded':       { roles: r(true, true),        resource: 'whiteLabel', roadmap: true, note: 'schedule/send branded recurring reports — not built' },
  'whitelabel.settings':          { roles: r(true, true),        resource: 'whiteLabel', note: 'brand settings route live (O,A); domain/email sub-routes behind dark flags; client portal roadmap' },

  // ─── Account & platform ─────────────────────────────────────────────
  'billing.manage':               { roles: r(true),                    resource: 'billing', cash: true, note: 'plan, cards, top-ups, packs' },
  'billing.requestTopup':         { roles: r(false, true, true),       resource: 'billing', ownerNA: true, note: 'Admin/Editor request; notifies Owner. Owner buys directly via billing.manage' },
  'credits.viewBalance':          { roles: r(true, true, true),        resource: 'billing' },
  'analytics.view':               { roles: r(true, true),              resource: 'billing', note: 'usage analytics & audit log (append-only ledger)' },
  'byok.manage':                  { roles: r(true, true),              resource: 'account', roadmap: true, note: 'BYOK keys — account-level or attached per workspace' },
  'apiTokens.manage':             { roles: r(true, true),              resource: 'account', roadmap: true, note: 'API + MCP tokens (Pro+)' },
  'account.transferOwnership':    { roles: r(true),                    resource: 'account', note: 'transfer ownership / delete account' },
};

// ─── can() — the pure authorization check ──────────────────────────────

/**
 * Return true if `role` may perform `action`.
 *
 * @param {string} role   one of ROLES (e.g. req.workspaceRole). Unknown → false.
 * @param {string} action a POLICY key. Unknown → throws (surfaces typos loudly).
 * @param {object} [ctx]  optional context. { optIn: true } grants an
 *                        editorOptIn action to the 'editor' role.
 */
function can(role, action, ctx = {}) {
  const entry = POLICY[action];
  if (!entry) {
    throw new Error(`[permissions.policy] unknown action "${action}"`);
  }
  if (!ROLES.includes(role)) return false;

  if (entry.roles[role]) return true;

  // Editor opt-in: some actions (e.g. publishing.publish) are Admin-default but
  // an Admin can grant an individual Editor the capability per workspace.
  if (entry.editorOptIn && role === 'editor' && ctx.optIn === true) return true;

  return false;
}

// ─── requirePermission(action) — the new single-arg Express gate ───────
//
// Applied to routes in Phase 10. Must run AFTER resolveWorkspaceWithRole
// (needs req.workspaceRole). ctx.optIn is read from req.publishOptIn when set
// by upstream middleware (per-workspace editor publish grant).

function requirePermission(action) {
  if (!POLICY[action]) {
    // Fail at wiring time, not request time.
    throw new Error(`[permissions.policy] requirePermission: unknown action "${action}"`);
  }
  return (req, res, next) => {
    const role = req.workspaceRole;
    if (!role) {
      return res.status(403).json({ error: 'No workspace role resolved' });
    }
    if (can(role, action, { optIn: req.publishOptIn === true })) {
      return next();
    }
    return res.status(403).json({ error: 'Insufficient permissions', action });
  };
}

// ─── Guard helpers (back the CI guard) ─────────────────────────────────

/** Actions that MUST carry a permission gate on their route: credit or cash. */
const CREDIT_CASH_ACTIONS = Object.keys(POLICY).filter(
  (a) => POLICY[a].credit || POLICY[a].cash
);

/** True if `action` must be gated (spends credits or money). */
function mustBeGated(action) {
  const e = POLICY[action];
  return !!e && (!!e.credit || !!e.cash);
}

/**
 * Static-scan a route file's source for a gate on `action`.
 * Matches requirePermission('action') / requirePermission("action") / backticks,
 * tolerating whitespace/newlines between `(` and the quoted action.
 *
 * Pure-comment lines (trimmed line starts with `//`) are stripped first so a
 * commented-out gate does not read as present. Note: this does NOT strip block
 * comments (`/* ... *\/`) — the Phase-10 full-route-scan guard should use a real
 * parser; this is the Phase-2 mechanism.
 */
function scanSourceForGate(source, action) {
  const active = String(source)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const re = new RegExp(`requirePermission\\(\\s*['"\`]${action.replace(/[.]/g, '\\.')}['"\`]`);
  return re.test(active);
}

module.exports = {
  ROLES,
  POLICY,
  can,
  requirePermission,
  CREDIT_CASH_ACTIONS,
  mustBeGated,
  scanSourceForGate,
};
