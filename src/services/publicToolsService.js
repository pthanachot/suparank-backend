/**
 * publicToolsService — shared plumbing for the free marketing tools
 * (/api/public/tools/*): result caching, per-IP daily rate counters, and the
 * daily budget kill-switch backed by AiCostLedger.
 *
 * Cost gates, in order (see publicToolsGuard middleware):
 *   1. cache hit  -> $0
 *   2. IP daily cap -> bounded worst case per visitor
 *   3. daily budget -> bounded worst case per day, tools degrade instead of erroring
 */
const crypto = require('crypto');
const PublicToolCache = require('../models/PublicToolCache');
const PublicToolUsage = require('../models/PublicToolUsage');
const AiCostLedger = require('../models/AiCostLedger');

/** All ledger rows written by public tools use this action prefix. */
const LEDGER_ACTION = 'public_tool';

/** Normalize free-text input into a stable cache key. */
function cacheKeyFor(toolId, input) {
  const normalized = JSON.stringify(input, Object.keys(input).sort())
    .toLowerCase()
    .trim();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `${toolId}:v1:${hash}`;
}

async function getCached(toolId, input) {
  const row = await PublicToolCache.findOne({
    cacheKey: cacheKeyFor(toolId, input),
    expiresAt: { $gt: new Date() },
  }).lean();
  return row ? row.payload : null;
}

/** Mongo upserts can race (E11000) when two identical first-requests land
 *  concurrently — retry once; the second attempt matches the winner's row. */
async function retryOnDuplicate(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.code === 11000) return fn();
    throw err;
  }
}

async function setCached(toolId, input, payload, ttlSeconds) {
  const cacheKey = cacheKeyFor(toolId, input);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await retryOnDuplicate(() =>
    PublicToolCache.updateOne(
      { cacheKey },
      { $set: { toolId, payload, expiresAt } },
      { upsert: true }
    )
  );
}

/**
 * Atomically increment the caller's daily counter for a tool.
 * Returns { allowed, remaining }. Counter rows self-expire after 48h.
 */
async function consumeRateLimit(ip, toolId, maxPerDay) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${toolId}:${day}`;
  const row = await retryOnDuplicate(() =>
    PublicToolUsage.findOneAndUpdate(
      { key },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(Date.now() + 48 * 3600 * 1000) },
      },
      { upsert: true, new: true }
    ).lean()
  );
  const allowed = row.count <= maxPerDay;
  return { allowed, remaining: Math.max(0, maxPerDay - row.count) };
}

/** Give back one consumed check — used when the tool itself failed (all
 *  engine calls errored), so provider outages don't burn visitors' allowance. */
async function refundRateLimit(ip, toolId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${toolId}:${day}`;
  await PublicToolUsage.updateOne({ key, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

/** USD spent by public tools since UTC midnight (AiCostLedger ground truth). */
async function budgetSpentTodayUsd() {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await AiCostLedger.aggregate([
    { $match: { action: LEDGER_ACTION, createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$costUsd' } } },
  ]);
  return rows.length ? rows[0].total : 0;
}

function dailyBudgetUsd() {
  const raw = Number(process.env.PUBLIC_TOOLS_DAILY_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 10; // default $10/day
}

/** True when today's public-tool spend has hit the cap.
 *  Memoized for 60s — this runs on every guarded request AND the public
 *  /status endpoint, and the ledger aggregate doesn't need to be real-time. */
let budgetMemo = { at: 0, value: false };
async function budgetExhausted() {
  const now = Date.now();
  if (now - budgetMemo.at < 60_000) return budgetMemo.value;
  const spent = await budgetSpentTodayUsd();
  budgetMemo = { at: now, value: spent >= dailyBudgetUsd() };
  return budgetMemo.value;
}

module.exports = {
  LEDGER_ACTION,
  cacheKeyFor,
  getCached,
  setCached,
  consumeRateLimit,
  refundRateLimit,
  budgetSpentTodayUsd,
  dailyBudgetUsd,
  budgetExhausted,
};
