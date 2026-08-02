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
 *    conformance test (agentBilling.test.js) parses the frontend registry and
 *    fails CI if a command ships without a classification here.
 *    NOTE (Phase 2): this branch now only affects the PRE-GATE credit estimate
 *    (estAgent runs as route middleware). The run itself is refused 400 by
 *    resolveAgentRun below — except the one legal missing-commandName case,
 *    the plan-approve article write, which classifies articleGenerate here and
 *    must keep doing so.
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
  // canonicalMode, not body.mode: this function's polarity ("anything not
  // freeform is a command") is the OPPOSITE of resolveAgentRun's ("anything
  // not sequential is freeform"). Read raw, "SEQUENTIAL" lands in the command
  // branch here and the freeform branch there — i.e. billed as a command and
  // exempt from command enforcement. An unrecognized mode is refused by the
  // gate, and prices default-to-expensive here in the meantime.
  const mode = canonicalMode(body.mode) || 'sequential';
  if (mode === 'freeform') {
    if (body.intent === 'auto-write') return 'articleGenerate';
    if (isPlanArticleWrite(content)) return 'articleGenerate';
    return 'inlineAction';
  }
  // sequential (slash-command) path — default-to-expensive on unknown commands.
  // lookupCommand, not a bare bracket: commandName is caller-controlled, and a
  // bare lookup resolves inherited keys ("constructor", "toString"), which
  // would classify to a FUNCTION and make resolveCredits throw inside the
  // credit estimator — a throw the credit gate turns into deduction disabled.
  return lookupCommand(COMMAND_BILLING, body.commandName) || 'articleGenerate';
}

// ─── Phase 2: server-side command enforcement ────────────────
//
// commandName and allowedTools arrive as two INDEPENDENTLY caller-controlled
// body fields, and nothing above this layer ties them together — a crafted
// request could pair a 2-credit commandName with the image toolset and run
// the most expensive pipeline the engine has for the cheapest price. The
// fix: the server registry below is the ONLY source of a run's tool
// whitelist. The body's allowedTools is never read, let alone forwarded.
//
// Every agent-invoking slash command's whitelist is mirrored here VERBATIM
// from suparank/components/editor/commands/registry.ts and conformance-
// tested against it (agentBilling.test.js) — drift fails CI.
const COMMAND_TOOLS = {
  image: ['AskUserTool', 'ImageSearchTool', 'ImageGenTool', 'EditTool'],
  title: ['AskUserTool', 'EditTool'],
  grammar: ['EditTool'],
  'auto-optimize': ['AskUserTool', 'EditTool', 'ReplaceSection'],
  research: ['AskUserTool', 'WebSearchTool', 'WebFetchTool', 'EditTool'],
  'alt-text': ['EditTool'],
  faq: ['AskUserTool', 'EditTool'],
  'external-link': ['AskUserTool', 'WebSearchTool', 'WebFetchTool', 'EditTool'],
  facts: ['AskUserTool', 'WebSearchTool', 'WebFetchTool', 'EditTool'],
  refresh: ['AskUserTool', 'WebSearchTool', 'WebFetchTool', 'EditTool'],
  readability: ['StyleTool', 'EditTool'],
  humanize: ['HumanizerTool', 'EditTool'],
  'super-headings': ['EditTool'],
  'writer-tone': ['EditTool'],
};

/**
 * Commands that opt in to the engine's autonomous post-agent image pass.
 *
 * INTENTIONALLY EMPTY. The pass is a second, independent image pipeline: it
 * re-picks sections with its own LLM, ignores the style the user chose, embeds
 * stock photos directly and writes them into the document without the
 * per-image accept/reject flow. It was built to illustrate freshly generated
 * ARTICLES, and it only ever ran for /image by accident of an inference from
 * the tool whitelist — where it contradicts four of that command's five hard
 * rules, since /image asks the user which sections and which style and then
 * generates originals itself.
 *
 * So no shipping command requests it. Listing one here is the deliberate act
 * of saying "this command should also be auto-illustrated, on top of whatever
 * it does itself".
 */
const COMMAND_IMAGE_PASS = new Set([]);

// Default server-side disabled set. Mirrors the frontend registry's compiled
// default (NEXT_PUBLIC_DISABLED_COMMANDS fallback) and is conformance-tested
// against it. Admin-tunable at runtime via SystemSettings
// (disabledAgentCommands) — if prod ships a different NEXT_PUBLIC_DISABLED_
// COMMANDS, the admin setting must be updated to match or the backend will
// 403 commands the UI offers (that mismatch is loud by design).
const DEFAULT_DISABLED_AGENT_COMMANDS = Object.freeze([
  // /image is SAFE to run now (per-run image budget, per-image COGS metering,
  // the autonomous post-agent pass behind an opt-in nobody sets, a
  // durable-storage refusal, and no free-images-on-stop hole) — but it is not
  // yet PRICED to run. At the flat 10-credit charge (~$0.10 of credit value)
  // a run that generates 3 images costs ~$0.18 in provider spend, and the
  // default budget of 8 costs ~$0.48. Break-even is roughly one image.
  //
  // Enabling is a runtime admin setting (SystemSettings.disabledAgentCommands
  // — no deploy). Do it once the price and IMAGE_BUDGET_PER_RUN agree, and on
  // a deployment where the ENGINE has B2 configured.
  'image', 'alt-text', 'title', 'auto-optimize',
]);

