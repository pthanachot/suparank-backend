/**
 * Phase 19 — agency console aggregation (agencyConsoleService).
 *
 * Verifies MRR normalisation (year→month, cents, multi-currency, billed-only),
 * one-primary-sub-per-workspace collapse (no double-count), status derivation
 * (org lifecycle > lock > billing), usage/credit-cap join, summary rollup, and
 * the overview credit balance. Models/services monkey-patched; no DB.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/agencyConsoleService');
const ClientSubscription = require('../src/models/ClientSubscription');
const AgencyPlan = require('../src/models/AgencyPlan');
const Workspace = require('../src/models/Workspace');
const WorkspaceUsageTracker = require('../src/models/WorkspaceUsageTracker');
const Organization = require('../src/models/Organization');
const ReportSnapshot = require('../src/models/ReportSnapshot');
const ReportShare = require('../src/models/ReportShare');
const creditService = require('../src/services/creditService');

function leanQuery(val) {
  return { select() { return this; }, sort() { return this; }, lean: async () => val };
}

let subs, plans, workspaces, usage, orgLifecycle, balance;
let reportAggRows, shareRows, reportAggError, reportAggPipeline;
const origs = {};

beforeEach(() => {
  subs = []; plans = []; workspaces = []; usage = []; orgLifecycle = 'active';
  balance = { subscription: 100, general: 50, total: 150, expiresAt: null };
  // Phase 8 latest-report join fixtures
  reportAggRows = []; shareRows = []; reportAggError = null;

  origs.csFind = ClientSubscription.find;
  origs.planFind = AgencyPlan.find;
  origs.wsFind = Workspace.find;
  origs.utFind = WorkspaceUsageTracker.find;
  origs.orgFindById = Organization.findById;
  origs.getBalance = creditService.getBalance;
  origs.snapAggregate = ReportSnapshot.aggregate;
  origs.shareFind = ReportShare.find;

  ClientSubscription.find = () => leanQuery(subs);
  AgencyPlan.find = () => leanQuery(plans);
  Workspace.find = () => leanQuery(workspaces);
  WorkspaceUsageTracker.find = () => leanQuery(usage);
  Organization.findById = () => leanQuery({ _id: 'org1', name: 'Acme', lifecycleStatus: orgLifecycle });
  creditService.getBalance = async () => balance;
  reportAggPipeline = null;
  ReportSnapshot.aggregate = async (pipeline) => {
    reportAggPipeline = pipeline;
    if (reportAggError) throw reportAggError;
    return reportAggRows;
  };
  ReportShare.find = () => leanQuery(shareRows);
});

afterEach(() => {
  ClientSubscription.find = origs.csFind; AgencyPlan.find = origs.planFind;
  Workspace.find = origs.wsFind; WorkspaceUsageTracker.find = origs.utFind;
  Organization.findById = origs.orgFindById; creditService.getBalance = origs.getBalance;
  ReportSnapshot.aggregate = origs.snapAggregate; ReportShare.find = origs.shareFind;
});

const plan = (o) => ({ _id: 'pl1', name: 'Starter', amount: 4900, currency: 'usd', interval: 'month', limits: { creditsPerMonth: 1000 }, ...o });
const sub = (o) => ({ _id: 's1', workspaceId: 'ws1', organizationId: 'org1', agencyPlanId: 'pl1', status: 'active', clientEmail: 'c@x.co', cancelAtPeriodEnd: false, createdAt: new Date('2026-01-01'), ...o });
const ws = (o) => ({ _id: 'ws1', workspaceNumber: 7, name: 'Client A', clientLocked: false, ...o });

describe('_monthlyCents', () => {
  it('passes monthly through, divides yearly by 12, 0 for no plan', () => {
    assert.equal(svc._monthlyCents({ amount: 4900, interval: 'month' }), 4900);
    assert.equal(svc._monthlyCents({ amount: 12000, interval: 'year' }), 1000);
    assert.equal(svc._monthlyCents(null), 0);
  });
});

describe('getClientRoster', () => {
  it('joins plan + workspace + usage into a client row with normalised MRR', async () => {
    subs = [sub()]; plans = [plan()]; workspaces = [ws()];
    usage = [{ workspaceId: 'ws1', creditsUsed: 120, articlesCreated: 3 }];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients.length, 1);
    const c = r.clients[0];
    assert.equal(c.workspaceName, 'Client A');
    assert.equal(c.plan.name, 'Starter');
    assert.equal(c.mrrCents, 4900);
    assert.equal(c.status, 'active');
    assert.equal(c.creditsLimit, 1000);
    assert.equal(c.usage.creditsUsed, 120);
    assert.deepEqual(r.summary.mrrByCurrency, { usd: 4900 });
    assert.equal(r.summary.activeClients, 1);
  });

  it('does NOT count a canceled sub toward MRR, and marks it canceled', async () => {
    subs = [sub({ status: 'canceled' })]; plans = [plan()]; workspaces = [ws()];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].mrrCents, 0);
    assert.equal(r.clients[0].hasAccess, false);
    assert.deepEqual(r.summary.mrrByCurrency, {});
    assert.equal(r.summary.canceledClients, 1);
    assert.equal(r.summary.activeClients, 0);
  });

  it('a TRIAL has access but contributes $0 MRR (trials pay nothing)', async () => {
    subs = [sub({ status: 'trialing' })]; plans = [plan()]; workspaces = [ws()];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].hasAccess, true, 'trial can use the workspace');
    assert.equal(r.clients[0].mrrCents, 0, 'trial books no MRR');
    assert.deepEqual(r.summary.mrrByCurrency, {});
    assert.equal(r.summary.activeClients, 1, 'counts as an active (has-access) client');
    assert.equal(r.summary.trialingClients, 1);
  });

  it('a PAYING client whose plan was deleted is flagged unpriced (counts + MRR never disagree)', async () => {
    subs = [sub({ status: 'active', agencyPlanId: 'gone' })]; plans = []; workspaces = [ws()];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].hasAccess, true);
    assert.equal(r.clients[0].unpriced, true);
    assert.equal(r.clients[0].mrrCents, 0);
    assert.deepEqual(r.summary.mrrByCurrency, {}, 'cannot price → no phantom MRR');
    assert.equal(r.summary.activeClients, 1);
    assert.equal(r.summary.unpricedClients, 1, 'the active-but-$0 gap is explicit');
  });

  it('collapses multiple subs for one workspace to a single primary (no double MRR)', async () => {
    // an old canceled sub + a current active sub on the SAME workspace
    subs = [
      sub({ _id: 'sold', status: 'canceled', createdAt: new Date('2026-01-01') }),
      sub({ _id: 'snew', status: 'active', createdAt: new Date('2026-06-01') }),
    ];
    plans = [plan()]; workspaces = [ws()];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients.length, 1, 'one row per workspace');
    assert.equal(r.clients[0].subStatus, 'active', 'billed sub wins as primary');
    assert.equal(r.summary.mrrByCurrency.usd, 4900, 'MRR counted once');
  });

  it('groups MRR by currency, never summing across them', async () => {
    subs = [sub({ workspaceId: 'ws1', agencyPlanId: 'pl1' }), sub({ _id: 's2', workspaceId: 'ws2', agencyPlanId: 'pl2' })];
    plans = [plan(), plan({ _id: 'pl2', currency: 'eur', amount: 3000 })];
    workspaces = [ws(), ws({ _id: 'ws2', name: 'Client B' })];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.deepEqual(r.summary.mrrByCurrency, { usd: 4900, eur: 3000 });
  });

  it('yearly plan normalises to a monthly MRR figure', async () => {
    subs = [sub()]; plans = [plan({ interval: 'year', amount: 60000 })]; workspaces = [ws()];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].mrrCents, 5000); // 60000/12
  });

  it('client status is its OWN (not the agency lifecycle); lock > past_due > canceling', async () => {
    // The AGENCY winding down must NOT relabel a healthy client's status.
    subs = [sub()]; plans = [plan()]; workspaces = [ws()]; orgLifecycle = 'winding_down';
    let r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].status, 'active', 'client keeps its own status');

    orgLifecycle = 'active';
    workspaces = [ws({ clientLocked: true })];
    r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].status, 'locked', 'lock wins');

    workspaces = [ws()];
    subs = [sub({ status: 'past_due', cancelAtPeriodEnd: true })];
    r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].status, 'past_due', 'urgent billing outranks canceling');

    subs = [sub({ status: 'active', cancelAtPeriodEnd: true })];
    r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].status, 'canceling');
    assert.equal(r.clients[0].mrrCents, 4900, 'still billed until period end');
  });

  it('empty org → empty roster + zeroed summary', async () => {
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.deepEqual(r.clients, []);
    assert.equal(r.summary.totalClients, 0);
    assert.deepEqual(r.summary.mrrByCurrency, {});
  });

  it('tolerates a missing workspace/plan (post-cleanup) without crashing', async () => {
    subs = [sub({ agencyPlanId: null })]; plans = []; workspaces = [];
    const r = await svc.getClientRoster('org1', '2026-07');
    assert.equal(r.clients[0].workspaceName, null);
    assert.equal(r.clients[0].plan, null);
    assert.equal(r.clients[0].mrrCents, 0);
  });
});

describe('getAgencyOverview', () => {
  it('folds the roster summary + org credit balance + lifecycle', async () => {
    subs = [sub()]; plans = [plan()]; workspaces = [ws()];
    const o = await svc.getAgencyOverview('org1', '2026-07');
    assert.equal(o.clients.active, 1);
    assert.deepEqual(o.mrrByCurrency, { usd: 4900 });
    assert.equal(o.credits.total, 150);
    assert.equal(o.organization.name, 'Acme');
  });

  it('survives a credit-balance lookup failure (credits → null)', async () => {
    creditService.getBalance = async () => { throw new Error('down'); };
    const o = await svc.getAgencyOverview('org1', '2026-07');
    assert.equal(o.credits, null);
  });
});

// ─── Phase 8: latest-report join ─────────────────────────────────

describe('getClientRoster latestReport (Phase 8)', () => {
  it('joins the newest snapshot headline + live-share flag per workspace', async () => {
    subs = [sub(), sub({ _id: 's2', workspaceId: 'ws2', clientEmail: 'b@x.co' })];
    plans = [plan()];
    workspaces = [ws(), ws({ _id: 'ws2', workspaceNumber: 8, name: 'Client B' })];
    reportAggRows = [
      {
        _id: 'ws1',
        reportId: 'r1',
        period: '2026-06',
        generatedAt: new Date('2026-07-01T03:30:00Z'),
        latest: { visibility: 62, mentionRate: 70, shareOfVoice: 40 },
      },
    ];
    shareRows = [{ reportId: 'r1' }];

    const roster = await svc.getClientRoster('org1', '2026-07');
    const a = roster.clients.find((c) => c.workspaceId === 'ws1');
    const b = roster.clients.find((c) => c.workspaceId === 'ws2');

    assert.deepEqual(a.latestReport, {
      period: '2026-06',
      generatedAt: new Date('2026-07-01T03:30:00Z'),
      visibility: 62,
      shareOfVoice: 40,
      hasShare: true,
    });
    // No snapshot ever generated → explicit null, not a throw
    assert.equal(b.latestReport, null);
  });

  it('the aggregation projects slim rows BEFORE sorting (memory-safety shape)', async () => {
    subs = [sub()];
    plans = [plan()];
    workspaces = [ws()];

    await svc.getClientRoster('org1', '2026-07');

    const stages = reportAggPipeline.map((s) => Object.keys(s)[0]);
    // $project must precede $sort — $sort buffers whole docs, and
    // snapshot.data carries the full enriched report.
    assert.deepEqual(stages, ['$match', '$project', '$sort', '$group']);
    assert.deepEqual(reportAggPipeline[0].$match.workspaceId, { $in: ['ws1'] });
    // The projection maps the headline out of data and passes data itself no further
    assert.equal(reportAggPipeline[1].$project.latest, '$data.tracker.latest');
    assert.equal(reportAggPipeline[1].$project.data, undefined);
  });

  it('a snapshot with no tracker data yields null metrics, not NaN', async () => {
    subs = [sub()];
    plans = [plan()];
    workspaces = [ws()];
    reportAggRows = [
      { _id: 'ws1', reportId: 'r1', period: '2026-06', generatedAt: null, latest: null },
    ];

    const roster = await svc.getClientRoster('org1', '2026-07');
    const a = roster.clients[0];
    assert.equal(a.latestReport.visibility, null);
    assert.equal(a.latestReport.shareOfVoice, null);
    assert.equal(a.latestReport.hasShare, false);
  });

  it('a report-side failure degrades to latestReport null — the billing roster survives', async () => {
    subs = [sub()];
    plans = [plan()];
    workspaces = [ws()];
    reportAggError = new Error('reports collection unavailable');

    const roster = await svc.getClientRoster('org1', '2026-07');
    assert.equal(roster.clients.length, 1);
    assert.equal(roster.clients[0].latestReport, null);
    // Billing fields intact
    assert.equal(roster.clients[0].mrrCents, 4900);
  });
});
