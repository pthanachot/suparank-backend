/**
 * computeSettlement — the ONE rule for what a finished chat turn or agent run
 * keeps out of its credit reservation (QA Nov 2026: B04, B38, B42).
 *
 * Product decision (owner): a run that writes NOTHING to the document charges
 * 0 credits. That holds for every billing class, for chat and agent alike, and
 * whether the run ended cleanly or on an engine error. Before this, a chat that
 * only answered a question still cost 1-2 credits, an Auto-write that only
 * talked still cost the inlineAction floor, and an engine error mid-run was
 * billed as if the run had succeeded.
 *
 * Pure: no I/O, no clock. The controllers feed it what the usage tap observed
 * on the SSE stream and hand the result to creditService.settle (or refund when
 * it is 0). settle/refund own the ledger, the pool order, the usage counters
 * and the idempotency (both atomically claim the pending group, so a second
 * call is a no-op) — this function only decides the number.
 *
 * "Wrote" is the tap's docWrites > 0, i.e. at least one `document_diff` event.
 * The engine emits document_diff ONLY when a mutating tool actually changed the
 * document (streaming_executor compares content before/after). A write refused
 * by a guard never reaches that point: input validation, permission/mode
 * denials and tool errors return a tool_result with no diff, and a tool that
 * ran but changed nothing emits document_update, which the tap ignores. So a
 * run whose only "write" was refused counts as not written.
 *
 * Rules, in order:
 *   1. nothing reserved                 → 0
 *   2. nothing written                  → 0  (any class, errored or not)
 *   3. chat                             → aiChatMessage priced on the LARGEST
 *                                         single-turn input tokens (not the sum
 *                                         over the loop: every turn re-sends the
 *                                         prompt, tools and document, so the sum
 *                                         crossed the 8K line on almost every
 *                                         chat and made it cost 2)
 *   4. agent imageGenerate              → run base + images actually produced
 *   5. agent, explicitly reverted       → inlineAction (anti-abuse: the streamed
 *                                         article could otherwise be kept free)
 *   6. agent otherwise                  → the reservation (flat per class)
 * An errored run that wrote keeps the charge its class would have had
 * (rules 3-6): the edits reached the user.
 * The result is always clamped to [0, reserved] — settle can only refund.
 */

const { resolveCredits, agentRunCredits } = require('../../config/creditRules');

// Stop reasons that are the run ending on its own terms (or on a ceiling the
// UI already explains). Anything else that arrives as a stopReason is an
// engine error code captured from an `error` event (api_error, token_budget,
// output_limit, busy, ...). Informational only: it labels the result, it never
// changes the number.
const CLEAN_STOPS = new Set([
  '', 'done', 'nudges_exhausted', 'stale', 'cancelled',
  'max_turns', 'max_edits', 'max_iterations',
]);

function finiteNonNeg(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

function isErrorStop(stopReason) {
  return typeof stopReason === 'string' && !CLEAN_STOPS.has(stopReason);
}

/**
 * @param {object} p
 * @param {'chat'|'agent'} p.kind
 * @param {string} [p.billingClass]  agent billing class (classifyAgentRun)
 * @param {number} p.reserved        credits the pre-deduct reserved
 * @param {string} [p.stopReason]    the tap's stopReason
 * @param {boolean} p.wrote          at least one applied document change
 * @param {number} [p.tokens]        chat: largest single-turn input tokens
 * @param {number} [p.images]        agent: images actually generated
 * @param {boolean} [p.reverted]     agent: explicit stop-and-revert
 * @param {string} [p.tier]          org tier (Free Option B pricing)
 * @returns {{credits: number, reason: string, errored: boolean}}
 */
function computeSettlement({
  kind, billingClass, reserved, stopReason = '', wrote, tokens = 0, images = 0, reverted = false, tier,
} = {}) {
  const cap = finiteNonNeg(reserved);
  const errored = isErrorStop(stopReason);
  if (cap <= 0) return { credits: 0, reason: 'nothing_reserved', errored };
  if (!wrote) return { credits: 0, reason: 'no_write', errored };

  let credits;
  let reason;
  if (kind === 'chat') {
    credits = resolveCredits('aiChatMessage', { tier, tokens: finiteNonNeg(tokens) });
    reason = 'chat';
  } else if (billingClass === 'imageGenerate') {
    credits = agentRunCredits('imageGenerate', { tier, images: finiteNonNeg(images) });
    reason = 'images';
  } else if (reverted) {
    credits = resolveCredits('inlineAction', { tier });
    reason = 'reverted';
  } else {
    credits = cap;
    reason = 'reserved';
  }
  return {
    credits: Math.min(finiteNonNeg(credits), cap),
    reason: errored ? `${reason}_errored` : reason,
    errored,
  };
}

module.exports = { computeSettlement, isErrorStop, CLEAN_STOPS };
