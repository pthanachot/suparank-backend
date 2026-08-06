/**
 * Phase 8 — cross-tenant probes (Phase-20 discipline, controller-level).
 *
 * Two fully-seeded tenants; every probe drives a REAL handler with tenant
 * B's workspace context and tenant A's resource ids, then asserts: 404 (or
 * scoped no-op), ZERO leaked A-data in the response body, and A's documents
 * untouched. Probe names here must match TENANCY_COVERAGE in
 * helpers/securityCoverage.js — the completeness test cross-checks.
 *
 * Run: node --test tests/aiTracker/security-tenancy.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';

const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const AiTrackerCompetitor = require('../../src/models/AiTrackerCompetitor');
const Content = require('../../src/models/Content');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

let wsCounter = 997000;

function makeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

/** Assert a response carries no fingerprint of tenant A's data. */
function assertNoLeak(res, fingerprints) {
  const body = JSON.stringify(res.body ?? {});
  for (const fp of fingerprints) {
    assert.ok(!body.includes(fp), `tenant-A data leaked in response: ${fp} in ${body.slice(0, 200)}`);
  }
}

async function seedTenant(tag) {
  const orgId = new mongoose.Types.ObjectId();
  const ws = await Workspace.create({
    workspaceNumber: wsCounter++,
    userId: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    name: `Tenant ${tag}`,
  });
  const tracker = await AiTracker.create({
    workspaceId: ws._id,
    domain: `${tag.toLowerCase()}-brand.com`,
    name: `Tenant ${tag} Monitor`,
    defaultModels: ['chatgpt'],
    scanStatus: 'ready',
  });
  const prompt = await AiTrackerPrompt.create({
    trackerId: tracker._id,
    prompt: `tenant ${tag} secret prompt`,
    models: ['chatgpt'],
    frequency: 'Weekly',
    active: true,
  });
  const competitor = await AiTrackerCompetitor.create({
    trackerId: tracker._id,
    name: `Tenant${tag}Rival`,
  });
  return { orgId, ws, tracker, prompt, competitor };
}

let A;
let B;
let leakFingerprints;

before(async () => {
  await db.connect();
  await db.clear();
  A = await seedTenant('A');
  B = await seedTenant('B');
  leakFingerprints = ['tenant A secret prompt', 'Tenant A Monitor', 'a-brand.com', 'TenantARival'];
}, { timeout: 300_000 });

after(async () => {
  await db.disconnect();
});

const probe = (name, fn) => it(name, { timeout: 30_000 }, fn);

describe('monitor-scoped probes: tenant B context × tenant A monitorId', () => {
  const run = async (handler, extra = {}) => {
    const res = makeRes();
    await aiTrackerController[handler]({
      workspace: B.ws,
      user: {},
      params: { workspaceNumber: String(B.ws.workspaceNumber), monitorId: A.tracker._id.toString(), ...(extra.params || {}) },
      query: extra.query || {},
      body: extra.body || {},
    }, res);
    return res;
  };

  probe('getMonitor: foreign monitorId', async () => {
    const res = await run('getMonitor');
    assert.equal(res.statusCode, 404);
    assertNoLeak(res, leakFingerprints);
  });

  probe('updateMonitor: foreign monitorId', async () => {
    const res = await run('updateMonitor', { body: { name: 'Hijacked' } });
    assert.equal(res.statusCode, 404);
    assert.equal((await AiTracker.findById(A.tracker._id).lean()).name, 'Tenant A Monitor', 'A monitor unrenamed');
  });

  probe('deleteMonitor: foreign monitorId', async () => {
    const res = await run('deleteMonitor');
    assert.equal(res.statusCode, 404);
    assert.equal(await AiTracker.countDocuments({ _id: A.tracker._id }), 1, 'A monitor NOT deleted');
    assert.equal(await AiTrackerPrompt.countDocuments({ trackerId: A.tracker._id }), 1, 'A prompts intact');
  });

  probe('getMonitorScanStatus: foreign monitorId', async () => {
    const res = await run('getMonitorScanStatus');
    assert.equal(res.statusCode, 404);
    assertNoLeak(res, leakFingerprints);
  });

  probe('triggerMonitorScan: foreign monitorId', async () => {
    const res = await run('triggerMonitorScan');
    assert.equal(res.statusCode, 404);
    assert.equal((await AiTracker.findById(A.tracker._id).lean()).scanStatus, 'ready', 'A tracker not flipped to pending');
  });

  probe('getScanDetails: foreign monitorId', async () => {
    const res = await run('getScanDetails', { query: { date: new Date().toISOString().slice(0, 10) } });
    assert.equal(res.statusCode, 404);
    assertNoLeak(res, leakFingerprints);
  });

  probe('addMonitorPrompt: foreign monitorId', async () => {
    const res = await run('addMonitorPrompt', { body: { prompt: 'injected prompt' } });
    assert.equal(res.statusCode, 404);
    assert.equal(await AiTrackerPrompt.countDocuments({ trackerId: A.tracker._id }), 1, 'nothing added to A');
  });

  probe('addMonitorCompetitor: foreign monitorId', async () => {
    const res = await run('addMonitorCompetitor', { body: { name: 'InjectedRival' } });
    assert.equal(res.statusCode, 404);
    assert.equal(await AiTrackerCompetitor.countDocuments({ trackerId: A.tracker._id }), 1);
  });

  probe('dismissMonitorSuggestedCompetitor: foreign monitorId', async () => {
    const res = await run('dismissMonitorSuggestedCompetitor', { body: { name: 'TenantARival' } });
    assert.equal(res.statusCode, 404);
  });
});

