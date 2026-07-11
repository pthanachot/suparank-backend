/**
 * Credit cost table — v4.1 Table 2 (Credit Deduction Schedule).
 *
 * SOURCE OF TRUTH for what each credit-metered action costs. Values are
 * transcribed directly from GEO-PRICING-v4.md "Table 2". One entry per action.
 *
 * Scope (Phase 6): `active: true` marks actions that EXIST end-to-end today (see
 * CAPABILITY-INVENTORY.md) and are therefore billable. Actions that are NEW-BUILD
 * / ROADMAP are `active: false` so the table is a complete reference, but nothing
 * bills them until the feature ships (resolveCredits throws on an inactive action).
 *
 * NOTE: `active` means "exists + priced", NOT "already routed". Routing each
 * active action through a gate/deduction is the Phase-6 worklist — some active
 * actions (image, keyword, brief/outline, rewrite, re-score, import, internal-
 * links, and the real voice/avatar paths) are still being wired. See the plan.
 *
 * Cost shapes:
 *   - `credits: N`                fixed cost.
 *   - `perRow` / `perActivePrompt` variable: multiply by a runtime count.
 *   - `variable(ctx)`            a function returning the credits for this call
 *                                 (e.g. AI chat: ≤8K tokens = 1, above = 2).
 *
 * `fixedBundleFree: true` marks the Free "core loop" bundle actions (article,
 * audit, keyword, tracker check). For a Free org these deduct 0 and are instead
 * count-gated by the tier's lifetime limits (Option B — see creditRules.js).
 *
 * `markupClass` ties the action to one of the three cost-basis classes used for
 * top-up/pack pricing (see creditRules.MARKUP_CLASSES).
 *
 * DO NOT read these numbers directly for a deduction — call
 * creditRules.resolveCredits(action, ctx) so Option B + variable costs + the
 * zero-credit list are all applied consistently.
 */

// ─── Content Editor ──────────────────────────────────────────
const CONTENT = {
  articleGenerate: {
    credits: 100, active: true, fixedBundleFree: true, markupClass: 'platform_ai',
    note: 'Full article (research→draft→optimize→score). Free bundle = 0, count-gated (3 lifetime).',
  },
  fullDocRewrite: {
    credits: 50, active: false, markupClass: 'platform_ai',
    note: 'DEFERRED — the distinct "full-document regenerate" /rewrite action is not '
      + 'wired: no route resolves it. Operationally, full-doc rewrites bill fullDocPass (25) '
      + 'or articleGenerate (100) via the agent path. Per Table 2 ("wired only for existing '
      + 'actions; deferred actions not billed until shipped") this stays inactive until the '
      + 'writing-engine /rewrite ships as its own metered action. (Phase-14 review.)',
  },
  aiChatMessage: {
    credits: 1, active: true, markupClass: 'platform_ai',
    variable: (ctx) => ((ctx?.tokens ?? 0) > 8000 ? 2 : 1),
    note: 'AI chat message per reply: ≤8K tokens = 1, above = 2.',
  },
  inlineAction: {
    credits: 2, active: true, markupClass: 'platform_ai',
    note: 'Inline rewrite / expand / shorten / tone.',
  },
  fullDocPass: {
    credits: 25, active: true, markupClass: 'platform_ai',
    note: 'Full-doc pass: voice rewrite / humanize. (translate NOT built — see inventory #5.) Cap 40K.',
  },
  imageGenerate: {
    credits: 10, active: true, markupClass: 'platform_ai',
    note: 'AI image generation (flash-image). Stock images (Pexels/Openverse) = 0 (zero-credit list).',
  },
  reScore: {
    credits: 10, active: true, markupClass: 'platform_ai',
    note: 'Re-score / re-optimize vs fresh SERP (delta run — Phase 3 fix #2).',
  },
  briefOutline: {
    credits: 20, active: true, markupClass: 'platform_ai',
    note: 'Content brief / outline (engine pipeline).',
  },
  importUrl: {
    credits: 5, active: true, markupClass: 'infra',
    note: 'Import from URL (Scrappey infra).',
  },
};

// ─── Keywords ────────────────────────────────────────────────
const KEYWORDS = {
  keywordLookup: {
    credits: 1, perRow: true, cap: 50, active: true, fixedBundleFree: true, markupClass: 'licensed_data',
    note: 'Keyword lookup, 1 credit/row delivered, capped at 50. Licensed data (DataForSEO/Serper). '
      + 'Free bundle = 0, count-gated (50 lifetime).',
  },
  promptResearch: {
    credits: 10, active: true, markupClass: 'platform_ai',
    note: 'AI prompt research (≤25 prompts). Lives in AI Tracker (inventory #13).',
  },
  // PARTIAL / not-a-distinct-metered-action today (inventory #11, #12) — do NOT bill.
  relatedIdeasReport: {
    credits: 1, perRow: true, cap: 50, active: false, markupClass: 'licensed_data',
    note: 'PARTIAL — delivered inline as relatedKeywords, no separate per-row endpoint. Not billed until built.',
  },
  serpDeepDive: {
    credits: 10, active: false, markupClass: 'licensed_data',
    note: 'PARTIAL — top-10 fetched but not analyzed as a keyword action. Not billed until built.',
  },
  clusteringRun: {
    credits: 10, active: false, markupClass: 'platform_ai',
    note: 'ROADMAP — SERP-overlap clustering is orphaned; embeddings unwired (inventory #14).',
  },
};

