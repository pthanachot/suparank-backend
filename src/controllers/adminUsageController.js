'use strict';

/**
 * Admin usage-analytics endpoints (Wave 4, plan §7 dashboard v1).
 * Mounted admin-gated in adminRoutes. Thin: all math lives in
 * usageAnalyticsService; these parse inputs and shape errors.
 *
 * Wave 5 Phase 2: each endpoint accepts either `days` (back-compat) or an
 * explicit `from`/`to` ISO pair. Range validation lives in the service so the
 * horizon rules are applied identically everywhere; a RangeError from it means
 * the caller asked for something impossible and gets a 400 rather than a
 * silent fallback to the default window.
 */

const usageAnalytics = require('../services/usageAnalyticsService');
const conversionAnalytics = require('../services/conversionAnalyticsService');
const retentionAnalytics = require('../services/retentionAnalyticsService');
const contentChoices = require('../services/contentChoicesService');

/** Only forward a query param when it was actually supplied. */
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function rangeArgs(query) {
  return { days: query.days, from: str(query.from), to: str(query.to) };
}

function fail(res, err, label) {
  if (err instanceof RangeError) return res.status(400).json({ error: err.message });
  console.error(`[admin-usage] ${label} error:`, err.message);
  return res.status(500).json({ error: `Failed to compute usage ${label}` });
}

async function getUsageOverview(req, res) {
  try {
    res.json(await usageAnalytics.getOverview(rangeArgs(req.query)));
  } catch (err) {
    fail(res, err, 'overview');
  }
}

async function getUsageFunnels(req, res) {
  try {
    res.json(await usageAnalytics.getFunnels(rangeArgs(req.query)));
  } catch (err) {
    fail(res, err, 'funnels');
  }
}

async function getUsageSeries(req, res) {
  try {
    res.json(await usageAnalytics.getSeries({ ...rangeArgs(req.query), event: str(req.query.event) ?? null }));
  } catch (err) {
    fail(res, err, 'series');
  }
}

async function getUsageConversion(req, res) {
  try {
    res.json(await conversionAnalytics.getConversion(rangeArgs(req.query)));
  } catch (err) {
    fail(res, err, 'conversion');
  }
}

async function getUsageRetention(req, res) {
  try {
    // Retention is week-denominated and reads the no-TTL rollup, so it takes a
    // week count rather than the shared day range.
    res.json(await retentionAnalytics.getRetention({ weeks: req.query.weeks }));
  } catch (err) {
    fail(res, err, 'retention');
  }
}

async function getUsageContent(req, res) {
  try {
    // No range: this reports product state (what exists), not a TTL'd event
    // stream, so every article counts regardless of when it was created.
    res.json(await contentChoices.getContentChoices());
  } catch (err) {
    fail(res, err, 'content');
  }
}

module.exports = {
  getUsageOverview, getUsageFunnels, getUsageSeries,
  getUsageConversion, getUsageRetention, getUsageContent,
};