describe('child-id probes: own monitor context × foreign child ids', () => {
  const runOwn = async (handler, extra = {}) => {
    const res = makeRes();
    await aiTrackerController[handler]({
      workspace: B.ws,
      user: {},
      params: { workspaceNumber: String(B.ws.workspaceNumber), monitorId: B.tracker._id.toString(), ...(extra.params || {}) },
      query: extra.query || {},
      body: extra.body || {},
    }, res);
    return res;
  };

  probe('updateMonitorPrompt: foreign promptId under own monitor', async () => {
    const res = await runOwn('updateMonitorPrompt', { params: { promptId: A.prompt._id.toString() }, body: { frequency: 'Monthly' } });
    assert.equal(res.statusCode, 404);
    assert.equal((await AiTrackerPrompt.findById(A.prompt._id).lean()).frequency, 'Weekly', 'A prompt unmodified');
  });

  probe('removeMonitorPrompt: foreign promptId survives', async () => {
    const res = await runOwn('removeMonitorPrompt', { params: { promptId: A.prompt._id.toString() } });
    assert.equal(res.statusCode, 404);
    assert.equal(await AiTrackerPrompt.countDocuments({ _id: A.prompt._id }), 1);
  });

  probe('bulkDeleteMonitorPrompts: foreign promptIds survive', async () => {
    const res = await runOwn('bulkDeleteMonitorPrompts', { body: { ids: [A.prompt._id.toString()] } });
    assert.ok(res.statusCode === 200 || res.statusCode === 404, `got ${res.statusCode}`);
    assert.equal(await AiTrackerPrompt.countDocuments({ _id: A.prompt._id }), 1, 'A prompt survives scoped bulk delete');
  });

  probe('removeMonitorCompetitor: foreign competitorId survives', async () => {
    const res = await runOwn('removeMonitorCompetitor', { params: { competitorId: A.competitor._id.toString() } });
    assert.ok(res.statusCode === 404, `got ${res.statusCode}`);
    assert.equal(await AiTrackerCompetitor.countDocuments({ _id: A.competitor._id }), 1);
  });

  probe('refreshPrompt: own monitor + foreign promptId', async () => {
    const res = await runOwn('refreshPrompt', { params: { promptId: A.prompt._id.toString() } });
    assert.equal(res.statusCode, 404, 'cross-monitor promptId must 404 (controller :2621)');
    assert.equal((await AiTracker.findById(A.tracker._id).lean()).scanStatus, 'ready', 'no scan triggered on A');
  });
});

