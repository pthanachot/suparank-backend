/**
 * Public free-tool endpoints (mounted at /api/public/tools in index.js).
 * UNAUTHENTICATED by design — every route must:
 *   - go through publicToolsGuard (honeypot + IP cap + budget kill-switch + cache)
 *   - validate input strictly (these routes touch paid provider APIs)
 *   - never read or return tenant data
 *   - log provider spend to AiCostLedger with action = publicToolsService.LEDGER_ACTION
 *
 * Tool endpoints land here in Phase 3.1+ (content-score, visibility checkers,
 * brief generator, share-of-voice).
 */
const express = require('express');
const router = express.Router();
const publicToolsService = require('../services/publicToolsService');
const publicToolsGuard = require('../middleware/publicToolsGuard');
const publicToolsController = require('../controllers/publicToolsController');
const {
  validateVisibilityCheck,
  visibilityCacheInput,
  validateContentBrief,
  contentBriefCacheInput,
  validateShareOfVoice,
  shareOfVoiceCacheInput,
} = publicToolsController;

/**
 * GET /api/public/tools/status
 * Health + degradation state for the tool pages. The frontend polls this on
 * tool-page load: `degraded: true` switches panels to email-capture mode.
 * Returns no spend numbers — those are internal.
 */
router.get('/status', async (req, res, next) => {
  try {
    const degraded = await publicToolsService.budgetExhausted();
    res.json({ ok: true, degraded });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/tools/visibility-check — one-shot AI visibility check:
 * one engine, up to 3 prompts, cited/mentioned/absent per prompt.
 * 3 checks/day/IP; results cached 24h.
 */
router.post(
  '/visibility-check',
  publicToolsGuard({
    toolId: 'visibility-check',
    maxPerDay: 3,
    validate: validateVisibilityCheck,
    cacheInput: visibilityCacheInput,
  }),
  publicToolsController.visibilityCheck
);

/**
 * POST /api/public/tools/content-brief — free SEO brief from the live SERP:
 * LLM outline drawn from the top-10 titles + People-Also-Ask + related
 * searches. 2 briefs/day/IP; cached 7 days per keyword.
 */
router.post(
  '/content-brief',
  publicToolsGuard({
    toolId: 'content-brief',
    maxPerDay: 2,
    validate: validateContentBrief,
    cacheInput: contentBriefCacheInput,
  }),
  publicToolsController.contentBrief
);

/**
 * POST /api/public/tools/share-of-voice — your brand vs up to 3 competitors,
 * one prompt across all four AI engines; SoV computed from the same answers.
 * 2 runs/day/IP; full-coverage results cached 24h.
 */
router.post(
  '/share-of-voice',
  publicToolsGuard({
    toolId: 'share-of-voice',
    maxPerDay: 2,
    validate: validateShareOfVoice,
    cacheInput: shareOfVoiceCacheInput,
  }),
  publicToolsController.shareOfVoice
);

module.exports = router;
