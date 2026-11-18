/**
 * Article allowance — CHECK at create, COUNT once at first real use (QA B24).
 *
 * Before: createContent incremented the article counter the moment a document
 * row existed. Lifetime counters never decrement, so a Free user who opened the
 * setup wizard and abandoned it had spent one of their three lifetime articles
 * on an empty draft.
 *
 * Now: POST /content still runs requireQuota (the limit CHECK), but the counter
 * moves only when the article is first put to work, exactly once per document:
 *   - when its analysis is actually started (createContent's auto-trigger, the
 *     wizard's startAnalysis claim, POST /analyze, reanalyze, free retry), or
 *   - on its first successful AI article generation, if it was never analyzed
 *     (a blank document written by Auto-write).
 * Whichever comes first wins an atomic claim on articleQuotaState
 * ('pending' → 'counted'); the loser matches nothing.
 *
 * Documents created BEFORE this change have no articleQuotaState. They were
 * already counted at create, so the claim can never match them (it filters on
 * the literal 'pending'), and the "first generation is covered by the slot"
 * rule keeps working for them unchanged.
 *
 * Because the count is deferred, the limit is RE-CHECKED at the claim: several
 * drafts can be created under the limit and then started. A claim over the
 * limit is refused (the caller does not start the analysis / the run) and the
 * document stays 'pending', so it can still be started after an upgrade.
 * Same accepted TOCTOU as requireQuota (check, then increment).
 */

const Content = require('../models/Content');
const UsageTracker = require('../models/UsageTracker');
const UserUsageTracker = require('../models/UserUsageTracker');
const tierService = require('./tierService');

const COUNTER_KEY = 'articlesCreated';

/**
 * What createContent persists from req.tierQuota. Periods are NOT stored:
 * a monthly count lands in the month the article is put to work.
 */
function quotaCtxFromReq(tierQuota, quotaSource) {
  if (!tierQuota || tierQuota.counterKey !== COUNTER_KEY) return null;
  return {
    orgId: tierQuota.orgId ? String(tierQuota.orgId) : null,
    userId: tierQuota.userId ? String(tierQuota.userId) : null,
    isUserLevel: !!tierQuota.isUserLevel,
    // null period at create = unlimited org quota: nothing org-level to count.
    orgCounted: tierQuota.period != null,
    lifetime: tierQuota.period === 'lifetime',
    quotaSource: quotaSource === 'free' ? 'free' : null,
    workspaceId: tierQuota.workspaceId ? String(tierQuota.workspaceId) : null,
  };
}

/** Rebuild the incrementQuota argument with CURRENT periods. */
function tierQuotaFromCtx(ctx) {
  if (!ctx) return null;
  const q = {
    orgId: ctx.orgId,
    userId: ctx.userId,
    counterKey: COUNTER_KEY,
    isUserLevel: !!ctx.isUserLevel,
    period: ctx.orgCounted ? tierService.getPeriod(ctx.lifetime ? 'lifetime' : 'monthly') : null,
  };
  if (ctx.workspaceId) {
    q.workspaceId = ctx.workspaceId;
    q.workspacePeriod = tierService.getPeriod('monthly');
  }
  return q;
}

/**
 * Is there room for one more article under the context's limit right now?
 * Fails OPEN on a config/lookup error, like requireQuota.
 */
async function checkRoom(ctx) {
  try {
    if (!ctx || !ctx.orgId) return { ok: true };
    let { tier, config } = await tierService.getOrgTierConfig(ctx.orgId);
    if (ctx.quotaSource === 'free' && tier !== 'free') {
      config = await tierService.getTierConfig('free');
      tier = 'free';
    }
    const limit = config?.maxArticlesPerMonth;
    if (limit == null) return { ok: true };
    const limitType = config?.articleLimitType || 'monthly';
    const used = (limitType === 'lifetime' && ctx.userId)
      ? await UserUsageTracker.getCount(ctx.userId, COUNTER_KEY)
      : await UsageTracker.getCount(ctx.orgId, COUNTER_KEY, tierService.getPeriod(limitType));
    if (used >= limit) {
      return {
        ok: false,
        payload: {
          error: tier === 'free'
            ? `You've used all ${limit} articles included in the free plan. Upgrade to keep writing. Paid plans start at 20 articles per month.`
            : `You've reached your plan's article limit (${used} of ${limit} used). Your allowance resets next billing cycle, or upgrade for a higher limit.`,
          code: 'ARTICLE_LIMIT_REACHED',
          quota: { used, limit, tier, limitKey: 'maxArticlesPerMonth', limitType },
          upgradeUrl: '/pricing',
        },
      };
    }
    return { ok: true };
  } catch (err) {
    console.error('[article-quota] limit re-check failed (fail open):', err.message);
    return { ok: true };
  }
}

/**
 * Count this document's article slot if it has not been counted yet.
 *
 * @param {object} content  needs _id, articleQuotaState, articleQuotaCtx
 * @param {object} [opts]
 * @param {boolean} [opts.enforce=true] re-check the limit before counting
 * @returns {Promise<{ok: boolean, counted: boolean, payload?: object}>}
 *   ok:false → over the limit; the caller must not start the work.
 *   counted:true → THIS call moved the counter.
 */
async function claimArticleSlot(content, { enforce = true } = {}) {
  if (!content || content.articleQuotaState !== 'pending') return { ok: true, counted: false };
  const ctx = content.articleQuotaCtx || null;
  if (enforce) {
    const room = await checkRoom(ctx);
    if (!room.ok) return { ok: false, counted: false, payload: room.payload };
  }
  const claimed = await Content.findOneAndUpdate(
    { _id: content._id, articleQuotaState: 'pending' },
    { $set: { articleQuotaState: 'counted', articleCountedAt: new Date() } },
  );
  if (!claimed) return { ok: true, counted: false }; // someone else counted it
  try {
    const q = tierQuotaFromCtx(ctx);
    if (q) await tierService.incrementQuota(q);
  } catch (err) {
    // The claim stands: a lost increment under-counts once, which is the
    // cheaper failure than double counting on a retry.
    console.error('[article-quota] increment failed after claim (non-fatal):', err.message);
  }
  return { ok: true, counted: true };
}

/**
 * Pre-run check for AI runs that may WRITE an uncounted document (chat, a
 * freeform agent run without auto-write intent). Without it a never-analyzed
 * draft could be written end to end by chat and never take a slot, so a Free
 * user could produce unlimited articles from blank drafts. Counted (or
 * legacy) documents pass untouched; the count itself happens on the first run
 * that actually writes (claimArticleSlot with enforce:false).
 */
async function checkPendingRoom(content) {
  if (!content || content.articleQuotaState !== 'pending') return { ok: true };
  return checkRoom(content.articleQuotaCtx || null);
}

module.exports = {
  claimArticleSlot,
  checkPendingRoom,
  quotaCtxFromReq,
  tierQuotaFromCtx,
  checkRoom,
  COUNTER_KEY,
};
