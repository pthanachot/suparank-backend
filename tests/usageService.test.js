const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Workspace = require('../src/models/Workspace');
const AgentUsageLog = require('../src/models/AgentUsageLog');
const usageService = require('../src/services/usageService');

const { ObjectId } = mongoose.Types;

// ─── Stubbed-model harness ───────────────────────────────────────

const originals = {
  wsFind: Workspace.find,
  logAggregate: AgentUsageLog.aggregate,
};

let state;

beforeEach(() => {
  state = {
    workspaces: [],
    aggregateRows: [],
    aggregateError: null,
    // query capture
    wsFindQuery: null,
    aggregatePipeline: null,
  };

  Workspace.find = (query) => {
    state.wsFindQuery = query;
    return { select: () => ({ lean: async () => state.workspaces }) };
  };

  AgentUsageLog.aggregate = async (pipeline) => {
    state.aggregatePipeline = pipeline;
    if (state.aggregateError) throw state.aggregateError;
    return state.aggregateRows;
  };
});

afterEach(() => {
  Workspace.find = originals.wsFind;
  AgentUsageLog.aggregate = originals.logAggregate;
});

// ─── aggregateWorkspaceUsage ─────────────────────────────────────

describe('usageService.aggregateWorkspaceUsage', () => {
  it('rejects a malformed period with status 400 (no lookups)', async () => {
    for (const bad of ['2026-13', '2026-00', '2026-6', '202606', 'garbage', '2026-06-01']) {
      await assert.rejects(
        () => usageService.aggregateWorkspaceUsage(new ObjectId(), bad),
        (err) => err.status === 400,
        `expected 400 for ${bad}`
      );
    }
    // never reached the DB on a bad period
    assert.equal(state.wsFindQuery, null);
    assert.equal(state.aggregatePipeline, null);
  });

  it('defaults to the current UTC month when no period is given', async () => {
    const now = new Date();
    const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const out = await usageService.aggregateWorkspaceUsage(new ObjectId());
    assert.equal(out.period, expected);
  });

  it('labels the payload as a token-based proxy (basis + note)', async () => {
    const out = await usageService.aggregateWorkspaceUsage(new ObjectId(), '2026-06');
    assert.equal(out.basis, 'tokens');
    assert.ok(/token-based proxy/i.test(out.note));
    assert.ok(/90-day/i.test(out.note));
    assert.ok(!/dollar cost\b(?!.*not)/i.test(out.note) || /not exact/i.test(out.note));
  });

  it('scopes the Workspace lookup to the org and bounds usage by the UTC month', async () => {
    const orgId = new ObjectId();
    state.workspaces = [{ _id: new ObjectId(), name: 'A', workspaceNumber: 100001 }];
    await usageService.aggregateWorkspaceUsage(orgId, '2026-06');

    assert.deepEqual(state.wsFindQuery, { organizationId: orgId });

    const match = state.aggregatePipeline[0].$match;
    assert.equal(match.createdAt.$gte.toISOString(), '2026-06-01T00:00:00.000Z');
    assert.equal(match.createdAt.$lt.toISOString(), '2026-07-01T00:00:00.000Z');
    // grouped by workspaceId
    assert.equal(state.aggregatePipeline[1].$group._id, '$workspaceId');
  });

  it('groups usage per workspace, sums tokens, and rolls up totals', async () => {
    const wsA = new ObjectId();
    const wsB = new ObjectId();
    const wsC = new ObjectId(); // no usage this period
    state.workspaces = [
      { _id: wsA, name: 'Acme', workspaceNumber: 100001 },
      { _id: wsB, name: 'Beta', workspaceNumber: 100002 },
      { _id: wsC, name: 'Gamma', workspaceNumber: 100003 },
    ];
    state.aggregateRows = [
      { _id: wsA, runs: 5, inputTokens: 1000, outputTokens: 400 },
      { _id: wsB, runs: 2, inputTokens: 300, outputTokens: 100 },
    ];

    const out = await usageService.aggregateWorkspaceUsage(new ObjectId(), '2026-06');

    assert.equal(out.workspaces.length, 3);

    const byId = Object.fromEntries(out.workspaces.map((w) => [String(w.workspaceId), w]));
    assert.deepEqual(
      { ...byId[String(wsA)], workspaceId: undefined },
      { workspaceId: undefined, workspaceName: 'Acme', workspaceNumber: 100001, runs: 5, inputTokens: 1000, outputTokens: 400, totalTokens: 1400 }
    );
    // zero-usage workspace still present, zeroed
    assert.deepEqual(
      { ...byId[String(wsC)], workspaceId: undefined },
      { workspaceId: undefined, workspaceName: 'Gamma', workspaceNumber: 100003, runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    );

    assert.deepEqual(out.totals, { runs: 7, inputTokens: 1300, outputTokens: 500, totalTokens: 1800 });

    // heaviest consumer first (cost-per-client ordering)
    assert.equal(String(out.workspaces[0].workspaceId), String(wsA));
  });

  it('empty org returns a zeroed shell (no aggregate call), still labelled', async () => {
    state.workspaces = [];
    const out = await usageService.aggregateWorkspaceUsage(new ObjectId(), '2026-06');
    assert.deepEqual(out.workspaces, []);
    assert.deepEqual(out.totals, { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(out.basis, 'tokens');
    // short-circuits before touching AgentUsageLog
    assert.equal(state.aggregatePipeline, null);
  });

  it('old period past the 90-day TTL aggregates to empty usage (workspaces zeroed)', async () => {
    state.workspaces = [{ _id: new ObjectId(), name: 'Acme', workspaceNumber: 100001 }];
    state.aggregateRows = []; // TTL pruned → nothing matches
    const out = await usageService.aggregateWorkspaceUsage(new ObjectId(), '2020-01');
    assert.equal(out.period, '2020-01');
    assert.equal(out.workspaces.length, 1);
    assert.equal(out.workspaces[0].totalTokens, 0);
    assert.deepEqual(out.totals, { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('a failing aggregation degrades to zeroed usage, never throws', async () => {
    state.workspaces = [{ _id: new ObjectId(), name: 'Acme', workspaceNumber: 100001 }];
    state.aggregateError = new Error('aggregate exploded');
    const out = await usageService.aggregateWorkspaceUsage(new ObjectId(), '2026-06');
    assert.equal(out.workspaces.length, 1);
    assert.equal(out.workspaces[0].totalTokens, 0);
    assert.equal(out.totals.totalTokens, 0);
  });
});
