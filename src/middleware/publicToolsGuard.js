/**
 * publicToolsGuard — request guard for the unauthenticated free-tool
 * endpoints. These are the only public compute endpoints in the API, so the
 * posture is deny-by-default: honeypot, per-IP daily cap, then the global
 * daily budget kill-switch. Cache lookups happen INSIDE the guard so cached
 * results stay free and don't consume the caller's daily allowance.
 *
 * Usage:
 *   router.post('/content-score',
 *     publicToolsGuard({ toolId: 'content-score', maxPerDay: 5, cacheInput: (req) => ({ url: req.body.url }) }),
 *     controller.contentScore
 *   );
 *
 * On a cache hit the guard responds directly with the cached payload
 * ({ cached: true, ...payload }) and never calls the controller.
 * When the budget is exhausted it responds 503 { degraded: true } — the
 * frontend switches to "email me my result" mode instead of showing an error.
 */
const publicToolsService = require('../services/publicToolsService');

function publicToolsGuard({ toolId, maxPerDay, cacheInput, validate }) {
  if (!toolId || !maxPerDay || typeof cacheInput !== 'function') {
    throw new Error('publicToolsGuard requires toolId, maxPerDay, and cacheInput');
  }

  return async function guard(req, res, next) {
    try {
      // 1. Honeypot: real users never fill the hidden field. Respond with a
      //    generic error (no hint that the field is the reason).
      if (typeof req.body?._hp === 'string' && req.body._hp.length > 0) {
        return res.status(400).json({ error: 'invalid request' });
      }

      // 2. Input validation — BEFORE anything is metered, so malformed
      //    requests never consume the caller's daily allowance.
      if (validate) {
        const problem = validate(req);
        if (problem) return res.status(400).json({ error: problem });
      }

      // 3. Cache — free and unmetered.
      const input = cacheInput(req);
      const cached = await publicToolsService.getCached(toolId, input);
      if (cached) {
        return res.json({ cached: true, ...cached });
      }

      // 4. Global daily budget kill-switch — checked BEFORE the per-IP
      //    counter so a degraded window doesn't burn anyone's allowance.
      if (await publicToolsService.budgetExhausted()) {
        return res.status(503).json({
          degraded: true,
          message: "Today's free-tool capacity is used up — come back tomorrow, or sign up free to run it from your account.",
        });
      }

      // 5. Per-IP daily cap.
      const { allowed, remaining } = await publicToolsService.consumeRateLimit(
        req.ip,
        toolId,
        maxPerDay
      );
      res.set('X-Tool-Checks-Remaining', String(remaining));
      if (!allowed) {
        return res.status(429).json({
          error: 'daily limit reached',
          message: `You've used today's free checks for this tool. Create a free account for more, or come back tomorrow.`,
        });
      }

      // Expose plumbing to the controller for caching + cost logging.
      req.publicTool = { toolId, input };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = publicToolsGuard;