/**
 * Own-property lookup for a CALLER-CONTROLLED key.
 *
 * `TABLE[name]` on an object literal resolves inherited Object.prototype keys:
 * "constructor" and "hasOwnProperty" return functions (truthy, .length 1),
 * "__proto__" returns the prototype. Used as "is this a known command?", that
 * turns `commandName: "constructor"` into a known command whose whitelist is a
 * function — which JSON.stringify then drops from the wire, handing the engine
 * a nil whitelist (unrestricted whole-article governance) while the billing
 * classifier throws and the credit gate fails open. Non-string keys coerce
 * ("['image']" → "image"), which also slips past an .includes() disabled check.
 * Both are closed here: string-only, own-properties-only.
 */
function lookupCommand(table, name) {
  if (typeof name !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

/**
 * The ONE reading of `mode`. Returns 'freeform' | 'sequential', or null when
 * the caller sent something else.
 *
 * Two consumers derive opposite defaults from this field (see classifyAgentRun),
 * so any value that is neither literal lands in the *lenient* half of both:
 * `mode: "SEQUENTIAL"` was billed as a slash command while skipping slash-command
 * enforcement entirely. Trim + lowercase so casing and stray whitespace are
 * accepted rather than silently routed somewhere else, and reject the rest.
 */
function canonicalMode(raw) {
  if (raw === undefined || raw === null || raw === '') return 'freeform';
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toLowerCase();
  return m === 'freeform' || m === 'sequential' ? m : null;
}

/**
 * Server-side gate for POST /ai/agent. Decides whether the run may start and
 * which tool whitelist (if any) the engine receives. Pure function — the
 * caller supplies the live disabled list (SystemSettings) so this stays
 * synchronous and unit-testable.
 *
 * Rules:
 *  - freeform            → ok, NO tools forwarded (RunFreeformAgent ignores
 *                          them; forwarding is pure attack surface)
 *  - sequential + known  → ok, tools = the server registry's list, verbatim
 *  - sequential + known-but-disabled → 403
 *  - sequential + unknown commandName → 400
 *  - sequential + NO commandName → legal ONLY for the plan-approve article
 *    write (EditorChatBar's handleApprovePlan sends exactly this shape),
 *    verified from server-side content state via isPlanArticleWrite. NO tools
 *    forwarded: engine-nil is whole-article governance (research/outline
 *    phases, score stop, steering) and the plan write depends on it — an
 *    explicit whitelist here would silently flip all of that. Billing is
 *    untouched: classifyAgentRun still prices this articleGenerate.
 *
 * Returns the CANONICAL mode alongside the decision — the caller must forward
 * that, not req.body.mode, or the engine re-reads the raw value and dispatches
 * on its own (case-sensitive) comparison.
 *
 * @returns {{ok: true, mode: string, allowedTools?: string[]}
 *        | {ok: false, status: number, code: string, error: string}}
 */
function resolveAgentRun(body = {}, content = null, disabledCommands = DEFAULT_DISABLED_AGENT_COMMANDS) {
  const mode = canonicalMode(body.mode);
  if (mode === null) {
    return {
      ok: false, status: 400, code: 'UNKNOWN_MODE',
      error: 'That request could not be started. Please try again.',
    };
  }
  if (mode !== 'sequential') {
    return { ok: true, mode, allowedTools: undefined };
  }
  // User-facing copy rule: these strings are rendered VERBATIM as an assistant
  // bubble in the editor chat (EditorChatBar reads `error` off the JSON body),
  // so they say what happened and what to do — never "commandName", never
  // "server registry". The machine-readable `code` carries the detail, and the
  // controller logs the specifics for operators.
  const name = body.commandName;
  if (name === undefined || name === null || name === '') {
    if (isPlanArticleWrite(content)) {
      return { ok: true, mode, allowedTools: undefined };
    }
    return {
      ok: false, status: 400, code: 'UNKNOWN_COMMAND',
      error: 'That command could not be started. Try typing it again from the / menu.',
    };
  }
  if (typeof name !== 'string') {
    // A non-string coerces on lookup (["image"] → "image") but compares by
    // identity in the disabled check, which would walk a disabled command
    // straight through the 403.
    return {
      ok: false, status: 400, code: 'UNKNOWN_COMMAND',
      error: 'That command could not be started. Try typing it again from the / menu.',
    };
  }
  const tools = lookupCommand(COMMAND_TOOLS, name);
  if (!tools) {
    return {
      ok: false, status: 400, code: 'UNKNOWN_COMMAND',
      error: `/${name.slice(0, 40)} isn't available. Type / to see the commands you can run.`,
    };
  }
  if (Array.isArray(disabledCommands) && disabledCommands.includes(name)) {
    return {
      ok: false, status: 403, code: 'COMMAND_DISABLED',
      error: `/${name} is switched off at the moment, so it can't run. Your document is unchanged — type / to see what's available.`,
    };
  }
  if (tools.length === 0) {
    // Fail CLOSED. An empty list forwarded downstream is silently dropped by
    // writingEngine.startAgent and the engine then normalizes to nil = NO
    // restriction — a misconfigured entry must refuse, not open up. This is a
    // server misconfiguration, so the user gets neutral copy and the operator
    // gets the COMMAND_MISCONFIGURED code plus the controller's log line.
    return {
      ok: false, status: 500, code: 'COMMAND_MISCONFIGURED',
      error: `/${name} can't run right now. Your document is unchanged.`,
    };
  }
  // A copy, not the live registry array: a downstream mutation of this value
  // would otherwise rewrite the whitelist process-wide for every tenant.
  return { ok: true, mode, allowedTools: tools.slice(), imagePass: COMMAND_IMAGE_PASS.has(name) };
}

module.exports = {
  COMMAND_BILLING, COMMAND_TOOLS, COMMAND_IMAGE_PASS, DEFAULT_DISABLED_AGENT_COMMANDS,
  classifyAgentRun, isPlanArticleWrite, resolveAgentRun, canonicalMode,
};
