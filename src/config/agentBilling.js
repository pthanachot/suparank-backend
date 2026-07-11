/**
 * Agent-run billing classification — maps how an /ai/agent run was invoked to
 * the creditCosts.js action that prices it.
 *
 * WHY THIS EXISTS (Phase 6, money#1 review): `mode` alone is the wrong billing
 * discriminator. `sequential` just means "invoked via a slash command", and all
 * current slash commands are EDIT PASSES (title, grammar, facts…), not article
 * writes. The real full-article path is the editor's Auto-write (freeform with
 * a default goal), which the frontend marks with `intent: 'auto-write'`.
 *
 * Rules:
 *  - freeform + intent 'auto-write'  → articleGenerate (100; count-gated)
 *  - freeform otherwise              → inlineAction (2)
 *  - sequential + KNOWN command      → that command's mapped action (below)
 *  - sequential + unknown/missing    → articleGenerate — DEFAULT-TO-EXPENSIVE:
 *    a spoofed/unclassified command can only ever over-charge + count-gate,
 *    never run cheap. New slash commands MUST be added to COMMAND_BILLING; the
 *    conformance test (agentBillingConformance.test.js) parses the frontend
 *    registry and fails CI if a command ships without a classification here.
 *
 * Client-declared fields (mode/commandName/intent) are spoofable. The design
 * goal is not "unspoofable" — it's "lying never gets unlimited free work":
 *  - The ARTICLE SLOT is enforced server-side, independent of this price
 *    class: aiController slot-gates any run where isPlanArticleWrite(content)
 *    holds, whatever the body claims (review BLOCKER-1).
 *  - Spoofing the PRICE down (sequential+cheap-command, mode-typos, or
 *    chat-with-EditTool) lands at the 1-2 credit floor on FINITE pools —
 *    Free: ≤100-200 budget-preset runs lifetime from the non-renewing 200
 *    sample. Bounded, attributable via the cost ledger; accepted.
 *  - KNOWN GAP (accepted): typed freeform goals ("rewrite the whole article")
 *    on NON-plan docs bill inlineAction with no slot — full-rewrite intent is
 *    client-side there. Same pool bound applies. The gated honest paths are
 *    Auto-write (intent), plan-execute (server state), and slash commands.
 */

// Every agent-invoking slash command in suparank/components/editor/commands/
// registry.ts MUST appear here (conformance-tested). chatMode commands (e.g.
// meta-description) route through /ai/chat and are billed as chat — not listed.
const COMMAND_BILLING = {
  // Doc-wide passes and/or web-search-using commands → fullDocPass (25)
  'auto-optimize': 'fullDocPass',
  research: 'fullDocPass',
  faq: 'fullDocPass',
  'external-link': 'fullDocPass',
  facts: 'fullDocPass',
  refresh: 'fullDocPass',
  readability: 'fullDocPass',
  humanize: 'fullDocPass',
  'super-headings': 'fullDocPass',
  'writer-tone': 'fullDocPass',

  // Targeted, no-web-search edits → inlineAction (2)
  title: 'inlineAction',
  grammar: 'inlineAction',
  'alt-text': 'inlineAction',

  // Image generation command → imageGenerate (10)
  image: 'imageGenerate',
};

/**
 * True when this content is in plan-execute mode under an approved plan that
 * has NOT yet produced its article — i.e. the next freeform run is the plan's
 * article write. SERVER-SIDE state (content.mode/activePlanId are set by
 * planController at approve time; articleGeneratedPlanId is stamped by
 * aiController on write completion) — not client-spoofable, unlike intent.
 * Each approved plan buys exactly ONE article generation; once stamped,
 * further runs under the same plan are ordinary freeform adjustments (2).
 */
function isPlanArticleWrite(content) {
  return !!(
    content &&
    content.mode === 'execute' &&
    content.activePlanId &&
    String(content.activePlanId) !== String(content.articleGeneratedPlanId || '')
  );
}

/**
 * Classify an agent run into a creditCosts action.
 * @param {object} body - the /ai/agent request body ({ mode, commandName, intent })
 * @param {object} [content] - the Content doc (mode/activePlanId/articleGeneratedPlanId);
 *   when provided, freeform runs in plan-execute mode classify as the plan's
 *   article write (see isPlanArticleWrite).
 * @returns {string} creditCosts.js action key
 */
function classifyAgentRun(body = {}, content = null) {
  const mode = body.mode || 'freeform';
  if (mode === 'freeform') {
    if (body.intent === 'auto-write') return 'articleGenerate';
    if (isPlanArticleWrite(content)) return 'articleGenerate';
    return 'inlineAction';
  }
  // sequential (slash-command) path — default-to-expensive on unknown commands.
  return COMMAND_BILLING[body.commandName] || 'articleGenerate';
}

module.exports = { COMMAND_BILLING, classifyAgentRun, isPlanArticleWrite };
