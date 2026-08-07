/**
 * Phase 2 (client reports) — per-calendar-month GSC rows.
 *
 * Targets:
 *   - _periodDateRange: month bounds, GSC data-lag clamping, not-yet-
 *     queryable months, partial-month semantics.
 *   - _upsertPeriodStats: previous + current month upserts, ctr percent
 *     conversion, topQueries mapping, range-dependent data isolation
 *     (June ≠ July), skip-when-no-window.
 *   - refreshSiteStats: persistData === false writes NOTHING (snapshot or
 *     period rows).
 *   - sweepDueSiteStats: due-window query shape + per-site refresh fan-out
 *     (the Flaw-2 fix: rows must appear without Sites-page visits).
 *
 * Run: node --test tests/gscPeriodStats.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Site = require('../src/models/Site');
const GscConnection = require('../src/models/GscConnection');
const GscPeriodStat = require('../src/models/GscPeriodStat');
const gscService = require('../src/services/gscService');

const { ObjectId } = mongoose.Types;

// ─── _periodDateRange ────────────────────────────────────────────

describe('gscService._periodDateRange', () => {
  // GSC_DATA_LAG_DAYS = 3 — freshest queryable day is now - 3d.
  const now = new Date('2026-08-07T12:00:00Z');

  it('clamps the in-progress month to the data lag (partial row)', () => {
    const range = gscService._periodDateRange('2026-08', now);
    assert.deepEqual(range, { startDate: '2026-08-01', endDate: '2026-08-04' });
  });

  it('covers a fully-elapsed month end to end', () => {
    const range = gscService._periodDateRange('2026-07', now);
    assert.deepEqual(range, { startDate: '2026-07-01', endDate: '2026-07-31' });
  });

  it('returns null while a month has no queryable days yet', () => {
    // Aug 2 minus 3d lag → freshest is Jul 30, before Aug 1
    const early = new Date('2026-08-02T00:00:00Z');
    assert.equal(gscService._periodDateRange('2026-08', early), null);
  });

  it('previous month stays partial until the lag passes month end (self-heal window)', () => {
    // Sep 2 minus 3d → Aug 30: the August row misses Aug 31 until Sep 3+
    const sep2 = new Date('2026-09-02T00:00:00Z');
    const range = gscService._periodDateRange('2026-08', sep2);
    assert.deepEqual(range, { startDate: '2026-08-01', endDate: '2026-08-30' });
  });

  it('rejects malformed periods with null', () => {
    for (const bad of ['2026-8', 'garbage', '', null, undefined]) {
      assert.equal(gscService._periodDateRange(bad, now), null, `expected null for: ${bad}`);
    }
  });
});

// ─── _upsertPeriodStats ──────────────────────────────────────────

describe('gscService._upsertPeriodStats', () => {
  const origFindOneAndUpdate = GscPeriodStat.findOneAndUpdate;
  let upserts;
  let site;

  beforeEach(() => {
    upserts = [];
    GscPeriodStat.findOneAndUpdate = async (filter, update, opts) => {
      upserts.push({ filter, update, opts });
      return {};
    };
    site = {
      _id: new ObjectId(),
      workspaceId: new ObjectId(),
      organizationId: new ObjectId(),
      gscPropertyId: 'sc-domain:acme.com',
    };
  });

  afterEach(() => {
    GscPeriodStat.findOneAndUpdate = origFindOneAndUpdate;
  });

  /** Query stub: totals + top-queries rows derived from the start month so
      each period gets distinct, recognizable numbers. */
  function monthKeyedQuery(orgId, propertyId, params) {
    const month = Number(params.startDate.split('-')[1]);
    if (params.dimensions.length === 0) {
      return Promise.resolve({
        rows: [{ clicks: month * 100, impressions: month * 1000, ctr: 0.0234, position: 7.25 }],
      });
    }
    return Promise.resolve({
      rows: [
        { keys: [`kw-${month}`], clicks: month, impressions: month * 10, ctr: 0.05, position: 3.14159 },
      ],
    });
  }

  it('upserts previous + current month with distinct period-scoped data', async () => {
    const now = new Date('2026-08-07T12:00:00Z');
    await gscService._upsertPeriodStats(site, { now, query: monthKeyedQuery });

    assert.equal(upserts.length, 2);
    const july = upserts.find((u) => u.filter.period === '2026-07');
    const august = upserts.find((u) => u.filter.period === '2026-08');
    assert.ok(july && august, 'both months must upsert');

    // Filter is the {siteId, period} unique key; upsert: true
    assert.equal(String(july.filter.siteId), String(site._id));
    assert.equal(july.opts.upsert, true);

    // June ≠ July isolation: each row carries ITS month's data
    assert.equal(july.update.$set.clicks, 700);
    assert.equal(august.update.$set.clicks, 800);
    assert.notEqual(july.update.$set.clicks, august.update.$set.clicks);

    // ctr percent conversion (snapshotStats parity) + position rounding
    assert.equal(july.update.$set.ctr, 2.34);
    assert.equal(july.update.$set.position, 7.3);

    // topQueries mapped from API rows
    assert.deepEqual(july.update.$set.topQueries, [
      { query: 'kw-7', clicks: 7, impressions: 70, ctr: 5, position: 3.1 },
    ]);

    // Ranges persisted: July complete, August clamped to the lag (partial)
    assert.equal(july.update.$set.rangeStart, '2026-07-01');
    assert.equal(july.update.$set.rangeEnd, '2026-07-31');
    assert.equal(august.update.$set.rangeEnd, '2026-08-04');

    // Join keys land in $set so an upserted row is fully populated
    assert.equal(String(july.update.$set.workspaceId), String(site.workspaceId));
    assert.equal(String(july.update.$set.organizationId), String(site.organizationId));
  });

  it('skips a month with no queryable window instead of writing an empty row', async () => {
    // Aug 2: current month not yet queryable (lag), only July lands
    const now = new Date('2026-08-02T00:00:00Z');
    await gscService._upsertPeriodStats(site, { now, query: monthKeyedQuery });

    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].filter.period, '2026-07');
  });

  it('defaults empty API responses to zeroed totals', async () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const emptyQuery = () => Promise.resolve({ rows: [] });
    await gscService._upsertPeriodStats(site, { now, query: emptyQuery });

    assert.equal(upserts.length, 2);
    for (const u of upserts) {
      assert.equal(u.update.$set.clicks, 0);
      assert.equal(u.update.$set.impressions, 0);
      assert.deepEqual(u.update.$set.topQueries, []);
    }
  });
});

