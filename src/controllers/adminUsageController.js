'use strict';

/**
 * Admin usage-analytics endpoints (Wave 4, plan §7 dashboard v1).
 * Mounted admin-gated in adminRoutes. Thin: all math lives in
 * usageAnalyticsService; these clamp inputs and shape errors.
 */

const usageAnalytics = require('../services/usageAnalyticsService');

const clampDays = (raw) => Math.min(90, Math.max(1, parseInt(raw, 10) || 28));

async function getUsageOverview(req, res) {
  try {
    res.json(await usageAnalytics.getOverview({ days: clampDays(req.query.days) }));
  } catch (err) {
    console.error('[admin-usage] overview error:', err.message);
    res.status(500).json({ error: 'Failed to compute usage overview' });
  }
}

async function getUsageFunnels(req, res) {
  try {
    res.json(await usageAnalytics.getFunnels({ days: clampDays(req.query.days) }));
  } catch (err) {
    console.error('[admin-usage] funnels error:', err.message);
    res.status(500).json({ error: 'Failed to compute usage funnels' });
  }
}

async function getUsageSeries(req, res) {
  try {
    const event = typeof req.query.event === 'string' && req.query.event ? req.query.event : null;
    res.json(await usageAnalytics.getSeries({ days: clampDays(req.query.days), event }));
  } catch (err) {
    console.error('[admin-usage] series error:', err.message);
    res.status(500).json({ error: 'Failed to compute usage series' });
  }
}

module.exports = { getUsageOverview, getUsageFunnels, getUsageSeries };