describe('legacy-route probes: tenant B workspace × foreign child ids', () => {
  const runLegacy = async (handler, extra = {}) => {
    const res = makeRes();
    await aiTrackerController[handler]({
      workspace: B.ws,
      user: {},
      params: { workspaceNumber: String(B.ws.workspaceNumber), ...(extra.params || {}) },
      query: extra.query || {},
      body: extra.body || {},
    }, res);
    return res;
  };

  probe('refreshPrompt legacy: foreign promptId', async () => {
    const res = await runLegacy('refreshPrompt', { params: { promptId: A.prompt._id.toString() } });
    assert.equal(res.statusCode, 404, 'workspace check must reject (controller :2617)');
  });

  probe('legacy updatePrompt: foreign promptId', async () => {
    const res = await runLegacy('updatePrompt', { params: { promptId: A.prompt._id.toString() }, body: { frequency: 'Monthly' } });
    assert.equal(res.statusCode, 404);
    assert.equal((await AiTrackerPrompt.findById(A.prompt._id).lean()).frequency, 'Weekly');
  });

  probe('legacy removePrompt: foreign promptId', async () => {
    const res = await runLegacy('removePrompt', { params: { promptId: A.prompt._id.toString() } });
    assert.equal(res.statusCode, 404);
    assert.equal(await AiTrackerPrompt.countDocuments({ _id: A.prompt._id }), 1);
  });

  probe('legacy bulk-delete: foreign promptIds survive', async () => {
    const res = await runLegacy('bulkDeletePrompts', { body: { ids: [A.prompt._id.toString()] } });
    assert.ok(res.statusCode === 200 || res.statusCode === 404, `got ${res.statusCode}`);
    assert.equal(await AiTrackerPrompt.countDocuments({ _id: A.prompt._id }), 1);
  });

  probe('legacy removeCompetitor: foreign competitorId', async () => {
    const res = await runLegacy('removeCompetitor', { params: { competitorId: A.competitor._id.toString() } });
    assert.ok(res.statusCode === 404, `got ${res.statusCode}`);
    assert.equal(await AiTrackerCompetitor.countDocuments({ _id: A.competitor._id }), 1);
  });

  probe('CONTROL: the same handlers DO work on own-tenant ids (probes are not passing for the wrong reason)', async () => {
    // Guards against the classic false-green: if every call 404'd for an
    // unrelated reason (bad args, wrong shape), the probes above would be
    // meaningless. B's own ids must succeed through the same code paths.
    const okRes = makeRes();
    await aiTrackerController.getMonitor({
      workspace: B.ws, user: {},
      params: { workspaceNumber: String(B.ws.workspaceNumber), monitorId: B.tracker._id.toString() },
      query: {}, body: {},
    }, okRes);
    assert.equal(okRes.statusCode, 200, 'own monitor must resolve');

    const okPrompt = makeRes();
    await aiTrackerController.updateMonitorPrompt({
      workspace: B.ws, user: {},
      params: {
        workspaceNumber: String(B.ws.workspaceNumber),
        monitorId: B.tracker._id.toString(),
        promptId: B.prompt._id.toString(),
      },
      query: {}, body: { frequency: 'Monthly' },
    }, okPrompt);
    assert.equal(okPrompt.statusCode, 200, 'own prompt must update');
    assert.equal((await AiTrackerPrompt.findById(B.prompt._id).lean()).frequency, 'Monthly');
    // restore
    await AiTrackerPrompt.updateOne({ _id: B.prompt._id }, { $set: { frequency: 'Weekly' } });
  });

  probe('trackContentKeyword: foreign contentNumber', async () => {
    const content = await Content.create({
      workspaceId: A.ws._id,
      userId: A.ws.userId,
      contentNumber: 424242,
      title: 'Tenant A secret article',
      targetKeywords: ['tenant a keyword'],
    });
    const res = await runLegacy('trackContentKeyword', { params: { contentNumber: String(content.contentNumber) } });
    assert.equal(res.statusCode, 404, 'Content.findByNumber must scope by workspace');
    assertNoLeak(res, ['Tenant A secret article', 'tenant a keyword']);
  });
});