// ─── refreshSiteStats: persistData opt-out ───────────────────────

describe('gscService.refreshSiteStats persistData opt-out', () => {
  const origSiteFindById = Site.findById;
  const origSiteUpdateOne = Site.updateOne;
  const origConnFindOne = GscConnection.findOne;
  const origPeriodUpsert = GscPeriodStat.findOneAndUpdate;

  afterEach(() => {
    Site.findById = origSiteFindById;
    Site.updateOne = origSiteUpdateOne;
    GscConnection.findOne = origConnFindOne;
    GscPeriodStat.findOneAndUpdate = origPeriodUpsert;
  });

  it('writes NOTHING when the org opted out of data persistence', async () => {
    const siteId = new ObjectId();
    let siteWrites = 0;
    let periodWrites = 0;

    Site.findById = async () => ({
      _id: siteId,
      organizationId: new ObjectId(),
      workspaceId: new ObjectId(),
      gscPropertyId: 'sc-domain:acme.com',
    });
    GscConnection.findOne = async () => ({ persistData: false });
    Site.updateOne = async () => {
      siteWrites++;
      return {};
    };
    GscPeriodStat.findOneAndUpdate = async () => {
      periodWrites++;
      return {};
    };

    await gscService.refreshSiteStats(siteId);

    assert.equal(siteWrites, 0, 'snapshotStats must not be written');
    assert.equal(periodWrites, 0, 'period rows must not be written');
  });
});

// ─── sweepDueSiteStats (cron fan-out) ────────────────────────────

describe('gscService.sweepDueSiteStats', () => {
  const origSiteFind = Site.find;
  const origRefresh = gscService.refreshSiteStats;

  afterEach(() => {
    Site.find = origSiteFind;
    gscService.refreshSiteStats = origRefresh;
  });

  it('refreshes every due site and reports counts', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    let capturedFilter = null;
    Site.find = (filter) => {
      capturedFilter = filter;
      return { select: () => ({ lean: async () => [{ _id: a }, { _id: b }] }) };
    };
    const refreshed = [];
    gscService.refreshSiteStats = async (id) => {
      refreshed.push(String(id));
    };

    const now = new Date('2026-08-07T03:00:00Z');
    const result = await gscService.sweepDueSiteStats({ now });

    assert.deepEqual(result, { due: 2, refreshed: 2 });
    assert.deepEqual(refreshed.sort(), [String(a), String(b)].sort());

    // Due-window query: verified GSC sites only, per-site frequency windows.
    // Windows carry a 1h tolerance — yesterday's sweep stamps lastSyncAt
    // minutes AFTER the fixed tick, so a strict 24h/7d window would skip
    // every other beat ("daily" degrading to every-other-day).
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;
    assert.equal(capturedFilter.verified, true);
    assert.deepEqual(capturedFilter.gscPropertyId, { $ne: null });
    assert.equal(capturedFilter.$or.length, 3);
    const [never, weekly, daily] = capturedFilter.$or;
    assert.deepEqual(never, { lastSyncAt: null });
    assert.equal(weekly.syncFrequency, 'weekly');
    assert.equal(
      weekly.lastSyncAt.$lte.toISOString(),
      new Date(now.getTime() - (7 * dayMs - hourMs)).toISOString()
    );
    assert.deepEqual(daily.syncFrequency, { $ne: 'weekly' });
    assert.equal(
      daily.lastSyncAt.$lte.toISOString(),
      new Date(now.getTime() - (dayMs - hourMs)).toISOString()
    );
  });

  it('tolerance regression: a site stamped minutes after yesterday\'s tick is due today', () => {
    // Pure window math: yesterday 03:05 vs today's 03:00 tick. The strict
    // 24h cutoff (02:00 today... i.e. tick - 24h) would exclude it.
    const tick = new Date('2026-08-07T03:00:00Z');
    const stampedYesterday = new Date('2026-08-06T03:05:00Z');
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;
    const strictCutoff = new Date(tick.getTime() - dayMs);
    const tolerantCutoff = new Date(tick.getTime() - (dayMs - hourMs));
    assert.ok(stampedYesterday > strictCutoff, 'strict window would skip the site');
    assert.ok(stampedYesterday <= tolerantCutoff, 'tolerant window catches it');
  });

  it('a failing per-site refresh does not sink the sweep', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    Site.find = () => ({ select: () => ({ lean: async () => [{ _id: a }, { _id: b }] }) });
    gscService.refreshSiteStats = async (id) => {
      if (String(id) === String(a)) throw new Error('vendor down');
    };

    const result = await gscService.sweepDueSiteStats({ now: new Date() });
    assert.deepEqual(result, { due: 2, refreshed: 1 });
  });
});