// ─── AI Tracker ──────────────────────────────────────────────
const TRACKER = {
  trackerRefreshAll: {
    credits: 5, perActivePrompt: true, active: true, markupClass: 'platform_ai',
    note: 'Refresh-all (Admin+): 5 × active prompts. In-allowance scheduled scans are 0 (zero-credit list).',
  },
  trackerRefreshSingle: {
    credits: 5, active: true, markupClass: 'platform_ai',
    note: 'On-demand refresh, single prompt all engines (Editor+). Phase 8: POST '
      + '.../prompts/:promptId/refresh. Flat 5 (one prompt); refresh-all is 5×n.',
  },
  extraPromptSlotDaily: {
    credits: 150, active: false, markupClass: 'platform_ai',
    note: 'ROADMAP — recurring credit-funded prompt slot (daily). 150/mo. Not built.',
  },
  extraPromptSlotWeekly: {
    credits: 25, active: false, markupClass: 'platform_ai',
    note: 'ROADMAP — recurring credit-funded prompt slot (weekly). 25/mo. Not built.',
  },
};

// ─── Audits ──────────────────────────────────────────────────
const AUDITS = {
  contentAudit: {
    credits: 5, active: true, fixedBundleFree: true, markupClass: 'platform_ai',
    note: 'GEO/content audit per page (K2.5 batched analyzer). Free bundle = 0, count-gated (5 lifetime).',
  },
  internalLinks: {
    credits: 10, active: true, markupClass: 'infra',
    note: 'Internal-link suggestion run. Deterministic phrase/stem matching — NOT an LLM (inventory #21); '
      + 'priced as compute/infra over the crawl site-graph, not model inference.',
  },
  scheduledReAudit: {
    credits: 5, active: false, markupClass: 'platform_ai',
    note: 'NEW-BUILD — scheduled delta re-audit, 5 per changed page. No re-audit scheduler yet.',
  },
};

// ─── Brand Voice ─────────────────────────────────────────────
const BRAND = {
  voiceExtraction: {
    credits: 25, active: false, markupClass: 'platform_ai',
    note: 'NOT WIRED (Phase 6 decision): no distinct voice-extraction endpoint exists. '
      + 'Brand-voice content is user-authored (saveBrandVoice — no AI), and voice APPLICATION '
      + 'during an article rewrite is already billed via the agent/chat path — a separate 25 '
      + 'here would double-charge. Kept inactive so a future accidental gate fails open (never '
      + 'charges) rather than billing a phantom action. Re-activate only if a standalone '
      + 'sample-based extraction pipeline is built.',
  },
  avatarCreate: {
    credits: 10, active: true, markupClass: 'platform_ai',
    note: 'Avatar creation (persona). NB: avatar image is USER-UPLOADED, not AI-generated (inventory #23).',
  },
  // Test previews are ~150-word single /api/rewrite calls (compact role) — the
  // same size/shape as an inline edit, priced identically (2). Re-costed from a
  // hardcoded 3 in Phase 6 (route + controller previously bypassed the table).
  brandVoiceTest: {
    credits: 2, active: true, markupClass: 'platform_ai',
    note: 'Brand-voice test preview (~150 words, one /rewrite). Rate-limited separately.',
  },
  avatarTest: {
    credits: 2, active: true, markupClass: 'platform_ai',
    note: 'Avatar test preview (~150 words, one /rewrite). Rate-limited separately.',
  },
};

const CREDIT_COSTS = {
  ...CONTENT,
  ...KEYWORDS,
  ...TRACKER,
  ...AUDITS,
  ...BRAND,
};

/** Actions that exist end-to-end and are wired to a live deduction. */
const ACTIVE_ACTIONS = Object.keys(CREDIT_COSTS).filter((k) => CREDIT_COSTS[k].active);

/** The Free "core loop" fixed-bundle actions (deduct 0 for Free, count-gated). */
const FIXED_BUNDLE_ACTIONS = Object.keys(CREDIT_COSTS).filter((k) => CREDIT_COSTS[k].fixedBundleFree);

module.exports = { CREDIT_COSTS, ACTIVE_ACTIONS, FIXED_BUNDLE_ACTIONS };
