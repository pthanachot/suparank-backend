/**
 * CREDIT_ACTION_TO_PERMISSION — the explicit bridge between Table 2 (credit
 * costs, `creditCosts.js`) and Table 3 (RBAC, `permissions.policy.js`).
 *
 * Phase 14 invariant #1 is "every LIVE credit action has EXACTLY ONE permission
 * gate." That relationship was previously only IMPLICIT in the route wiring —
 * and un-checkable, because a route's `rc(featureKey, estimator)` first argument
 * is a feature key, not a `creditCosts` action, and the true cost action is often
 * resolved inside the estimator (e.g. estChat→aiChatMessage, estAgent→
 * classifyAgentRun→articleGenerate). This map makes it explicit and testable.
 *
 * Each key is an ACTIVE `creditCosts.js` action; each value is the single
 * `permissions.policy.js` action that gates its route. Values were read off the
 * actual routes (cited inline). `tests/invariants.test.js` proves this map is:
 *   - total over `creditCosts.ACTIVE_ACTIONS` (every live cost has a gate),
 *   - single-valued (exactly one permission per action),
 *   - consistent with POLICY (every value is a live, non-roadmap policy action),
 *   - a superset cover of every live `credit:true` policy action (no orphan gate),
 * and route-grounded for the direct-`rc` actions.
 *
 * NOTE: some values are broader "manage" permissions, not `credit:true` flags —
 * e.g. promptResearch is gated by `tracker.managePrompts` (which also covers the
 * free add/edit-prompt actions). That is intentional: the gate is the permission
 * a caller must hold, which may be broader than a dedicated credit permission.
 */

const CREDIT_ACTION_TO_PERMISSION = {
  // ── Content Editor — AI generation (Table 3: "Generate: article/brief/rewrite/chat/image/import") ──
  articleGenerate: 'ai.generate', // POST …/ai/agent (classifyAgentRun → articleGenerate)
  // (fullDocRewrite is DEFERRED — active:false in Table 2, charged by no route; the
  //  agent bills full-doc rewrites as fullDocPass/articleGenerate. Not in this map
  //  because inv1 covers only ACTIVE_ACTIONS. See creditCosts.js.)
  aiChatMessage: 'ai.generate', // POST …/ai/chat, …/ai/inline-edit
  inlineAction: 'ai.generate', // POST …/ai/agent (classifyAgentRun → inlineAction); settled aiController
  fullDocPass: 'ai.generate', // full-doc voice rewrite / humanize
  imageGenerate: 'ai.generate', // POST …/ai/generate-image
  briefOutline: 'ai.generate', // POST …/regenerate-outline
  importUrl: 'ai.generate', // POST …/import-url
  internalLinks: 'ai.generate', // POST …/internal-links

  // ── Audits / re-score (Table 3: "Run audit / re-score") ──
  contentAudit: 'ai.audit', // POST …/audit
  reScore: 'ai.audit', // POST …/reanalyze

  // ── Keywords (Table 3: "Search (credit spend)") ──
  keywordLookup: 'keywords.search', // POST …/keywords/search

  // ── AI Tracker ──
  promptResearch: 'tracker.managePrompts', // POST …/ai-tracker/suggest-prompts
  trackerRefreshSingle: 'tracker.refreshOne', // POST …/prompts/:id/refresh
  trackerRefreshAll: 'tracker.refreshAll', // POST …/ai-tracker/scan (5×n)

  // ── Brand voice / avatar (Table 3: "Create/edit voice & avatar (spends credits)") ──
  avatarCreate: 'brandVoice.manage', // charged in updateAvatar (PUT …/brand-voice/avatars/:id), same gate
  brandVoiceTest: 'brandVoice.manage', // POST …/brand-voice/test
  avatarTest: 'brandVoice.manage', // POST …/brand-voice/avatars/:id/test
};

module.exports = { CREDIT_ACTION_TO_PERMISSION };
