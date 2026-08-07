/**
 * Phase 9 — the monthly report chain, end to end with stubbed seams:
 * paid-org scope → generate-if-missing → recipients → rotateShare →
 * templated email → reportEmailedAt dedupe marker → failure isolation.
 *
 * This is the cron's actual body (services/monthlyReportService) — the
 * inline index.js handler is a thin logging wrapper around it.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Subscription = require('../src/models/Subscription');
const ReportSnapshot = require('../src/models/ReportSnapshot');
const WorkspaceMember = require('../src/models/WorkspaceMember');
const Organization = require('../src/models/Organization');
const User = require('../src/models/User');
const Workspace = require('../src/models/Workspace');
const reportService = require('../src/services/reportService');
const domainService = require('../src/services/domainService');
const emailPortalController = require('../src/controllers/emailPortalController');
const emailService = require('../src/utils/emailService');
const job = require('../src/services/monthlyReportService');

function leanQuery(val) {
  return { select() { return this; }, lean: async () => val };
}

let state;
const origs = {
  subFind: Subscription.find,
  snapFindOne: ReportSnapshot.findOne,
  snapUpdateOne: ReportSnapshot.updateOne,
  wmFind: WorkspaceMember.find,
  orgFindById: Organization.findById,
  userFindById: User.findById,
  wsFind: Workspace.find,
  generateSnapshot: reportService.generateSnapshot,
  rotateShare: reportService.rotateShare,
  resolveBaseUrl: domainService.resolveBaseUrl,
  applyCustomTemplate: emailPortalController.applyCustomTemplate,
  sendEmail: emailService.sendEmail,
};

beforeEach(() => {
  state = {
    paidSubs: [{ organizationId: 'org1' }],
    subQuery: null,
    org: { _id: 'org1', ownerId: 'u1', name: 'Acme Agency' },
    workspaces: [{ _id: 'ws1', name: 'Client A' }],
    owner: { email: 'owner@agency.com' },
    clientMembers: [],
    snapshots: {}, // wsId → existing snapshot doc or undefined
    markerUpdates: [],
    generated: [],
    rotated: [],
    sent: [],
    templated: [],
    sendEmailImpl: async () => {},
    generateImpl: null, // override to throw per-workspace
    baseUrl: 'https://agency.example.com',
  };

  Subscription.find = (query) => {
    state.subQuery = query;
    return leanQuery(state.paidSubs);
  };
  Organization.findById = () => leanQuery(state.org);
  Workspace.find = () => leanQuery(state.workspaces);
  User.findById = () => leanQuery(state.owner);
  WorkspaceMember.find = () => leanQuery(state.clientMembers);
  ReportSnapshot.findOne = (q) => leanQuery(state.snapshots[String(q.workspaceId)] ?? null);
  ReportSnapshot.updateOne = async (filter, update) => {
    state.markerUpdates.push({ filter, update });
    return {};
  };
  reportService.generateSnapshot = async (wsId, period) => {
    if (state.generateImpl) return state.generateImpl(wsId, period);
    state.generated.push({ wsId: String(wsId), period });
    return { _id: `snap-${wsId}`, period };
  };
  reportService.rotateShare = async (reportId, opts) => {
    state.rotated.push({ reportId, opts });
    return { rawToken: `tok-${reportId}` };
  };
  domainService.resolveBaseUrl = async () => state.baseUrl;
  emailPortalController.applyCustomTemplate = async (key, options, orgId) => {
    state.templated.push({ key, orgId });
  };
  emailService.sendEmail = async (options) => {
    await state.sendEmailImpl(options);
    state.sent.push(options);
  };
});

afterEach(() => {
  Subscription.find = origs.subFind;
  ReportSnapshot.findOne = origs.snapFindOne;
  ReportSnapshot.updateOne = origs.snapUpdateOne;
  WorkspaceMember.find = origs.wmFind;
  Organization.findById = origs.orgFindById;
  User.findById = origs.userFindById;
  Workspace.find = origs.wsFind;
  reportService.generateSnapshot = origs.generateSnapshot;
  reportService.rotateShare = origs.rotateShare;
  domainService.resolveBaseUrl = origs.resolveBaseUrl;
  emailPortalController.applyCustomTemplate = origs.applyCustomTemplate;
  emailService.sendEmail = origs.sendEmail;
});

describe('runMonthlyReports — the full chain', () => {
  it('scopes to paid orgs only (query shape pinned)', async () => {
    await job.runMonthlyReports({ period: '2026-06' });
    assert.deepEqual(state.subQuery, {
      status: { $in: ['active', 'trialing'] },
      planId: { $ne: 'free' },
      organizationId: { $ne: null },
    });
  });

  it('generates, shares, emails owner + client members (deduped), then marks emailed', async () => {
    state.clientMembers = [
      { email: 'client@corp.com' },
      { email: 'owner@agency.com' }, // duplicate of the owner — must dedupe
    ];

    const r = await job.runMonthlyReports({ period: '2026-06' });

    // Generated because no snapshot existed
    assert.deepEqual(state.generated, [{ wsId: 'ws1', period: '2026-06' }]);
    // One rotated share, 90 days — the one-live-link invariant path
    assert.equal(state.rotated.length, 1);
    assert.equal(state.rotated[0].reportId, 'snap-ws1');
    assert.equal(state.rotated[0].opts.ttlDays, 90);
    // Two recipients (deduped), tenant-templated, correct payload
    assert.equal(state.sent.length, 2);
    assert.deepEqual(state.sent.map((s) => s.to).sort(), ['client@corp.com', 'owner@agency.com']);
    for (const s of state.sent) {
      assert.equal(s.orgId, 'org1');
      assert.equal(s.data.workspaceName, 'Client A');
      assert.equal(s.data.period, 'June 2026');
      assert.equal(s.data.reportUrl, 'https://agency.example.com/r/tok-snap-ws1');
    }
    assert.ok(state.templated.every((t) => t.key === 'monthly_report' && t.orgId === 'org1'));
    // Marker set exactly once
    assert.equal(state.markerUpdates.length, 1);
    assert.deepEqual(state.markerUpdates[0].filter, { _id: 'snap-ws1' });
    assert.ok(state.markerUpdates[0].update.$set.reportEmailedAt instanceof Date);
    // Counters
    assert.equal(r.generated, 1);
    assert.equal(r.emailed, 2);
    assert.equal(r.failures, 0);
  });

  it('skips a workspace whose snapshot is already emailed — nothing else runs', async () => {
    state.snapshots.ws1 = { _id: 'existing', reportEmailedAt: new Date('2026-07-01') };

    const r = await job.runMonthlyReports({ period: '2026-06' });

    assert.equal(state.generated.length, 0);
    assert.equal(state.rotated.length, 0);
    assert.equal(state.sent.length, 0);
    assert.equal(state.markerUpdates.length, 0);
    assert.equal(r.skippedAlreadyEmailed, 1);
  });

  it('a manually generated snapshot (marker null) STILL gets its monthly email', async () => {
    state.snapshots.ws1 = { _id: 'manual-snap', reportEmailedAt: null };

    await job.runMonthlyReports({ period: '2026-06' });

    // Not regenerated — the manual snapshot is used as-is
    assert.equal(state.generated.length, 0);
    assert.equal(state.rotated[0].reportId, 'manual-snap');
    assert.equal(state.sent.length, 1); // owner
    assert.deepEqual(state.markerUpdates[0].filter, { _id: 'manual-snap' });
  });

  it('no recipients → marker set so the workspace is never re-checked forever', async () => {
    state.owner = null; // ownerless org edge

    await job.runMonthlyReports({ period: '2026-06' });

    assert.equal(state.rotated.length, 0, 'no share minted for nobody');
    assert.equal(state.sent.length, 0);
    assert.equal(state.markerUpdates.length, 1, 'marked done');
  });

  it('total email outage leaves the marker null (retry next run); partial failure sets it', async () => {
    state.clientMembers = [{ email: 'client@corp.com' }];

    // Total outage: every send throws
    state.sendEmailImpl = async () => {
      throw new Error('smtp down');
    };
    let r = await job.runMonthlyReports({ period: '2026-06' });
    assert.equal(state.markerUpdates.length, 0, 'nothing sent → no marker → retried next run');
    assert.equal(r.emailed, 0);
    assert.equal(r.failures, 0, 'email failures are per-recipient, not workspace failures');

    // Partial: first recipient fails, second succeeds
    state.markerUpdates = [];
    state.generated = [];
    let call = 0;
    state.sendEmailImpl = async () => {
      call++;
      if (call === 1) throw new Error('bounce');
    };
    r = await job.runMonthlyReports({ period: '2026-06' });
    assert.equal(r.emailed, 1);
    assert.equal(state.markerUpdates.length, 1, 'one delivery is enough to mark');
  });

  it('one workspace failing never sinks its siblings (per-workspace isolation)', async () => {
    state.workspaces = [
      { _id: 'ws-bad', name: 'Exploding Client' },
      { _id: 'ws-good', name: 'Healthy Client' },
    ];
    state.generateImpl = async (wsId, period) => {
      if (String(wsId) === 'ws-bad') throw new Error('aggregation blew up');
      state.generated.push({ wsId: String(wsId), period });
      return { _id: `snap-${wsId}`, period };
    };

    const r = await job.runMonthlyReports({ period: '2026-06' });

    assert.equal(r.failures, 1);
    assert.deepEqual(state.generated, [{ wsId: 'ws-good', period: '2026-06' }]);
    assert.equal(state.sent.length, 1, 'the healthy workspace still emailed');
    assert.deepEqual(state.markerUpdates[0].filter, { _id: 'snap-ws-good' });
  });

  it('returns zeroed counters when there are no paid orgs', async () => {
    state.paidSubs = [];
    const r = await job.runMonthlyReports({ period: '2026-06' });
    assert.equal(r.orgs, 0);
    assert.equal(r.workspacesProcessed, 0);
  });
});
